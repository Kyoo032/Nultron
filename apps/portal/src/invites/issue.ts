/**
 * The operator's side of an invite: `pnpm --filter @agentforge/portal invite`.
 *
 * The flow it starts (owner decision, 2026-10-01): a tester gives the team their e-mail address, the
 * operator invites that address, and the portal E-MAILS the invite code to it (`invites/deliver.ts`).
 * The tester's first sign-in is the address plus that code; after it, the address plus an e-mailed
 * six-digit code. Printing the code here is the fallback for an operator who has to hand it over
 * another way, and it is opt-in (`--print`) so the default leaves it nowhere but the tester's inbox.
 *
 * This file is the store half: it creates the member in the `invited` state (the status 0002 has
 * always had, with no flow to use it) and one `invites` row, and returns the raw code ONCE. Only its
 * sha256 is stored, so there is no second chance and no way to read it back -- the same rule as the
 * OAuth client secret and the manual OTP.
 *
 * Unlike `portal:otp` there is no environment switch and it is not refused in production: it is the
 * production path for the pilot, and an invite opens exactly one door -- the first sign-in of
 * exactly one address -- after which the tester still proves the mailbox with the e-mailed code. The
 * guards are the ones a credential handed to an operator needs: it cannot be used on an address that
 * is already a member (that address needs no invite), on a disabled member (an invite is not how
 * somebody is let back in), or on an address that already belongs to another tenant (two tenants
 * make the address ambiguous, and sign-in sends nothing for those).
 */
import { normaliseEmail, randomInviteCode } from "../crypto";
import type { Invite, Org, PortalOps, PortalStore, User, UserRole } from "../store/types";
import { EMAIL_SHAPE, MAX_INVITE_EMAIL_LENGTH } from "./args";

export interface IssueInviteInput {
  readonly tenantSlug: string;
  /** Omit when the tenant has exactly one org. */
  readonly orgSlug?: string | null;
  readonly email: string;
  /**
   * The role the member holds once the invite is redeemed. Defaults to `member`: nobody is made an
   * owner by omission. It reaches the host in the access token and the token response.
   */
  readonly role?: UserRole;
  /** Defaults to the seven days the schema defaults to. Negative is a test's expired invite. */
  readonly ttlMs?: number;
}

export type IssueInviteRefusal =
  | "invalid_email"
  | "unknown_tenant"
  | "unknown_org"
  | "choose_org"
  | "org_mismatch"
  | "already_member"
  | "user_disabled"
  | "other_tenant"
  /** Every tenant needs an owner: the first invite, and any that would leave none, must be one. */
  | "owner_required";

export interface IssuedInvite {
  readonly ok: true;
  /** Mailed, and printed only on request. It exists nowhere else. */
  readonly code: string;
  readonly inviteId: string;
  readonly email: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly expiresAt: string;
  /** False when the address was already an `invited` member and this is a replacement code. */
  readonly userCreated: boolean;
  /** True when an earlier invite for the address that had not been redeemed was retired by this one. */
  readonly replacedEarlier: boolean;
}

export type IssueInviteResult = IssuedInvite | { readonly ok: false; readonly reason: IssueInviteRefusal };

type Refusal = { readonly ok: false; readonly reason: IssueInviteRefusal };
const refuse = (reason: IssueInviteRefusal): Refusal => ({ ok: false, reason });

/** The named org, the tenant's only org, or the reason there is no single answer. */
function pickOrg(orgs: readonly Org[], asked: string | null): Org | Refusal {
  if (asked) {
    return orgs.find((candidate) => candidate.slug === asked) ?? refuse("unknown_org");
  }
  if (orgs.length === 0) {
    return refuse("unknown_org");
  }
  return orgs.length === 1 ? orgs[0] : refuse("choose_org");
}

/** What an address already is, here, decides whether it may be invited and into which org. */
function checkMember(existing: User | null, org: Org): Refusal | null {
  if (existing?.status === "active") {
    return refuse("already_member");
  }
  if (existing?.status === "disabled") {
    return refuse("user_disabled");
  }
  // An invited member already belongs to an org; an invite does not move them.
  return existing && existing.orgId !== org.id ? refuse("org_mismatch") : null;
}

export async function issueInvite(store: PortalStore, input: IssueInviteInput): Promise<IssueInviteResult> {
  const email = normaliseEmail(input.email);
  if (!EMAIL_SHAPE.test(email) || email.length > MAX_INVITE_EMAIL_LENGTH) {
    return refuse("invalid_email");
  }

  const tenantId = await store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return refuse("unknown_tenant");
  }
  // The resolver answers a tenant only when the address belongs to exactly ONE. A different one
  // means a second row here would make the address ambiguous, and an ambiguous address is sent
  // nothing, by design (`device-code-login.md`, GET /activate) -- the tester could never sign in.
  // (An address already in TWO other tenants also answers null, and cannot be told from an unknown
  // one here: that case is not caught.)
  const owner = await store.resolve.byEmail(email);
  if (owner && owner !== tenantId) {
    return refuse("other_tenant");
  }

  const code = randomInviteCode();
  const role = input.role ?? "member";
  const asked = input.orgSlug?.trim().toLowerCase() || null;
  return store.tx(tenantId, async (ops) => {
    const tenant = await ops.tenants.findById(tenantId);
    if (!tenant) {
      return refuse("unknown_tenant");
    }
    const org = pickOrg(await ops.orgs.listForTenant(tenantId), asked);
    if ("ok" in org) {
      return org;
    }
    const existing = await ops.users.findByEmail(tenantId, email);
    const refused = checkMember(existing, org);
    if (refused) {
      return refused;
    }

    // Whatever this does, the tenant is left with at least one owner who is not disabled. That is
    // what makes the first invite for a tenant an owner's, and what stops a re-invite from quietly
    // demoting the only one. (An address that is already active is refused above, and a role change
    // for one of those is `invites/role.ts`'s, which keeps the same rule.)
    const owners = (await ops.users.lockOwners(tenantId)) - (existing?.role === "owner" ? 1 : 0);
    if (owners + (role === "owner" ? 1 : 0) < 1) {
      return refuse("owner_required");
    }

    const created = existing ?? (await createInvitedMember(ops, tenantId, org, email, role));
    // An invited member re-invited under another role takes it now, so the row and the invite agree.
    const user = created.role === role ? created : ((await ops.users.setRole(created.id, role)) ?? created);
    const previous = await ops.invites.latestForEmail(tenantId, email);
    const invite = await ops.invites.create({
      tenantId,
      orgId: org.id,
      userId: user.id,
      email,
      rawCode: code,
      role,
      ttlMs: input.ttlMs,
    });
    const replacedEarlier = previous !== null && previous.redeemedAt === null;
    await auditIssued(ops, { tenantId, org, user, invite, userCreated: existing === null, replacedEarlier });

    return {
      ok: true as const,
      code,
      inviteId: invite.id,
      email,
      tenantId,
      tenantSlug: tenant.slug,
      orgId: org.id,
      orgSlug: org.slug,
      userId: user.id,
      role,
      expiresAt: invite.expiresAt,
      userCreated: existing === null,
      replacedEarlier,
    };
  });
}

function createInvitedMember(
  ops: PortalOps,
  tenantId: string,
  org: Org,
  email: string,
  role: UserRole,
): Promise<User> {
  return ops.users.create({ tenantId, orgId: org.id, email, status: "invited", role });
}

/** The record that an invite was issued, never the code and not the address twice over. */
function auditIssued(
  ops: PortalOps,
  input: {
    readonly tenantId: string;
    readonly org: Org;
    readonly user: User;
    readonly invite: Invite;
    readonly userCreated: boolean;
    readonly replacedEarlier: boolean;
  },
): Promise<unknown> {
  return ops.audit.append({
    tenantId: input.tenantId,
    orgId: input.org.id,
    actorKind: "support",
    action: "invite.issued",
    targetKind: "invite",
    targetId: input.invite.id,
    after: {
      user_id: input.user.id,
      role: input.invite.role,
      org_slug: input.org.slug,
      expires_at: input.invite.expiresAt,
      user_created: input.userCreated,
      replaced_earlier: input.replacedEarlier,
    },
  });
}

export interface InviteReportOptions {
  /** Whether the invite e-mail went. A failed one is the CLI's exit code, not a report. */
  readonly mailed: boolean;
  /** `--print`: show the code, for an operator who has to hand it over another way. */
  readonly printCode: boolean;
}

/** What the CLI prints on success. Kept here so the show-once rule is testable. */
export function formatInviteReport(result: IssuedInvite, options: InviteReportOptions): string {
  const days = Math.max(0, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 86_400_000));
  const lines = [
    `address    ${result.email}`,
    `tenant     ${result.tenantSlug}   org ${result.orgSlug}   role ${result.role}`,
    `expires    ${result.expiresAt}   (${days} days)`,
    `member     ${result.userCreated ? "created, status invited" : "already invited"} -- active once the invite is redeemed`,
    ...(result.replacedEarlier ? ["replaced   the earlier invite for this address, which no longer works"] : []),
    options.mailed ? "e-mail     the invite was e-mailed to that address" : "e-mail     NOT sent",
    "",
  ];

  if (options.printCode) {
    lines.push(
      `invite     ${result.code}`,
      "",
      "Only its sha256 is stored, so this is the only time the code can be displayed.",
      "Hand it over once. It works for this address only, once, until it expires, and five wrong",
      "guesses lock it. Issuing another invite for the address replaces it.",
      "",
    );
  } else {
    lines.push(
      "The code was not printed: it exists only in that e-mail. If the tester cannot find it they can",
      "ask the sign-in page to e-mail it again, or re-run this command with --print to read a new one",
      "out yourself (either way the earlier code stops working).",
      "",
    );
  }
  lines.push(
    "The tester signs in with the address and the invite code; the portal then e-mails a six-digit",
    "code to confirm the inbox. Every later sign-in needs only that e-mailed code.",
    "",
  );
  return lines.join("\n");
}
