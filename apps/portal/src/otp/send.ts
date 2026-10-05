/**
 * Minting a sign-in code and mailing it, for a member who is already known to be allowed one.
 *
 * Who is allowed one is decided above this, in `flows/sign-in.ts`: an active member, or an invited
 * member who has just redeemed their invite. This is only the mint-and-mail half, and it keeps the
 * three limits and two habits the old all-in-one send had:
 *
 *   - **3 sends per 15 minutes per address**, counted from the `login_otps` rows by
 *     `store.loginOtps.send` (`schema.md`), so there is one definition of it.
 *   - **A cooldown on an explicit "send me a new code"**: when the caller passes `cooldownMs`, a
 *     code minted for this address inside that window is a refusal rather than a second e-mail.
 *   - **A repeat of one request is not a new request** (M2, 2026-10-01): a double click, a reload of
 *     the posted page or a second tab re-posts the form, and each post used to mint a code, mail
 *     it and spend one of the three sends -- while only the newest code works, so the person who
 *     typed the first e-mail's code burned a guess. A send inside `OTP_DUPLICATE_WINDOW_MS` of a code
 *     that is still live is answered by that code: nothing minted, nothing mailed, no budget spent.
 *     (A newer code retires every older one, `store.loginOtps.send`, so at most one code is live.)
 *   - **A delivery failure is reported, not hidden.** `MailDeliveryError` is caught, audited without
 *     the code, and returned as `delivery_failed`, so the page can say the e-mail did not go. (The
 *     page used to be the same neutral one whatever happened; since the owner's 2026-10-01 decision
 *     the sign-in tells the person which situation they are in, SR-30.)
 *
 * The raw six digits exist here and in the e-mail, and nowhere else: the store keeps sha256, the
 * log sink drops the field name, and no audit row carries it.
 */
import { randomOtpCode } from "../crypto";
import type { Logger } from "../log";
import { MailDeliveryError, type Mailer } from "../mail/types";
import { otpMessage } from "../mail/templates";
import { tenantProductName } from "./product-name";
import type { Clock, OtpPurpose, PortalStore, User } from "../store/types";
import type { PortalLocale } from "../views/i18n";

/** `login_otps.expires_at` defaults to `created_at + 10 minutes` (`0002_core_tables.sql`). */
export const OTP_TTL_MINUTES = 10;
/** A lock is for up to a day; this is the answer if the store ever reports one without a time. */
const DAY_SECONDS = 24 * 60 * 60;
/** Between an explicit "send me a new code" and the code before it. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/**
 * A request for a code that arrives this soon after a still-live one is a repeat of that request
 * (a double click, a reload, a re-post), not a wish for another code. Short on purpose: long enough
 * for a person to click twice or a slow page to be reloaded, far shorter than the time they need to
 * read the mail, so someone who really does go back and ask again is sent a fresh code.
 */
export const OTP_DUPLICATE_WINDOW_MS = 15 * 1000;

export interface OtpDeps {
  readonly store: PortalStore;
  readonly mailer: Mailer;
  readonly log: Logger;
  readonly clock: Clock;
  /** Injected by the tests so the floor does not make the suite slow. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minimumDurationMs?: number;
}

export interface DeliverOtpInput {
  readonly tenantId: string;
  /** Already resolved, in this tenant, by the caller. */
  readonly member: User;
  readonly purpose: OtpPurpose;
  readonly locale?: PortalLocale;
  readonly ip?: string | null;
  /** Set for an explicit resend: a code minted inside this window is a refusal. */
  readonly cooldownMs?: number;
  /** Overrides the name in the subject line; unset, the tenant's own name is read from the store. */
  readonly productName?: string;
}

export type DeliverOtpResult =
  /** A code was minted, stored as sha256 and handed to the transport. */
  | { readonly kind: "sent" }
  /** An explicit resend inside the cooldown. Nothing was minted. */
  | { readonly kind: "cooldown"; readonly retryAfter: number }
  /**
   * A repeat of the request that minted the live code, inside `OTP_DUPLICATE_WINDOW_MS`. Nothing
   * was minted or mailed and no send was spent: the code that went a moment ago is the answer.
   */
  | { readonly kind: "already_sent" }
  /** Three sends already inside the fifteen-minute window. Nothing was minted. */
  | { readonly kind: "rate_limited"; readonly retryAfter: number }
  /**
   * The address has spent its daily guess budget. Nothing was minted: no code could be used.
   * `retryAfter` is the seconds until enough of the day's guesses age out to lift it.
   */
  | { readonly kind: "locked"; readonly retryAfter: number }
  /** The row was written; SMTP refused it. Audited. */
  | { readonly kind: "delivery_failed" };

export async function deliverLoginOtp(
  deps: OtpDeps,
  input: DeliverOtpInput,
): Promise<DeliverOtpResult> {
  const { tenantId, member } = input;
  const email = member.email;
  const code = randomOtpCode();

  const prepared = await deps.store.tx(tenantId, async (ops) => {
    // Before anything is minted: a code for an address whose twenty guesses are spent could not be
    // used (`store.loginOtps.verify` refuses even the right one), so sending it would only lie.
    const status = await ops.loginOtps.status({ tenantId, email, purpose: input.purpose });
    if (status.locked) {
      await ops.audit.append({
        tenantId,
        orgId: member.orgId,
        actorKind: "system",
        action: "otp.withheld",
        targetKind: "user",
        targetId: member.id,
        reasonCode: "otp_locked",
        ip: input.ip ?? null,
      });
      return {
        ok: false as const,
        result: { kind: "locked" as const, retryAfter: status.retryAfter ?? DAY_SECONDS },
      };
    }
    if (input.cooldownMs !== undefined && status.newestSentAt !== null) {
      const waitMs = new Date(status.newestSentAt).getTime() + input.cooldownMs - deps.clock.now().getTime();
      if (waitMs > 0) {
        return { ok: false as const, result: { kind: "cooldown" as const, retryAfter: Math.ceil(waitMs / 1000) } };
      }
    }

    const sent = await ops.loginOtps.send({
      tenantId,
      email,
      code,
      purpose: input.purpose,
      createdIp: input.ip ?? null,
      dedupeWithinMs: OTP_DUPLICATE_WINDOW_MS,
    });
    if (!sent.ok && sent.reason === "duplicate") {
      // Not audited: it changed nothing, and a row per repeat would be a way to grow an
      // append-only table (the e-mail step's own limits bound how fast, not whether).
      return { ok: false as const, result: { kind: "already_sent" as const } };
    }
    if (!sent.ok) {
      await ops.audit.append({
        tenantId,
        orgId: member.orgId,
        actorKind: "system",
        action: "otp.send_rate_limited",
        targetKind: "login_otp",
        reasonCode: "rate_limited",
        ip: input.ip ?? null,
      });
      return { ok: false as const, result: { kind: "rate_limited" as const, retryAfter: sent.retryAfter } };
    }
    // Read in the transaction that is already open rather than in one of its own: this is the
    // name the subject line prints, and it must not cost the send a second round trip.
    const tenant = await ops.tenants.findById(tenantId);
    const config = await ops.tenantConfig.get(tenantId);
    return {
      ok: true as const,
      otpId: sent.otp.id,
      productName: tenantProductName(tenant, config?.branding),
    };
  });

  if (!prepared.ok) {
    return prepared.result;
  }

  try {
    await deps.mailer.send(
      otpMessage({
        to: email,
        code,
        expiresInMinutes: OTP_TTL_MINUTES,
        locale: input.locale === "id" ? "id" : "en",
        productName: input.productName ?? prepared.productName ?? undefined,
      }),
    );
  } catch (error) {
    // The row stays. The user can ask for another code, and the operator sees why this one never
    // arrived.
    deps.log.warn("otp_delivery_failed", {
      tenantId,
      reason: error instanceof MailDeliveryError ? error.message : "unknown",
    });
    await deps.store.tx(tenantId, async (ops) => {
      // A code nobody received is not a live code: it must not answer the next post as "a code was
      // sent a moment ago", or the person would be told that and never be sent one.
      await ops.loginOtps.retire(prepared.otpId);
      await ops.audit.append({
        tenantId,
        orgId: member.orgId,
        actorKind: "system",
        action: "otp.send_failed",
        targetKind: "login_otp",
        targetId: prepared.otpId,
        ip: input.ip ?? null,
      });
    });
    return { kind: "delivery_failed" };
  }

  await deps.store.tx(tenantId, (ops) =>
    ops.audit.append({
      tenantId,
      orgId: member.orgId,
      actorKind: "system",
      action: "otp.sent",
      targetKind: "login_otp",
      targetId: prepared.otpId,
      after: { purpose: input.purpose },
      ip: input.ip ?? null,
    }),
  );
  return { kind: "sent" };
}
