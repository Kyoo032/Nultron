/**
 * The browser sign-in as a state machine: e-mail first, then the portal decides the next step.
 *
 * Owner decision (2026-10-01): nobody signs up. A first sign-in needs an invite an operator issued
 * for that address and e-mailed to it; every later one needs only the e-mailed six-digit code. And
 * the page says which situation the person is in, instead of one neutral page for all of them:
 *
 *   code_sent        an activated member: "we sent a code to <address>" (also after a valid invite)
 *   invite_required  invited, not yet activated: "enter the invite code we e-mailed you"; no code sent
 *   invite_unusable  the invite expired, was used or is gone: "ask your admin"; nothing sent
 *   no_access        not invited, not a member, disabled, or removed: "ask your admin to invite you"
 *   seat_cap_reached the org has no seat for this person: "no seats left", told BEFORE an invite is
 *                    redeemed or a code is sent, so nothing is spent on a sign-in that cannot finish
 *   otp_locked /     the per-address limits (20 wrong sign-in codes a day, 5 wrong invite codes; the
 *   invite_locked    fifth wrong invite code is itself the lock, not a "0 attempts left" form)
 *   invite_wrong     a wrong invite code, with the attempts left
 *
 * **This deliberately changes SR-30.** The enumeration defence used to be one neutral page and a
 * timing floor, so nobody could tell a member from a stranger. Now the first two answers and the
 * fourth differ on purpose, which makes the e-mail step an oracle for "is this address a member, an
 * invitee or neither" -- the owner asked for exactly that. What stands in for the neutral page is
 * rate limits on the e-mail step per IP and per address (`security/rate-limit.ts`), so a sweep of
 * addresses is not cheap; the timing floor stays, for the same reason. Nothing else is revealed: no
 * tenant, no org, no role, no list of members.
 *
 * The invite itself opens only the first door. Redeeming it activates the member and then a
 * six-digit code is e-mailed, because the person has to prove they own the inbox: the invite code
 * alone is never a session.
 *
 * Decisions only. Pages, status codes and rate-limit budgets are the route's (`routes/sign-in-flow.ts`).
 */
import { normaliseEmail, randomInviteCode } from "../crypto";
import { mailInvite } from "../invites/deliver";
import { MAX_FAILED_INVITE_ATTEMPTS } from "../store/postgres/invites";
import { deliverLoginOtp, OTP_RESEND_COOLDOWN_MS, type OtpDeps } from "../otp/send";
import type { Invite, OtpPurpose, PortalOps, User } from "../store/types";
import type { PortalLocale } from "../views/i18n";

const DEFAULT_MINIMUM_DURATION_MS = 150;

/** Between "e-mail me my invite again" and the invite before it. */
export const INVITE_RESEND_COOLDOWN_MS = 60 * 1000;
/** At most this many invites for one address inside the window, however they were issued. */
export const INVITE_RESEND_MAX_PER_WINDOW = 4;
export const INVITE_RESEND_WINDOW_MS = 60 * 60 * 1000;

export type SignInDeps = OtpDeps;

export interface SignInInput {
  readonly email: string;
  /** The OAuth client's tenant on `/authorize`, the pending device code's on `/activate`. */
  readonly requiredTenantId?: string | null;
  readonly purpose: OtpPurpose;
  readonly locale?: PortalLocale;
  readonly ip?: string | null;
}

export type InviteNotice =
  | { readonly kind: "resent" }
  | { readonly kind: "wait"; readonly retryAfter: number }
  | { readonly kind: "mail_failed" };

export type SignInState =
  /** A code was e-mailed. `afterInvite`: the invite was just redeemed and this confirms the inbox. */
  | { readonly kind: "code_sent"; readonly afterInvite: boolean }
  /** No code was sent: one went a moment ago (`cooldown`) or three did lately (`rate_limited`). */
  | {
      readonly kind: "code_wait";
      readonly why: "cooldown" | "rate_limited";
      readonly retryAfter: number;
      readonly afterInvite: boolean;
    }
  /** The mail transport refused the message. */
  | { readonly kind: "code_mail_failed"; readonly afterInvite: boolean }
  /** Invited, not activated, with an invite that can still be redeemed. Nothing was sent. */
  | { readonly kind: "invite_required"; readonly attemptsRemaining: number; readonly notice: InviteNotice | null }
  /** A wrong invite code, counted. */
  | { readonly kind: "invite_wrong"; readonly attemptsRemaining: number }
  /** Expired, already used, replaced away or never issued. Ask the admin. */
  | { readonly kind: "invite_unusable" }
  /** Five wrong invite codes. Ask the admin. */
  | { readonly kind: "invite_locked" }
  /** Twenty wrong sign-in codes in a day; `retryAfter` is the seconds until the address can try again. */
  | { readonly kind: "otp_locked"; readonly retryAfter: number }
  /** Not invited, not a member, disabled, removed, or in another tenant. */
  | { readonly kind: "no_access" }
  /**
   * The org is at its seat cap and this person would need a new one. Nothing was spent: the invite
   * is unredeemed, no wrong guess was counted and no code was sent. The exchange still checks
   * (`login_precheck`), because a seat can go between this page and that one.
   */
  | { readonly kind: "seat_cap_reached" };

const NO_ACCESS: SignInState = Object.freeze({ kind: "no_access" });
const SEAT_CAP_REACHED: SignInState = Object.freeze({ kind: "seat_cap_reached" });

interface Found {
  readonly tenantId: string;
  readonly email: string;
}

/**
 * A floor, not a constant-time implementation -- which is the honest claim (SR-30). It keeps a
 * lookup that finds nothing from being much faster than one that sends mail, which would make a
 * sweep cheaper than the rate limits intend.
 */
async function withFloor<T>(deps: SignInDeps, work: () => Promise<T>): Promise<T> {
  const startedAt = deps.clock.now().getTime();
  const floor = deps.minimumDurationMs ?? DEFAULT_MINIMUM_DURATION_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const result = await work();

  const elapsed = deps.clock.now().getTime() - startedAt;
  if (elapsed < floor) {
    await sleep(floor - elapsed);
  }
  return result;
}

/**
 * The address's tenant, or null. Null for an unknown address, one in more than one tenant and one
 * in a tenant other than the caller's: all of them are `no_access`, because none of them has been
 * invited to THIS sign-in.
 */
async function findTenant(deps: SignInDeps, input: SignInInput): Promise<Found | null> {
  const email = normaliseEmail(input.email);
  const tenantId = await deps.store.resolve.byEmail(email);
  if (!tenantId || (input.requiredTenantId && input.requiredTenantId !== tenantId)) {
    return null;
  }
  return { tenantId, email };
}

type InviteInspection =
  | { readonly kind: "live"; readonly invite: Invite; readonly attemptsRemaining: number }
  | { readonly kind: "unusable" }
  | { readonly kind: "locked" };

function inspectInvite(invite: Invite | null, now: Date): InviteInspection {
  if (!invite || invite.redeemedAt !== null || new Date(invite.expiresAt) <= now) {
    return { kind: "unusable" };
  }
  if (invite.failedAttempts >= MAX_FAILED_INVITE_ATTEMPTS) {
    return { kind: "locked" };
  }
  return { kind: "live", invite, attemptsRemaining: MAX_FAILED_INVITE_ATTEMPTS - invite.failedAttempts };
}

function withheld(ops: PortalOps, found: Found, member: User, reasonCode: string, ip: string | null) {
  return ops.audit.append({
    tenantId: found.tenantId,
    orgId: member.orgId,
    actorKind: "system",
    action: "otp.withheld",
    targetKind: "user",
    targetId: member.id,
    reasonCode,
    ip,
  });
}

function stateAfterDelivery(
  result: Awaited<ReturnType<typeof deliverLoginOtp>>,
  afterInvite: boolean,
): SignInState {
  switch (result.kind) {
    case "sent":
      return { kind: "code_sent", afterInvite };
    case "already_sent":
      // A repeat of the post that sent it: the code page again, saying the true thing.
      return { kind: "code_sent", afterInvite };
    case "cooldown":
      return { kind: "code_wait", why: "cooldown", retryAfter: result.retryAfter, afterInvite };
    case "rate_limited":
      return { kind: "code_wait", why: "rate_limited", retryAfter: result.retryAfter, afterInvite };
    case "locked":
      return { kind: "otp_locked", retryAfter: result.retryAfter };
    case "delivery_failed":
      return { kind: "code_mail_failed", afterInvite };
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/**
 * Step one: an address, and nothing else. `resend` is the explicit "send me a new code" button,
 * which is the only thing the cooldown applies to.
 */
export async function beginSignIn(
  deps: SignInDeps,
  input: SignInInput & { readonly resend?: boolean },
): Promise<SignInState> {
  return withFloor(deps, async () => {
    const found = await findTenant(deps, input);
    if (!found) {
      return NO_ACCESS;
    }
    const ip = input.ip ?? null;

    const member = await deps.store.tx(found.tenantId, (ops) => ops.users.findByEmail(found.tenantId, found.email));
    if (!member) {
      return NO_ACCESS;
    }

    if (member.status === "disabled") {
      await deps.store.tx(found.tenantId, (ops) => withheld(ops, found, member, "user_disabled", ip));
      return NO_ACCESS;
    }

    if (member.status === "invited") {
      return deps.store.tx(found.tenantId, async (ops): Promise<SignInState> => {
        const inspection = inspectInvite(
          await ops.invites.latestForEmail(found.tenantId, found.email),
          deps.clock.now(),
        );
        // A dead invite is its own dead end whatever the seats are; only a live one is worth a
        // seat check, because only a live one goes on to be typed.
        if (inspection.kind === "live" && !(await ops.orgs.hasSeatFor(member.orgId, member.id))) {
          await withheld(ops, found, member, "seat_cap_reached", ip);
          return SEAT_CAP_REACHED;
        }
        await withheld(
          ops,
          found,
          member,
          inspection.kind === "live" ? "invite_required" : inspection.kind === "locked" ? "invite_locked" : "invite_unusable",
          ip,
        );
        if (inspection.kind === "live") {
          return { kind: "invite_required", attemptsRemaining: inspection.attemptsRemaining, notice: null };
        }
        return inspection.kind === "locked" ? { kind: "invite_locked" } : { kind: "invite_unusable" };
      });
    }

    // An active member: a code is only worth sending to somebody the exchange will let in.
    const seatFree = await deps.store.tx(found.tenantId, async (ops) => {
      const free = await ops.orgs.hasSeatFor(member.orgId, member.id);
      if (!free) {
        await withheld(ops, found, member, "seat_cap_reached", ip);
      }
      return free;
    });
    if (!seatFree) {
      return SEAT_CAP_REACHED;
    }

    const result = await deliverLoginOtp(deps, {
      tenantId: found.tenantId,
      member,
      purpose: input.purpose,
      locale: input.locale,
      ip,
      cooldownMs: input.resend ? OTP_RESEND_COOLDOWN_MS : undefined,
    });
    return stateAfterDelivery(result, false);
  });
}

/**
 * Step two for an invitee: the address and the invite code they were e-mailed. A valid one
 * activates the member and goes straight to the e-mailed code; a wrong one is counted, here and
 * (per IP) by the route; a spent one says so.
 */
export async function submitInvite(
  deps: SignInDeps,
  input: SignInInput & { readonly inviteCode: string },
): Promise<SignInState> {
  return withFloor(deps, async () => {
    const found = await findTenant(deps, input);
    if (!found) {
      return NO_ACCESS;
    }
    const ip = input.ip ?? null;

    // One transaction for the redemption and its audit row, returned rather than thrown: a wrong
    // guess has to commit its count, or five of them cost nothing.
    const outcome = await deps.store.tx(found.tenantId, async (ops) => {
      const member = await ops.users.findByEmail(found.tenantId, found.email);
      if (!member || member.status === "disabled") {
        return { kind: "state" as const, state: NO_ACCESS };
      }
      // Before the invite is touched: no redemption, no wrong-guess count (a guess at a full org
      // cannot be told right or wrong, so it costs nothing), and no code is sent to somebody the
      // exchange would turn away. This runs for an active member too: the code that follows is
      // for the exchange as well.
      if (!(await ops.orgs.hasSeatFor(member.orgId, member.id))) {
        await ops.audit.append({
          tenantId: found.tenantId,
          orgId: member.orgId,
          actorKind: "system",
          action: "invite.refused",
          targetKind: "user",
          targetId: member.id,
          reasonCode: "seat_cap_reached",
          ip,
        });
        return { kind: "state" as const, state: SEAT_CAP_REACHED };
      }
      if (member.status === "active") {
        // Redeemed already (a double submit, a second tab): nothing to redeem, carry on to the code.
        return { kind: "deliver" as const, member, afterInvite: false };
      }

      const redeemed = await ops.invites.redeem({
        tenantId: found.tenantId,
        email: found.email,
        rawCode: input.inviteCode,
      });
      if (!redeemed.ok && redeemed.reason === "already_used") {
        // Spent a moment ago by the other half of a double click: the member is active now, and
        // what they need is the e-mailed code, not a page that says their invite is gone.
        const current = await ops.users.findByEmail(found.tenantId, found.email);
        if (current?.status === "active") {
          return { kind: "deliver" as const, member: current, afterInvite: false };
        }
      }
      if (!redeemed.ok) {
        // A locked invite was audited when the fifth wrong code locked it. Writing a row for every
        // refusal after that would hand anyone who knows the address a way to grow an append-only
        // table, from as many addresses as they have.
        if (redeemed.reason !== "locked") {
          await ops.audit.append({
            tenantId: found.tenantId,
            orgId: member.orgId,
            actorKind: "system",
            action: "invite.refused",
            targetKind: "user",
            targetId: member.id,
            reasonCode: redeemed.reason,
            ip,
          });
        }
        // The fifth wrong code IS the lock: showing "0 attempts left" with the form still there
        // invites a sixth that can only be refused. It was audited above as the wrong code it was.
        const state: SignInState =
          redeemed.reason === "wrong_code" && redeemed.attemptsRemaining > 0
            ? { kind: "invite_wrong", attemptsRemaining: redeemed.attemptsRemaining }
            : redeemed.reason === "wrong_code" || redeemed.reason === "locked"
              ? { kind: "invite_locked" }
              : redeemed.reason === "not_invitable"
                ? NO_ACCESS
                : { kind: "invite_unusable" };
        return { kind: "state" as const, state };
      }
      await ops.audit.append({
        tenantId: found.tenantId,
        orgId: member.orgId,
        actorKind: "user",
        actorUserId: member.id,
        action: "invite.redeemed",
        targetKind: "invite",
        targetId: redeemed.invite.id,
        ip,
      });
      return { kind: "deliver" as const, member: redeemed.user, afterInvite: true };
    });

    if (outcome.kind === "state") {
      return outcome.state;
    }
    const result = await deliverLoginOtp(deps, {
      tenantId: found.tenantId,
      member: outcome.member,
      purpose: input.purpose,
      locale: input.locale,
      ip,
    });
    return stateAfterDelivery(result, outcome.afterInvite);
  });
}

/**
 * "E-mail me my invite again". The code is stored as a hash and cannot be re-sent, so this issues a
 * new one for the same address -- which retires the earlier one -- and mails that. It never extends
 * the invite's life (the new code expires when the old one would have), it is refused for an invite
 * that is spent, expired or locked (that is the admin's call), and it is limited per address: a
 * minute between mails and four invites an hour, operator-issued ones included.
 */
export async function resendInvite(
  deps: SignInDeps,
  input: SignInInput,
): Promise<SignInState> {
  return withFloor(deps, async () => {
    const found = await findTenant(deps, input);
    if (!found) {
      return NO_ACCESS;
    }
    const ip = input.ip ?? null;
    const now = deps.clock.now();

    const prepared = await deps.store.tx(found.tenantId, async (ops) => {
      const member = await ops.users.findByEmail(found.tenantId, found.email);
      if (!member || member.status === "disabled") {
        return { kind: "state" as const, state: NO_ACCESS };
      }
      if (member.status === "active") {
        return { kind: "active" as const };
      }

      const inspection = inspectInvite(await ops.invites.latestForEmail(found.tenantId, found.email), now);
      if (inspection.kind !== "live") {
        return {
          kind: "state" as const,
          state: inspection.kind === "locked" ? ({ kind: "invite_locked" } as const) : ({ kind: "invite_unusable" } as const),
        };
      }

      const history = await ops.invites.issuedSince(
        found.tenantId,
        found.email,
        new Date(now.getTime() - INVITE_RESEND_WINDOW_MS).toISOString(),
      );
      const sinceNewest = history.newestAt === null ? Infinity : now.getTime() - new Date(history.newestAt).getTime();
      const blocked =
        sinceNewest < INVITE_RESEND_COOLDOWN_MS
          ? INVITE_RESEND_COOLDOWN_MS - sinceNewest
          : history.count >= INVITE_RESEND_MAX_PER_WINDOW && history.oldestAt !== null
            ? new Date(history.oldestAt).getTime() + INVITE_RESEND_WINDOW_MS - now.getTime()
            : 0;
      if (blocked > 0) {
        return {
          kind: "state" as const,
          state: {
            kind: "invite_required" as const,
            attemptsRemaining: inspection.attemptsRemaining,
            notice: { kind: "wait" as const, retryAfter: Math.max(1, Math.ceil(blocked / 1000)) },
          },
        };
      }

      const code = randomInviteCode();
      const created = await ops.invites.create({
        tenantId: found.tenantId,
        orgId: member.orgId,
        userId: member.id,
        email: found.email,
        rawCode: code,
        // The role is the operator's decision, and asking again does not revisit it.
        role: inspection.invite.role,
        // The same expiry as the invite it replaces: asking again never makes an invite last longer.
        ttlMs: new Date(inspection.invite.expiresAt).getTime() - now.getTime(),
      });
      return { kind: "created" as const, code, created, member };
    });

    if (prepared.kind === "state") {
      return prepared.state;
    }
    if (prepared.kind === "active") {
      // Redeemed meanwhile: there is no invite to send, and the code step is the next one.
      return continueAsMember(deps, found, input);
    }

    const mailed = await mailInvite(deps, {
      tenantId: found.tenantId,
      orgId: prepared.member.orgId,
      inviteId: prepared.created.id,
      code: prepared.code,
      email: found.email,
      expiresAt: prepared.created.expiresAt,
      locale: input.locale,
      ip,
      action: "invite.resent",
    });
    return {
      kind: "invite_required",
      attemptsRemaining: MAX_FAILED_INVITE_ATTEMPTS,
      notice: mailed === "sent" ? { kind: "resent" } : { kind: "mail_failed" },
    };
  });
}

/** An invitee who was activated between the page and the button: carry on as a member. */
function continueAsMember(deps: SignInDeps, found: Found, input: SignInInput): Promise<SignInState> {
  return beginSignIn(
    { ...deps, minimumDurationMs: 0 },
    { email: found.email, requiredTenantId: input.requiredTenantId, purpose: input.purpose, locale: input.locale, ip: input.ip },
  );
}
