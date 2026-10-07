/**
 * The portal's own browser session, on the flow side: mint it, check it is still live, end it.
 *
 * `src/security/web-session.ts` owns the cookie's bytes — payload, HMAC, TTL. This owns the one
 * thing that needs the database: the per-user version counter that makes a signed cookie
 * revocable (`apps/portal/migrations/0009_web_session_revocation.sql`, SR-21).
 *
 * The rule every caller follows: **a cookie is not a session until its version has been checked**
 * inside the tenant's own scope. `readWebSession` proves the cookie is ours and unexpired; only
 * `webSessionIsLive` (or the same read inside a transaction the caller already has) proves it has
 * not been revoked since.
 */
import { serialiseCookie } from "../security/cookies";
import { WEB_SESSION_TTL_MS, mintWebSession, type WebSession } from "../security/web-session";
import type { PortalOps, User } from "../store/types";
import type { PortalRuntime } from "./context";

export interface NewWebSession {
  readonly tenantId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly installId: string;
}

/** `Set-Cookie` for a fresh session, stamped with the version it was minted under. */
export function webSessionCookie(runtime: PortalRuntime, session: NewWebSession, version: number): string {
  return serialiseCookie(
    runtime.cookies.session,
    mintWebSession(runtime.webSecret, { ...session, ver: version }, runtime.clock.now().getTime()),
    { secure: runtime.secureCookies, maxAgeSeconds: Math.floor(WEB_SESSION_TTL_MS / 1000) },
  );
}

/** The same, reading the live version inside the caller's transaction. */
export async function webSessionCookieFor(
  runtime: PortalRuntime,
  ops: PortalOps,
  session: NewWebSession,
): Promise<string> {
  return webSessionCookie(runtime, session, await ops.webSessions.version(session.userId));
}

/** An expiry in the past: what `POST /logout` and `GET /logout` send back. */
export function clearedWebSessionCookie(runtime: PortalRuntime): string {
  return serialiseCookie(runtime.cookies.session, "", {
    secure: runtime.secureCookies,
    maxAgeSeconds: 0,
  });
}

/** True when the cookie's version still matches the user's. One indexed read, no write. */
export async function versionIsLive(ops: PortalOps, session: WebSession): Promise<boolean> {
  return (await ops.webSessions.version(session.userId)) === session.ver;
}

/**
 * The same check with its own transaction, for the callers that do not already have one.
 *
 * A cookie for a tenant that has gone, or a store that throws, reads as not live: this is the
 * "prove you are still signed in" direction, so it fails closed onto the sign-in form.
 */
export async function webSessionIsLive(
  runtime: PortalRuntime,
  session: WebSession | null,
): Promise<boolean> {
  if (!session) {
    return false;
  }
  try {
    return await runtime.store.tx(session.tenantId, (ops) => versionIsLive(ops, session));
  } catch {
    return false;
  }
}

/**
 * `PORTAL_SIGNIN_MODE=password` only: does this person's credential still say "choose a new password
 * first"? Then no cookie they hold is a session, however live its version is. A cookie that predates
 * the credential (made in the e-mailed-code mode, or before an operator attached a password to an
 * existing person) would otherwise get past the forced change that every other way in is held to.
 * `account create` and `reset-password` both end the person's sessions, so this is the second line,
 * for whatever path leaves a live cookie next to `must_change`. It is also read at the end of a fresh
 * password sign-in (`completeSignIn`, `signedInOnActivate`), because a `reset-password` that lands after
 * the password was proved has already ended the sessions that existed. In the default mode nothing here
 * reads the credentials table.
 */
export async function mustChangePasswordFirst(
  runtime: PortalRuntime,
  ops: PortalOps,
  userId: string,
): Promise<boolean> {
  if (runtime.config.signInMode !== "password") {
    return false;
  }
  return (await ops.credentials.findByUserId(userId))?.mustChange === true;
}

/**
 * The member a cookie speaks for, when the cookie is still good: its version is current (SR-21)
 * AND that member still exists and is `active` (and, in the password mode, is not still owed a new
 * password: `mustChangePasswordFirst`).
 *
 * The second half is the one `webSessionIsLive` does not make. A member who was removed -- or whose
 * company was erased, which cascades the row away -- or disabled still holds a cookie that verifies,
 * and a screen that greets them by address, or lets them approve a device, must not treat them as
 * signed in. Null reads as "not signed in": the caller shows the sign-in form, and the e-mail step
 * then tells that address what it tells any stranger.
 */
export async function liveWebSessionUser(
  runtime: PortalRuntime,
  session: WebSession | null,
): Promise<User | null> {
  if (!session) {
    return null;
  }
  try {
    return await runtime.store.tx(session.tenantId, async (ops) => {
      if (!(await versionIsLive(ops, session))) {
        return null;
      }
      const user = await ops.users.findById(session.userId);
      if (user?.status !== "active") {
        return null;
      }
      return (await mustChangePasswordFirst(runtime, ops, user.id)) ? null : user;
    });
  } catch {
    return null;
  }
}

/**
 * End every portal browser session this user holds, and say so in the audit log.
 *
 * Called from `POST /auth/logout` with `all_devices: true` — the one caller whose stated meaning
 * is already "everywhere" — and never from the single-browser sign-out, which clears its own
 * cookie and leaves anyone else's alone.
 */
export async function revokeWebSessions(
  ops: PortalOps,
  input: {
    readonly tenantId: string;
    readonly orgId: string | null;
    readonly userId: string;
    readonly ip?: string | null;
  },
): Promise<number> {
  const version = await ops.webSessions.revoke({ userId: input.userId, tenantId: input.tenantId });
  await auditWebSessionRevoked(ops, { ...input, scope: "user", version });
  return version;
}

/**
 * One action name for "a portal browser session ended", with the blast radius in `after.scope`:
 * `browser` is this cookie only (`/logout`), `user` is every browser that person holds
 * (`/auth/logout` with `all_devices`).
 */
export async function auditWebSessionRevoked(
  ops: PortalOps,
  input: {
    readonly tenantId: string;
    readonly orgId: string | null;
    readonly userId: string;
    readonly scope: "browser" | "user";
    readonly version?: number;
    readonly ip?: string | null;
  },
): Promise<void> {
  await ops.audit.append({
    tenantId: input.tenantId,
    orgId: input.orgId,
    actorKind: "user",
    actorUserId: input.userId,
    action: "web_session.revoked",
    targetKind: "user",
    targetId: input.userId,
    after: { scope: input.scope, ...(input.version === undefined ? {} : { version: input.version }) },
    ip: input.ip ?? null,
  });
}
