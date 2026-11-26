/**
 * The operator's side of a password account: `pnpm --filter @agentforge/portal account`.
 *
 * There is no self-sign-up and no self-service reset (owner decision, 2026-10-07: "username and
 * password protection for now"), so these five commands are the whole life of an account: create it,
 * reset its password, disable it, enable it, list them. They write through the same role the server
 * uses, so what they write is exactly what the server's tenant policies let it, and every one of them
 * leaves an audit row naming the operator action (`actorKind: "support"`, as the invite command does)
 * and never a password, a hash or an address that was not already on the person's row.
 *
 * Passwords: `create` and `reset-password` generate one (`password/generate.ts`), store its scrypt
 * hash with `must_change`, and return the plain value ONCE to the caller to print. It exists nowhere
 * else. Both end with the person unable to get a session until they have chosen a password of their
 * own at the sign-in page.
 *
 * Rules that hold for every command, and each is a refusal a test drives:
 *   - **The seat cap.** Making a person, and letting a disabled one back in, takes a seat; neither is
 *     done when the org has no seat left. The count is people on record who are not disabled, which is
 *     stricter than the portal's own count of people with a live session: an account that cannot sign
 *     in for want of a seat is a worse surprise than a refusal here. Sign-in still runs the portal's
 *     own gate (`login_precheck`), which is what actually decides.
 *   - **A tenant keeps an owner.** Disabling or demoting the last owner who is not disabled is refused.
 *   - **Ending a person's access ends their sessions.** Disabling or resetting revokes every portal
 *     browser session and every host session they hold, on the next request.
 */
import { normaliseEmail } from "../crypto";
import { InvalidGatewayEndpointError, normaliseGatewayEndpoint } from "../gateway-endpoint";
import { changeMemberRole, type ChangeRoleRefusal } from "../invites/role";
import type { PasswordHasher } from "../password/hash";
import { generateInitialPassword } from "../password/generate";
import type { Account, Clock, Org, Person, PortalOps, PortalStore, User, UserRole } from "../store/types";
import { revokeWebSessions } from "../flows/web-session";
import type { AccountRole, PersonRef } from "./args";

export interface AccountDeps {
  readonly store: PortalStore;
  readonly passwords: PasswordHasher;
  readonly clock: Clock;
  /**
   * Seals a raw endpoint key for `users.gateway_key_sealed` (DFIND-155). Required only when
   * `setAccountEndpoint` is given a key; the CLI wires it to the signing key.
   */
  readonly sealEndpointKey?: (raw: string) => string;
}

type Refusal<R extends string> = { readonly ok: false; readonly reason: R };

/** Thrown inside a transaction to roll it back with a reason; caught at the edge of the same function. */
class RollBack<R extends string> extends Error {
  readonly reason: R;
  constructor(reason: R) {
    super(reason);
    this.name = "RollBack";
    this.reason = reason;
  }
}

async function inTenant<T, R extends string>(
  store: PortalStore,
  tenantId: string,
  work: (ops: PortalOps) => Promise<T>,
): Promise<T | Refusal<R>> {
  try {
    return await store.tx(tenantId, work);
  } catch (error) {
    if (error instanceof RollBack) {
      return { ok: false, reason: error.reason as R };
    }
    throw error;
  }
}

/** The named org, the tenant's only org, or the reason there is no single answer. */
async function pickOrg(ops: PortalOps, tenantId: string, asked: string | null): Promise<Org> {
  const orgs = await ops.orgs.listForTenant(tenantId);
  if (asked) {
    const found = orgs.find((candidate) => candidate.slug === asked);
    if (!found) {
      throw new RollBack("unknown_org");
    }
    return found;
  }
  if (orgs.length === 0) {
    throw new RollBack("unknown_org");
  }
  if (orgs.length > 1) {
    throw new RollBack("choose_org");
  }
  return orgs[0];
}

function audit(
  ops: PortalOps,
  user: User,
  action: string,
  after: Readonly<Record<string, unknown>>,
  before?: Readonly<Record<string, unknown>>,
) {
  return ops.audit.append({
    tenantId: user.tenantId,
    orgId: user.orgId,
    actorKind: "support",
    action,
    targetKind: "user",
    targetId: user.id,
    before: before ?? null,
    after,
  });
}

/** Every session the person holds, portal-side and host-side, ended. */
async function endSessions(ops: PortalOps, user: User, reason: "admin" | "user_inactive"): Promise<void> {
  await ops.sessions.revokeAllForUser(user.id, reason);
  await revokeWebSessions(ops, { tenantId: user.tenantId, orgId: user.orgId, userId: user.id });
}

async function findPerson(ops: PortalOps, tenantId: string, person: PersonRef): Promise<Account | null> {
  return ops.credentials.findAccount(tenantId, person.by === "username" ? person.username : person.email);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateAccountInput {
  readonly tenantSlug: string;
  readonly orgSlug: string | null;
  readonly username: string;
  readonly email: string;
  /** `null`: a new person is a `member`, and an existing one keeps the role they have. */
  readonly role: AccountRole | null;
  readonly displayName: string | null;
  /** Operator-assigned API gateway base URL, or `null` / omitted for the default pinned gateway. */
  readonly gatewayEndpoint?: string | null;
}

export type CreateAccountRefusal =
  | "unknown_tenant"
  | "unknown_org"
  | "choose_org"
  /** The address is already a person in a different org of this tenant. */
  | "org_mismatch"
  | "username_taken"
  | "already_has_account"
  /** The address belongs to a disabled person: `enable` is how they come back. */
  | "user_disabled"
  /** An invited person is a code-mode leftover; there is no invite to redeem here. */
  | "user_invited"
  /** `--role` named a role other than the one an existing person holds: `set-role` changes it. */
  | "role_mismatch"
  | "seat_cap_reached"
  | "invalid_gateway_endpoint";

export interface CreatedAccount {
  readonly ok: true;
  /** Printed once by the CLI. Stored nowhere: only its scrypt hash is. */
  readonly password: string;
  readonly username: string;
  readonly email: string;
  readonly tenantSlug: string;
  readonly orgSlug: string;
  readonly userId: string;
  readonly role: UserRole;
  /** Operator-assigned gateway endpoint, or `null` when using the default pinned gateway. */
  readonly gatewayEndpoint: string | null;
  /** True when the person already existed (the owner `seed` makes) and only gained a credential. */
  readonly attached: boolean;
}

export type CreateAccountResult = CreatedAccount | Refusal<CreateAccountRefusal>;

export async function createAccount(deps: AccountDeps, input: CreateAccountInput): Promise<CreateAccountResult> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  let gatewayEndpoint: string | null = null;
  if (input.gatewayEndpoint !== undefined && input.gatewayEndpoint !== null) {
    try {
      gatewayEndpoint = normaliseGatewayEndpoint(input.gatewayEndpoint);
    } catch (error) {
      if (error instanceof InvalidGatewayEndpointError) {
        return { ok: false, reason: "invalid_gateway_endpoint" };
      }
      throw error;
    }
  }
  const email = normaliseEmail(input.email);
  // Hashed before the transaction opens: a derivation inside it would hold a pooled connection for
  // its whole length.
  const password = generateInitialPassword();
  const secret = await deps.passwords.hash(password);

  return inTenant<CreatedAccount, CreateAccountRefusal>(deps.store, tenantId, async (ops) => {
    const org = await pickOrg(ops, tenantId, input.orgSlug);
    const existing = await ops.users.findByEmail(tenantId, email);

    if (existing) {
      if (existing.orgId !== org.id) {
        throw new RollBack("org_mismatch");
      }
      if (existing.status === "disabled") {
        throw new RollBack("user_disabled");
      }
      if (existing.status === "invited") {
        throw new RollBack("user_invited");
      }
      if (await ops.credentials.findByUserId(existing.id)) {
        throw new RollBack("already_has_account");
      }
      // Attaching a password to somebody who is already a person here changes who they are in no
      // other way: the role stays theirs, and the seat they already hold is not counted again.
      if (input.role !== null && input.role !== existing.role) {
        throw new RollBack("role_mismatch");
      }
    } else if ((await ops.orgs.countProvisioned(org.id)) + 1 > org.seatCap) {
      throw new RollBack("seat_cap_reached");
    }
    if (await ops.credentials.findAccount(tenantId, input.username)) {
      throw new RollBack("username_taken");
    }

    let user =
      existing ??
      (await ops.users.create({
        tenantId,
        orgId: org.id,
        email,
        displayName: input.displayName,
        // Active at once: there is no invite to redeem in this mode, and `login_precheck` refuses
        // anybody who is not active.
        status: "active",
        role: input.role ?? "member",
        gatewayEndpoint,
      }));

    if (existing && gatewayEndpoint !== null && existing.gatewayEndpoint !== gatewayEndpoint) {
      user = (await ops.users.setGatewayEndpoint(existing.id, gatewayEndpoint)) ?? user;
    }

    const credential = await ops.credentials.create({
      userId: user.id,
      username: input.username,
      secret,
      mustChange: true,
      now: deps.clock.now(),
    });
    if (!credential) {
      // Lost a race to another operator: the username went between the check and the insert.
      throw new RollBack("username_taken");
    }

    // An existing person may already hold a session: a portal browser cookie, a host session, from the
    // e-mailed-code mode or from before this operator gave them a password. Every other way in is held
    // to the forced change of the initial password, and a session that predates the credential is not:
    // so it ends here, as it does for a reset. A person who did not exist has nothing to end.
    const sessionsEnded = existing === null ? 0 : (await ops.sessions.listLiveForUser(user.id)).length;
    if (existing !== null) {
      await endSessions(ops, user, "admin");
    }

    await audit(ops, user, "account.created", {
      user_id: user.id,
      username: input.username,
      role: user.role,
      org_slug: org.slug,
      gateway_endpoint: user.gatewayEndpoint,
      attached: existing !== null,
      must_change: true,
      ...(existing === null ? {} : { sessions_ended: sessionsEnded }),
    });
    return {
      ok: true as const,
      password,
      username: input.username,
      email,
      tenantSlug: input.tenantSlug,
      orgSlug: org.slug,
      userId: user.id,
      role: user.role,
      gatewayEndpoint: user.gatewayEndpoint,
      attached: existing !== null,
    };
  });
}

// ---------------------------------------------------------------------------
// reset-password
// ---------------------------------------------------------------------------

export interface PersonInput {
  readonly tenantSlug: string;
  readonly person: PersonRef;
}

export type PersonRefusal = "unknown_tenant" | "not_found";

export type ResetPasswordResult =
  | {
      readonly ok: true;
      readonly password: string;
      readonly username: string;
      readonly email: string;
      readonly userId: string;
      /** Portal-side sessions that were live and are ended. */
      readonly sessionsEnded: number;
    }
  | Refusal<PersonRefusal>;

export async function resetPassword(deps: AccountDeps, input: PersonInput): Promise<ResetPasswordResult> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  const password = generateInitialPassword();
  const secret = await deps.passwords.hash(password);

  return inTenant<Extract<ResetPasswordResult, { readonly ok: true }>, PersonRefusal>(
    deps.store,
    tenantId,
    async (ops) => {
      const account = await findPerson(ops, tenantId, input.person);
      if (!account) {
        throw new RollBack("not_found");
      }
      const { user, credential } = account;
      await ops.credentials.setPassword({
        userId: user.id,
        secret,
        mustChange: true,
        now: deps.clock.now(),
      });
      const sessionsEnded = (await ops.sessions.listLiveForUser(user.id)).length;
      await endSessions(ops, user, "admin");
      await audit(ops, user, "account.password_reset", {
        user_id: user.id,
        username: credential.username,
        must_change: true,
        sessions_ended: sessionsEnded,
      });
      return {
        ok: true as const,
        password,
        username: credential.username,
        email: user.email,
        userId: user.id,
        sessionsEnded,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// disable / enable
// ---------------------------------------------------------------------------

export type DisableRefusal = PersonRefusal | "already_disabled" | "last_owner";
export type EnableRefusal = PersonRefusal | "not_disabled" | "seat_cap_reached";

export interface StatusChanged {
  readonly ok: true;
  readonly username: string;
  readonly email: string;
  readonly userId: string;
  readonly status: "active" | "disabled";
}

export async function disableAccount(
  deps: AccountDeps,
  input: PersonInput,
): Promise<StatusChanged | Refusal<DisableRefusal>> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  return inTenant<StatusChanged, DisableRefusal>(deps.store, tenantId, async (ops) => {
    const account = await findPerson(ops, tenantId, input.person);
    if (!account) {
      throw new RollBack("not_found");
    }
    const { user, credential } = account;
    if (user.status === "disabled") {
      throw new RollBack("already_disabled");
    }
    if (user.role === "owner" && (await ops.users.lockOwners(tenantId)) <= 1) {
      throw new RollBack("last_owner");
    }
    await ops.users.setStatus(user.id, "disabled");
    await endSessions(ops, user, "user_inactive");
    await audit(
      ops,
      user,
      "account.disabled",
      { user_id: user.id, username: credential.username, status: "disabled" },
      { status: user.status },
    );
    return {
      ok: true as const,
      username: credential.username,
      email: user.email,
      userId: user.id,
      status: "disabled" as const,
    };
  });
}

export async function enableAccount(
  deps: AccountDeps,
  input: PersonInput,
): Promise<StatusChanged | Refusal<EnableRefusal>> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  return inTenant<StatusChanged, EnableRefusal>(deps.store, tenantId, async (ops) => {
    const account = await findPerson(ops, tenantId, input.person);
    if (!account) {
      throw new RollBack("not_found");
    }
    const { user, credential } = account;
    if (user.status !== "disabled") {
      throw new RollBack("not_disabled");
    }
    const org = await ops.orgs.findById(user.orgId);
    if (org && (await ops.orgs.countProvisioned(org.id)) + 1 > org.seatCap) {
      throw new RollBack("seat_cap_reached");
    }
    await ops.users.setStatus(user.id, "active");
    // Attempts made on them while they were disabled were counted (so that what is written about them is
    // bounded), and a lock made of those must not be there to meet the person who is let back in.
    await ops.credentials.clearAttempts(user.id);
    await audit(
      ops,
      user,
      "account.enabled",
      { user_id: user.id, username: credential.username, status: "active" },
      { status: user.status },
    );
    return {
      ok: true as const,
      username: credential.username,
      email: user.email,
      userId: user.id,
      status: "active" as const,
    };
  });
}

// ---------------------------------------------------------------------------
// set-role
// ---------------------------------------------------------------------------

export type SetRoleRefusal = PersonRefusal | ChangeRoleRefusal;

export interface RoleChanged {
  readonly ok: true;
  readonly username: string;
  readonly email: string;
  readonly from: UserRole;
  readonly to: UserRole;
}

/** The role change is `invites/role.ts`'s, with its last-owner rule and its audit row, unchanged. */
export async function setAccountRole(
  deps: AccountDeps,
  input: PersonInput & { readonly role: AccountRole },
): Promise<RoleChanged | Refusal<SetRoleRefusal>> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  const account = await deps.store.tx(tenantId, (ops) => findPerson(ops, tenantId, input.person));
  if (!account) {
    return { ok: false, reason: "not_found" };
  }
  const changed = await changeMemberRole(deps.store, {
    tenantSlug: input.tenantSlug,
    email: account.user.email,
    role: input.role,
  });
  if (!changed.ok) {
    return { ok: false, reason: changed.reason };
  }
  return { ok: true, username: account.credential.username, email: changed.email, from: changed.from, to: changed.to };
}

// ---------------------------------------------------------------------------
// set-endpoint (Nultron admin only)
// ---------------------------------------------------------------------------

export type SetEndpointRefusal =
  | PersonRefusal
  | "user_disabled"
  | "same_endpoint"
  | "invalid_gateway_endpoint"
  | "key_wrap_unavailable";

export interface EndpointChanged {
  readonly ok: true;
  readonly username: string;
  readonly email: string;
  readonly userId: string;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Assign or clear a person's API gateway endpoint (operator/admin only).
 * The new endpoint reaches the host in the person's next token (on sign-in or refresh), where the
 * host re-validates their gateway key against the newly assigned endpoint.
 */
export async function setAccountEndpoint(
  deps: AccountDeps,
  input: PersonInput & { readonly gatewayEndpoint: string | null; readonly gatewayKey?: string | null },
): Promise<EndpointChanged | Refusal<SetEndpointRefusal>> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  let target: string | null = null;
  if (input.gatewayEndpoint !== null) {
    try {
      target = normaliseGatewayEndpoint(input.gatewayEndpoint);
    } catch (error) {
      if (error instanceof InvalidGatewayEndpointError) {
        return { ok: false, reason: "invalid_gateway_endpoint" };
      }
      throw error;
    }
  }
  return inTenant<EndpointChanged, SetEndpointRefusal>(deps.store, tenantId, async (ops) => {
    const account = await findPerson(ops, tenantId, input.person);
    // A code-mode member holds no password credential, so `findPerson` misses them; the person
    // still exists on `users`, found by address (a code-mode invite names no username).
    const codeModeUser =
      !account && input.person.by === "email" ? await ops.users.findByEmail(tenantId, input.person.email) : null;
    const user = account?.user ?? codeModeUser;
    if (!user) {
      throw new RollBack("not_found");
    }
    const username = account?.credential.username ?? user.email;
    if (user.status === "disabled") {
      throw new RollBack("user_disabled");
    }
    if (user.gatewayEndpoint === target && input.gatewayKey === undefined) {
      throw new RollBack("same_endpoint");
    }
    // The key is sealed here, at the door: the raw value crosses one argument boundary and is in
    // no column, log line or audit row. `--clear` and an endpoint set with no key both write NULL.
    const sealed =
      input.gatewayKey && deps.sealEndpointKey ? deps.sealEndpointKey(input.gatewayKey) : null;
    if (input.gatewayKey && !deps.sealEndpointKey) {
      throw new RollBack("key_wrap_unavailable" as SetEndpointRefusal);
    }
    await ops.users.setGatewayEndpoint(user.id, target, sealed);
    await audit(
      ops,
      user,
      "account.gateway_endpoint_updated",
      { user_id: user.id, username, gateway_endpoint: target },
      { gateway_endpoint: user.gatewayEndpoint },
    );
    return {
      ok: true as const,
      username,
      email: user.email,
      userId: user.id,
      from: user.gatewayEndpoint,
      to: target,
    };
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type ListRefusal = "unknown_tenant" | "unknown_org" | "choose_org";

export type ListResult =
  | {
      readonly ok: true;
      readonly tenantSlug: string;
      readonly orgSlug: string;
      readonly seatCap: number;
      readonly people: readonly Person[];
      /**
       * How many times each person's account was locked in the last 24 hours, by user id (a person
       * with none is not in the map). Read from the audit rows the sign-in writes for each lock; an
       * operator sees at a glance whose account somebody is at.
       */
      readonly locksLast24h: ReadonlyMap<string, number>;
      readonly now: Date;
    }
  | Refusal<ListRefusal>;

/** How far back `list` counts locks. */
export const LOCK_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function listAccounts(
  deps: AccountDeps,
  input: { readonly tenantSlug: string; readonly orgSlug: string | null },
): Promise<ListResult> {
  const tenantId = await deps.store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }
  return inTenant<Extract<ListResult, { readonly ok: true }>, ListRefusal>(deps.store, tenantId, async (ops) => {
    const org = await pickOrg(ops, tenantId, input.orgSlug);
    const now = deps.clock.now();
    return {
      ok: true as const,
      tenantSlug: input.tenantSlug,
      orgSlug: org.slug,
      seatCap: org.seatCap,
      people: await ops.credentials.listPeople(tenantId, org.id),
      locksLast24h: await ops.audit.countByTarget({
        tenantId,
        action: "password.locked",
        since: new Date(now.getTime() - LOCK_COUNT_WINDOW_MS),
      }),
      now,
    };
  });
}

// ---------------------------------------------------------------------------
// What the CLI prints
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** One row per person. Nothing secret is in a `Person`, so nothing secret can be printed from it. */
export function formatList(result: Extract<ListResult, { readonly ok: true }>): string {
  const rows = result.people.map(({ user, credential }) => {
    const lockedUntil = credential?.lockedUntil ? new Date(credential.lockedUntil) : null;
    const locked = lockedUntil !== null && lockedUntil > result.now;
    return [
      credential?.username ?? "-",
      user.email,
      user.role,
      user.status,
      user.gatewayEndpoint ?? "default",
      credential === null ? "no password" : credential.mustChange ? "must change" : "chosen",
      credential?.lastSignInAt ?? "never",
      locked && lockedUntil ? `until ${lockedUntil.toISOString()}` : "-",
      String(result.locksLast24h.get(user.id) ?? 0),
    ];
  });
  const header = [
    "username",
    "e-mail",
    "role",
    "status",
    "endpoint",
    "password",
    "last password seen",
    "locked",
    "locks 24h",
  ];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => pad(cell, widths[column]))
      .join("  ")
      .trimEnd();
  const active = result.people.filter((person) => person.user.status !== "disabled").length;
  return [
    `tenant ${result.tenantSlug}   org ${result.orgSlug}   seats ${active} of ${result.seatCap} on record`,
    "",
    line(header),
    ...rows.map(line),
    "",
  ].join("\n");
}

export function formatCreated(result: CreatedAccount): string {
  return [
    `username   ${result.username}`,
    `address    ${result.email}`,
    `tenant     ${result.tenantSlug}   org ${result.orgSlug}   role ${result.role}`,
    `endpoint   ${result.gatewayEndpoint ?? "default"}`,
    `person     ${result.attached ? "existing, now has a password" : "created"}; active, and must choose a new password at first sign-in`,
    "",
    `password   ${result.password}`,
    "",
    "This password is shown once. Only its scrypt hash is stored, so it cannot be read back or shown",
    "again; to hand over another, run reset-password. Give it to the person by a channel you trust, and",
    "tell them the sign-in page will ask them to choose their own before it lets them in.",
    "",
  ].join("\n");
}

export function formatReset(result: Extract<ResetPasswordResult, { readonly ok: true }>): string {
  return [
    `username   ${result.username}`,
    `address    ${result.email}`,
    `sessions   ${result.sessionsEnded} portal session(s) ended; any browser session is ended too`,
    "",
    `password   ${result.password}`,
    "",
    "This password is shown once, and replaces the one before it, which no longer works. The count of",
    "failed attempts, the attempts taken under a lock and any lock on the account are cleared, so the",
    "account can be signed in to at once. The person must choose their own at the next sign-in.",
    "",
  ].join("\n");
}
