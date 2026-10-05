/**
 * Mailing an invite: the operator's `portal:invite` and the tester's own "e-mail me my invite
 * again" both end here.
 *
 * Only the sha256 of an invite code is stored, so a code cannot be re-sent: a re-send is a
 * re-issue, and the caller hands this the NEW raw code. It exists in the mail and nowhere else, as
 * for every other credential in this service. The audit row says the mail went (or did not) and
 * never carries it, and a delivery failure is logged by recipient domain, never by address.
 */
import type { Logger } from "../log";
import { MailDeliveryError, inviteMessage, type MailLocale, type Mailer } from "../mail";
import { tenantProductName } from "../otp/product-name";
import type { PortalStore } from "../store/types";

export interface MailInviteDeps {
  readonly store: PortalStore;
  readonly mailer: Mailer;
  readonly log: Logger;
}

export interface MailInviteInput {
  readonly tenantId: string;
  readonly orgId: string;
  readonly inviteId: string;
  /** The raw code, from `issueInvite` or `randomInviteCode`. Mailed, then forgotten. */
  readonly code: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly locale?: MailLocale;
  readonly ip?: string | null;
  /** `invite.mailed` for the operator's issue, `invite.resent` for the tester's own request. */
  readonly action: "invite.mailed" | "invite.resent";
}

export type MailInviteResult = "sent" | "failed";

export async function mailInvite(deps: MailInviteDeps, input: MailInviteInput): Promise<MailInviteResult> {
  const { tenantId } = input;
  // The name the subject prints is the one the pages print (`otp/product-name.ts`).
  const productName = await deps.store.tx(tenantId, async (ops) => {
    // One after the other: a transaction's client runs one query at a time, and pg deprecates
    // queueing a second behind the first.
    const tenant = await ops.tenants.findById(tenantId);
    const config = await ops.tenantConfig.get(tenantId);
    return tenantProductName(tenant, config?.branding);
  });

  const audit = (action: string) =>
    deps.store.tx(tenantId, (ops) =>
      ops.audit.append({
        tenantId,
        orgId: input.orgId,
        actorKind: input.action === "invite.mailed" ? "support" : "system",
        action,
        targetKind: "invite",
        targetId: input.inviteId,
        ip: input.ip ?? null,
      }),
    );

  try {
    await deps.mailer.send(
      inviteMessage({
        to: input.email,
        code: input.code,
        expiresAt: input.expiresAt,
        locale: input.locale === "id" ? "id" : "en",
        productName: productName ?? undefined,
      }),
    );
  } catch (error) {
    deps.log.warn("invite_delivery_failed", {
      tenantId,
      reason: error instanceof MailDeliveryError ? error.message : "unknown",
    });
    await audit("invite.send_failed");
    return "failed";
  }
  await audit(input.action);
  return "sent";
}
