/**
 * The password sign-in as explicit steps (`PORTAL_SIGNIN_MODE=password`).
 *
 *   1. identify   a username or an e-mail address -> the person, inside one tenant, or nobody
 *   2. verify     the password, behind the lockout -> verified, or one refusal for every reason
 *   3. (second factor: not built; it goes HERE, between 2 and 4 -- see "Where a second factor goes")
 *   4. change     a new password, when the credential says the person must choose one
 *   5. issue      the session, which is the route's: the same `completeSignIn` the code flow ends in
 *
 * Decisions only. Pages, status codes and the rate-limit budgets are the route's
 * (`routes/password-flow.ts`).
 *
 * **One refusal, whatever the reason.** An unknown username, a wrong password, a locked account and a
 * disabled person are all `refused`, and the route says one sentence for all of them. They also take
 * the same time: whichever of them it is, exactly one scrypt derivation runs (`verifyDummy` when there
 * is nothing to compare against), so the sign-in is not an oracle for which accounts exist or which
 * are locked. What differs is a few database round trips, a few milliseconds against about a hundred.
 *
 * **The count comes first** (`store/postgres/credentials.ts`, `reserveAttempt`): an attempt is charged
 * before the password is compared, and only a caller that won an increment is handed the hash, so
 * parallel guesses cannot out-run the lock. Five counted attempts lock the account for fifteen
 * minutes; a correct password clears the count.
 *
 * **The lock is not a wall, because a wall is a free way to keep a named person out.** A source that has
 * attempted this person in the window and not got through (`security/password-attempts.ts`, in this
 * process) is refused outright while the account is locked, whatever it types. A source that has not
 * is let through to the same `reserveAttempt`, which hands it one of three more attempts the database
 * counts (`grace_attempts`) -- so the person, from their own address, gets in, and the number of
 * passwords a window can ever try is five plus three, whoever asks and from how many addresses. A
 * success clears everything. What a restart or a second process loses is the record of sources, never
 * the count.
 *
 * **A step takes a place before it counts anything.** `admit()` (`password/hash.ts`) is asked first and
 * answers `busy` when eight steps are already deriving: nothing has been charged to anybody, nothing
 * was looked up, and the answer is the same for a person and for nobody. It is held to the last
 * derivation, real or dummy, and given back on every road out.
 *
 * Every success, failure, lock and change writes an audit row for the person it concerns -- as the
 * SYSTEM acting on that person for everything an outsider can cause (a failure, a lock, a withheld
 * attempt), and as the person only for the rows that record their own proof or their own change. An
 * attempt on a username that does not exist writes none, and neither does an attempt that was not
 * counted (a refusal under the lock, a busy answer): `audit_log` is append-only, and an unauthenticated
 * caller must not be able to grow it. Every row that IS written follows a counted attempt, so what an
 * outsider can add per account per window is bounded by the same five plus three.
 *
 * **Where a second factor goes.** Two-factor sign-in is being designed (owner, 2026-10-07) and is not
 * built, and no column or placeholder exists for it. When it is, it is one more function of the same
 * shape as `verifyPasswordStep`, run after it in `signInWithPassword` and in `changePasswordAndSignIn`
 * (both return a `refused` the route already renders, and a step that needs a screen of its own adds a
 * state next to `change_required`), and nothing in the steps above or below it moves.
 */
import { normaliseEmail } from "../crypto";
import { normalisePassword, type PasswordHasher } from "../password/hash";
import {
  PASSWORD_MAX_LENGTH,
  checkPasswordAgainstAccount,
  checkPasswordShape,
  codePointLength,
  normaliseUsername,
  type PasswordRefusal,
} from "../password/policy";
import type { PasswordAttempts } from "../security/password-attempts";
import { PASSWORD_GRACE_ATTEMPTS, PASSWORD_LOCK_MS, PASSWORD_MAX_FAILED_ATTEMPTS } from "../store/postgres/credentials";
import type { Account, Clock, Credential, PortalOps, PortalStore, User } from "../store/types";
import { revokeWebSessions } from "./web-session";

/** What the steps need. `PortalRuntime` has all of it, so a route passes the runtime itself. */
export interface PasswordDeps {
  readonly store: PortalStore;
  readonly passwords: PasswordHasher;
  readonly clock: Clock;
  /** Which sources have attempted which person in the window, and the order attempts are charged in. */
  readonly attempts: PasswordAttempts;
}

/** A lock that follows another within this long is "locked again", and an operator is told. */
export const LOCK_REPEAT_WINDOW_MS = 60 * 60 * 1000;

/** An address is the longest an identifier can be; anything past it is not one. */
export const MAX_IDENTIFIER_LENGTH = 254;

// ---------------------------------------------------------------------------
// Step 1: identify
// ---------------------------------------------------------------------------

export interface Identified {
  readonly tenantId: string;
  readonly account: Account;
}

/** What is typed into the one field: trimmed and lower case. `null` for nothing or too much. */
export function normaliseIdentifier(raw: string): string | null {
  const identifier = raw.includes("@") ? normaliseEmail(raw) : normaliseUsername(raw);
  return identifier === "" || identifier.length > MAX_IDENTIFIER_LENGTH ? null : identifier;
}

/**
 * The person behind a username or an address, inside one tenant.
 *
 * With `requiredTenantId` (the OAuth client's tenant on `/authorize`, a pending device code's on
 * `/activate`) the lookup is made inside it and nothing else is asked. Without one -- the device-code
 * page before a code is in hand -- the tenant is resolved from the identifier, and an identifier
 * that is unknown or is used in more than one tenant resolves to nothing, as the e-mail step does.
 */
export async function identifyAccount(
  deps: Pick<PasswordDeps, "store">,
  input: { readonly identifier: string; readonly requiredTenantId: string | null },
): Promise<Identified | null> {
  const identifier = normaliseIdentifier(input.identifier);
  if (identifier === null) {
    return null;
  }
  const tenantId =
    input.requiredTenantId ??
    (identifier.includes("@")
      ? await deps.store.resolve.byEmail(identifier)
      : await deps.store.resolve.byUsername(identifier));
  if (!tenantId) {
    return null;
  }
  const account = await deps.store.tx(tenantId, (ops) => ops.credentials.findAccount(tenantId, identifier));
  return account ? { tenantId, account } : null;
}

// ---------------------------------------------------------------------------
// Step 2: verify
// ---------------------------------------------------------------------------

export type VerifyOutcome =
  | {
      readonly kind: "verified";
      readonly tenantId: string;
      readonly user: User;
      readonly credential: Credential;
      /** The stored hash as it stands now (after any re-hash): what the change step guards on. */
      readonly currentHash: Buffer;
    }
  | { readonly kind: "refused" }
  /**
   * `orgs.sso_required` (0017) and not an owner: the password is off for them whatever it is. Said
   * after the account was identified but before any password work: nothing was counted, and the
   * answer names the org's own rule rather than spending a derivation to say nothing.
   */
  | { readonly kind: "sso_required" };

const REFUSED: VerifyOutcome = Object.freeze({ kind: "refused" });

/** A row for something the person did themselves: proved a password, changed it. They are the actor. */
function personRow(ops: PortalOps, user: User, action: string, reasonCode: string | null, ip: string | null) {
  return ops.audit.append({
    tenantId: user.tenantId,
    orgId: user.orgId,
    actorKind: "user",
    actorUserId: user.id,
    action,
    targetKind: "user",
    targetId: user.id,
    reasonCode,
    ip,
  });
}

/**
 * A row for something an outsider caused and the person did not: a wrong guess, a lock, an attempt on
 * a person who is not active. The actor is the system, because the caller is unauthenticated and has
 * proved nothing about who it is; the person is the TARGET. Putting the person in the actor column
 * (as these rows first did) made an audit trail say that a named person had acted when somebody else
 * had acted on them.
 */
function outsiderRow(ops: PortalOps, user: User, action: string, reasonCode: string | null, ip: string | null) {
  return ops.audit.append({
    tenantId: user.tenantId,
    orgId: user.orgId,
    actorKind: "system",
    action,
    targetKind: "user",
    targetId: user.id,
    reasonCode,
    ip,
  });
}

/**
 * A person who is disabled (or otherwise not active) still takes the cost of a comparison and gets the
 * one refusal -- and an attempt on them is COUNTED like any other, so the lock bounds what is written
 * about it: one `password.withheld` row per counted attempt, five per window at most, and none for an
 * attempt that meets the lock. No slot under the lock is asked for: nobody who is not active is let in.
 */
async function refuseInactive(
  deps: PasswordDeps,
  tenantId: string,
  user: User,
  password: string,
  ip: string | null,
): Promise<VerifyOutcome> {
  await deps.store.tx(tenantId, async (ops) => {
    const reserved = await ops.credentials.reserveAttempt({
      userId: user.id,
      now: deps.clock.now(),
      maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
      lockMs: PASSWORD_LOCK_MS,
    });
    if (reserved.kind === "reserved") {
      await outsiderRow(
        ops,
        user,
        "password.withheld",
        user.status === "disabled" ? "user_disabled" : "user_not_active",
        ip,
      );
    }
  });
  await deps.passwords.verifyDummy(password);
  return REFUSED;
}

/**
 * Compare a password with the person's, behind the lockout. `found` is whatever step 1 returned,
 * `null` included: an absent person still costs one derivation, so this is the one place the timing
 * is made equal. `source` is the bucket the request came from (`sourceBucket`), which is what the
 * lock tells the person from whoever is hammering them by.
 *
 * Every caller holds a derivation permit (`PasswordHasher.admit`) around this call.
 */
export async function verifyPasswordStep(
  deps: PasswordDeps,
  found: Identified | null,
  password: string,
  ip: string | null,
  source: string,
): Promise<VerifyOutcome> {
  // The ceiling is on the password as it will be compared: NFKC first, as `checkPasswordShape` and the
  // hash both do, so one that is valid typed in decomposed form is compared and not turned away for
  // the code points it has before it is composed.
  if (!found || codePointLength(normalisePassword(password)) > PASSWORD_MAX_LENGTH) {
    // Nobody to compare with, or a string no password can be (the policy's ceiling): the cost of a
    // comparison, then the one refusal. An over-long string is not a guess at anything.
    await deps.passwords.verifyDummy(password);
    return REFUSED;
  }

  const { tenantId, account } = found;
  const { user } = account;
  if (user.status !== "active") {
    return refuseInactive(deps, tenantId, user, password, ip);
  }

  // The org's Owner may require SSO for non-owners (0017). Before the lock and before the
  // derivation: a refused-elsewhere policy costs nobody an attempt. No audit row is written here:
  // no attempt was counted, and one row per submission would let anyone who knows a username
  // grow the audit table without bound -- the dead-end page is the refusal's record.
  const ssoGate = await deps.store.tx(tenantId, async (ops) => {
    const org = await ops.orgs.findById(user.orgId);
    return org?.ssoRequired === true && user.role !== "owner";
  });
  if (ssoGate) {
    await deps.passwords.verifyDummy(password);
    return { kind: "sso_required" };
  }

  // One synchronous step, and nothing awaited between its two halves: this source is recorded as having
  // attempted this person (and told whether it already had), and the charge is queued behind every
  // earlier one for the same person. The order of those two is the order the database sees them in.
  const accountKey = `${tenantId}|${user.id}`;
  const { clean } = deps.attempts.enter(accountKey, source);
  const reserved = await deps.attempts.ordered(accountKey, () =>
    deps.store.tx(tenantId, (ops) =>
      ops.credentials.reserveAttempt({
        userId: user.id,
        now: deps.clock.now(),
        maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
        lockMs: PASSWORD_LOCK_MS,
        // Only a source with no earlier attempt may take a slot under the lock.
        graceAttempts: clean ? PASSWORD_GRACE_ATTEMPTS : 0,
      }),
    ),
  );
  if (reserved.kind !== "reserved") {
    // Locked, and no slot for this source (nothing was counted, so no row: a row per refusal would let
    // anyone who knows a username grow the audit table), or gone since step 1.
    await deps.passwords.verifyDummy(password);
    return REFUSED;
  }

  if (!(await deps.passwords.verify(password, reserved.secret))) {
    const now = deps.clock.now();
    await deps.store.tx(tenantId, async (ops) => {
      await outsiderRow(
        ops,
        user,
        "password.failed",
        reserved.graceUsed > 0 ? "wrong_password_while_locked" : "wrong_password",
        ip,
      );
      if (reserved.lockedNow) {
        // Counted before this lock's own row is written, so "locked before" never counts itself.
        const earlier = await ops.audit.countByTarget({
          tenantId,
          action: "password.locked",
          since: new Date(now.getTime() - LOCK_REPEAT_WINDOW_MS),
          targetId: user.id,
        });
        await outsiderRow(ops, user, "password.locked", "too_many_failures", ip);
        if ((earlier.get(user.id) ?? 0) > 0) {
          // Somebody is at this account again: the one row an operator reads to see it.
          await outsiderRow(ops, user, "password.lock_repeated", "locked_again_within_an_hour", ip);
        }
      }
    });
    return REFUSED;
  }

  // Right. The count is cleared, and a hash made under older parameters is replaced with one made
  // under the current ones -- the only moment the plain password is in hand to do it. Both writes are
  // guarded by the hash that was just proved: if the operator reset the password while it was being
  // compared, nothing is written, and the sign-in is refused (the password that was typed is not the
  // person's any more, and a session issued on it would outlive the reset that ended every other).
  const rehash = deps.passwords.needsRehash(reserved.secret) ? await deps.passwords.hash(password) : undefined;
  const recorded = await deps.store.tx(tenantId, async (ops) => {
    const written = await ops.credentials.recordSuccess({
      userId: user.id,
      now: deps.clock.now(),
      rehash,
      expectHash: reserved.secret.hash,
    });
    if (!written) {
      // The stored hash is no longer the one that was proved. A reset or a change did that if the
      // password's own date moved: it is not the person's password any more. Otherwise a sign-in that
      // was running at the same moment (a double click, a second device) re-hashed the same password
      // under the current cost first, the password is still right, and there is nothing left to write.
      const now = await ops.credentials.findByUserId(user.id);
      if (now === null || now.passwordChangedAt !== account.credential.passwordChangedAt) {
        await outsiderRow(ops, user, "password.failed", "changed_during_sign_in", ip);
        return false;
      }
      await personRow(ops, user, "password.verified", reserved.graceUsed > 0 ? "while_locked" : null, ip);
      return true;
    }
    await personRow(
      ops,
      user,
      "password.verified",
      reserved.graceUsed > 0 ? "while_locked" : rehash ? "rehashed" : null,
      ip,
    );
    return true;
  });
  if (!recorded) {
    return REFUSED;
  }
  // The mark is for a source that has not got through: this one has.
  deps.attempts.forget(accountKey, source);
  // `currentHash` is what the forced change guards its write on. In the one case where a concurrent
  // sign-in re-hashed first it is no longer the stored hash, the change finds nothing to write, and the
  // person is asked again: the safe way for that to fail.
  return {
    kind: "verified",
    tenantId,
    user,
    credential: account.credential,
    currentHash: (rehash ?? reserved.secret).hash,
  };
}

// ---------------------------------------------------------------------------
// The sign-in, and the change
// ---------------------------------------------------------------------------

export interface PasswordSignInInput {
  readonly identifier: string;
  readonly password: string;
  readonly requiredTenantId: string | null;
  /** The address as the portal read it, for the audit row. */
  readonly ip: string | null;
  /** The bucket the request counts against (`sourceBucket`): what the lock tells a person from an attacker by. */
  readonly source: string;
}

export type PasswordSignInState =
  /** The password was right and nothing else is owed: issue the session. */
  | { readonly kind: "signed_in"; readonly tenantId: string; readonly user: User }
  /** Right, but it is an operator-issued password: ask for a new one before a session exists. */
  | { readonly kind: "change_required" }
  /** Wrong, unknown, locked or disabled. The route cannot tell which, and neither can the person. */
  | { readonly kind: "refused" }
  /** `orgs.sso_required` and not an owner: the button on the sign-in page is the way in. */
  | { readonly kind: "sso_required" }
  /**
   * Too many sign-ins are deriving already (`503`). Said before anything was looked up or counted, so
   * it is the same for everyone and costs nobody an attempt.
   */
  | { readonly kind: "busy" };

export async function signInWithPassword(deps: PasswordDeps, input: PasswordSignInInput): Promise<PasswordSignInState> {
  const permit = deps.passwords.admit();
  if (permit === null) {
    return { kind: "busy" };
  }
  try {
    const found = await identifyAccount(deps, input);
    const verified = await verifyPasswordStep(deps, found, input.password, input.ip, input.source);
    if (verified.kind === "refused") {
      return { kind: "refused" };
    }
    if (verified.kind === "sso_required") {
      return { kind: "sso_required" };
    }
    // A second factor, when one exists, is checked here (see the header).
    if (verified.credential.mustChange) {
      return { kind: "change_required" };
    }
    return { kind: "signed_in", tenantId: verified.tenantId, user: verified.user };
  } finally {
    permit.release();
  }
}

export interface ChangePasswordInput {
  readonly identifier: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword: string;
  readonly requiredTenantId: string | null;
  readonly ip: string | null;
  readonly source: string;
}

export type ChangePasswordOutcome =
  | { readonly kind: "signed_in"; readonly tenantId: string; readonly user: User }
  /** The new password is not acceptable. Said only after the current one proved, or about its shape alone. */
  | { readonly kind: "refused"; readonly reason: PasswordRefusal }
  /** The current password did not check out: the same single refusal as a wrong sign-in. */
  | { readonly kind: "invalid" }
  /** As for the sign-in: too many are deriving, and nothing was charged. */
  | { readonly kind: "busy" };

/**
 * The new-password step: prove the current password again, choose a new one, and sign in with it.
 *
 * The current password is asked for again, and verified the same way as at sign-in (counted, locked,
 * constant-cost), rather than carried between the two screens in a token. There is nothing for a page
 * to carry that could be stolen or replayed, and each post stands on its own. The same post serves a
 * person who chose to change a password they already knew; no page links to it in this build.
 *
 * The checks that need no account (length, characters, the two copies matching) run first and count
 * nothing against the lockout. The checks that need the account (not the username, not the e-mail, not
 * the old password) run only after the current password has proved, so what they say is said to the
 * person and not to whoever typed a username.
 *
 * Changing the password ends every session the person holds, here and in the host: whoever had the
 * old one loses it with the old one.
 */
export async function changePasswordAndSignIn(
  deps: PasswordDeps,
  input: ChangePasswordInput,
): Promise<ChangePasswordOutcome> {
  if (normalisePassword(input.newPassword) !== normalisePassword(input.confirmPassword)) {
    return { kind: "refused", reason: "mismatch" };
  }
  const shape = checkPasswordShape(input.newPassword);
  if (shape) {
    return { kind: "refused", reason: shape };
  }

  // Held from here to the last derivation, the new password's included, and given back on every road out.
  const permit = deps.passwords.admit();
  if (permit === null) {
    return { kind: "busy" };
  }
  try {
    const found = await identifyAccount(deps, input);
    const verified = await verifyPasswordStep(deps, found, input.currentPassword, input.ip, input.source);
    if (verified.kind === "refused" || verified.kind === "sso_required") {
      return { kind: "invalid" };
    }
    // A second factor, when one exists, is checked here too (see the header).

    const { tenantId, user, credential } = verified;
    const unacceptable = checkPasswordAgainstAccount(input.newPassword, {
      username: credential.username,
      email: user.email,
      current: input.currentPassword,
    });
    if (unacceptable) {
      return { kind: "refused", reason: unacceptable };
    }

    const fresh = await deps.passwords.hash(input.newPassword);
    const applied = await deps.store.tx(tenantId, async (ops) => {
      const written = await ops.credentials.setPassword({
        userId: user.id,
        secret: fresh,
        mustChange: false,
        now: deps.clock.now(),
        expectHash: verified.currentHash,
      });
      if (!written) {
        // Another change got there between the proof and the write. Nothing was changed.
        return false;
      }
      await ops.sessions.revokeAllForUser(user.id, "session_revoked");
      await revokeWebSessions(ops, { tenantId, orgId: user.orgId, userId: user.id, ip: input.ip });
      await personRow(ops, user, "password.changed", credential.mustChange ? "forced" : "voluntary", input.ip);
      return true;
    });
    return applied ? { kind: "signed_in", tenantId, user } : { kind: "invalid" };
  } finally {
    permit.release();
  }
}
