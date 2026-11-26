/**
 * The session routes of the hosted deployment (docs/internal/web-migration-plan.md Phase 2;
 * the browser login flow is Phase 9, docs/internal/web-phase9-portal-login.md):
 *
 *   GET  /api/v1/auth/start                        → { authorizeUrl } + the state cookie
 *   POST /api/v1/auth/login    { code, state }     → sets the session cookie
 *   POST /api/v1/auth/logout                       → revokes it, portal-side and here
 *   GET  /api/v1/auth/session                      → { signedIn, … } | { signedIn: false, reason? }
 *   POST /api/v1/auth/refresh                      → rotates the portal tokens, extends the session
 *
 * Every failure goes out through the existing `{ error: { code, message } }` envelope with a reason
 * code from the portal's own list (docs/internal/portal/device-code-login.md:222); the message is
 * the portal's `message_en` when it sent one, otherwise the same English copy the doc's table gives
 * (:409-423). The renderer localises by code — apps/web/locales/{en,id}/auth.json.
 *
 * `POST /login` takes `{ code, state }`: the wire contract the portal implements the other side of
 * is written out in full at the top of ./portal-client.ts, and the `state` is the login-CSRF
 * binding minted by `/auth/start` (./login-state.ts).
 *
 * Reading the cookie: this module reads `request.headers.cookie`, which the HTTP adapter forwards
 * raw (`http-adapter.ts:263`) alongside the cookies it parses for itself.
 */
import { ApiError, isServerMode, reportAuditEvent } from "@agentforge/core";
import type { EnvLike, MembershipRole } from "@agentforge/core";
import type { PortalIdentity, PortalProvisioning } from "@agentforge/db";
import { jsonError, jsonOk } from "../errors";
import type { HostCookie, HostJsonResult, HostRequest } from "../types";
import { PortalError, buildAuthorizeUrl, type PortalTokens } from "./portal-client";
import type { PortalClient } from "./portal-client";
import {
  LOGIN_STATE_MAX_AGE_SECONDS,
  loginStateCookieName,
  mintLoginState,
  readLoginStateCookie,
  statesMatch,
} from "./login-state";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { log } from "../log";
import { WHATSAPP_WEBHOOK_PATH } from "../inbox/webhook-path";
import { EMAIL_WEBHOOK_PATH } from "../channels/email/path";
import { recordTenantModelAllowlist } from "../model-allowance";
import {
  createPortalSessionCheck,
  faultOf,
  type PortalSessionCheck,
  type PortalSessionCheckOptions,
} from "./portal-check";
import type { SignInMode } from "./portal-mode";
import { createSessionSecrets, type SessionSecrets } from "./session-secrets";
import {
  configuredClientCredentials,
  portalClientCredentials,
  portalLoginConfig,
  publicRedirectUri,
} from "./portal-config";
import type { SessionStore, TokenVault } from "./session-store";
import {
  sessionCookieMaxAge,
  sessionCookieName,
  type AuthReason,
  type SessionRecord,
  createSession,
  readSessionCookie,
  revokedSession,
  sessionSummary,
  slidSession,
  verifySession,
} from "./session";

export const AUTH_ROUTE_PREFIX = "/api/v1/auth/";

/** The portal's own sign-out (`apps/portal/src/routes/logout.ts`). */
const PORTAL_LOGOUT_PATH = "/logout";
/** The renderer route a signed-out browser lands on (`apps/web/components/account-session-row.tsx`). */
const SIGNED_OUT_PATH = "/sign-in";
/**
 * The reads that have to answer before anyone can sign in: the health probe the proxy polls, the
 * component status the first-run installer shows (router.ts:186, handlers/components.ts:1-9), and
 * the WhatsApp webhook's handshake. None returns a byte of tenant data: the handshake echoes Meta's
 * challenge only when the caller presents the operator's verify token. Nothing else under `/api` is
 * exempt, for any method.
 */
export const UNGATED_GETS: ReadonlySet<string> = new Set(["/api/v1/ping", "/api/v1/components", WHATSAPP_WEBHOOK_PATH]);

/**
 * Phase 5 lane B: the one POST under `/api` that runs without a session.
 *
 * `isSessionExemptPath` is GET-only outside the auth prefix, by design and with a comment saying
 * so, so this is a deliberate widening and it is kept to a single literal path rather than a
 * prefix: no browser calls the billing webhook, the caller is a payment provider's server, and it
 * authenticates on a shared secret compared in constant time (`../billing/authenticate.ts`).
 * Nothing else may join this set without the same two properties.
 *
 * The WhatsApp webhook is the second member. It is the same shape: a literal path, no browser calls
 * it, and the caller (Meta) authenticates by an HMAC-SHA256 signature over the raw body, checked in
 * constant time before a byte is parsed (`../inbox/webhook.ts`). It also has to be the one thing a
 * stranger on the internet can POST to, which is why the desk it writes to comes from the endpoint
 * row the number id resolves to and never from the payload.
 */
export const UNGATED_POSTS: ReadonlySet<string> = new Set([
  "/api/v1/billing/webhook",
  WHATSAPP_WEBHOOK_PATH,
  EMAIL_WEBHOOK_PATH,
]);

export type AuthRouteDeps = {
  readonly store: SessionStore;
  readonly vault: TokenVault;
  readonly portal: PortalClient;
  /** Hosted deployment? Decides the cookie's `Secure` flag; injected so tests never touch env. */
  readonly serverMode: boolean;
  /**
   * Writes the host's rows for a portal identity on first sign-in (lane C). Injected so a test can
   * exercise the sign-in without a database, the same way `store` and `portal` already are.
   *
   * The identity carries the role the portal sent in the token body, or `null` for none. The host
   * writes exactly that membership role and has no default of its own: no role is a `member`, never
   * an `owner` (SR-65). A sign-in for a person who already has a membership moves it to this role.
   */
  readonly provision: (identity: PortalProvisioning) => Promise<unknown>;
  /**
   * Phase 5 lane B: take a seat for this person, or refuse the sign-in.
   *
   * Sign-in is where a seat cap belongs. The portal already refuses here and already has the
   * reason code (`seat_cap_reached`, which this module has carried English and Indonesian copy for
   * since Phase 2); the gateway gate is the wrong place to discover you have no seat, because by
   * then you are signed in and working (decision doc D5).
   *
   * Injected like `provision`, so a test drives the refusal without a database, and so the
   * desktop — which never signs in — never reaches the store at all. The default supplied by
   * `../auth/index.ts` admits everybody when no cap is configured.
   */
  readonly claimSeat: (identity: PortalIdentity) => Promise<{ readonly ok: boolean }>;
  /**
   * Phase 9: where the portal URL, the client credentials and the public origin are read from.
   * Injected for the same reason `serverMode` is — so a case drives a misconfigured deployment
   * without writing to `process.env` and racing every other file in the suite.
   */
  readonly env?: EnvLike;
  readonly now?: () => number;
  /**
   * The one refresh-at-a-time-per-session path to the portal (`./portal-check.ts`). The hosted
   * server passes the process-wide instance the router's gate uses too, so a refresh and a sign-out
   * can never rotate one token twice. Absent — a test harness — it is built from `vault` and
   * `portal` above.
   */
  readonly portalCheck?: PortalSessionCheck;
  /**
   * Reconciles a membership's role with what the portal sent at a refresh (`./portal-check.ts`
   * `applyRole`). Only used when `portalCheck` is absent and the check is built here; the hosted
   * server's own check (`hostPortalCheck`) is wired with the real one.
   */
  readonly applyRole?: PortalSessionCheckOptions["applyRole"];
  /**
   * The role the host holds for the session's person — the membership row, which is what every
   * authorization check reads — or `null` when there is none to read. Used only by
   * `GET /auth/session`, so the renderer can hide controls the host would refuse anyway (the Erase
   * account button for anybody who is not an owner). A courtesy: the host's refusal is the control.
   * Absent, or answering null or throwing, the answer simply carries no `role`.
   */
  readonly readRole?: (session: SessionRecord) => Promise<MembershipRole | null>;
  /**
   * Seals the refresh token onto the session row at sign-in (`./session-secrets.ts`), so a restart
   * signs nobody out. Defaults to the wrap key this process runs under; the hosted server passes
   * the same instance the portal check uses.
   */
  readonly secrets?: SessionSecrets;
  /**
   * How the portal signs people in (`./portal-mode.ts`), asked of the portal and never guessed. Only
   * `GET /auth/session` uses it, and only to say `signInMode: "password"` when the portal does, so the
   * sign-in screen does not promise an e-mailed code in front of a portal that sends none. Absent, or
   * answering `code`, or throwing, the answer carries no such field and is exactly what it always was.
   * The hosted server passes one; the desktop and webdev never do.
   */
  readonly signInMode?: () => Promise<SignInMode>;
};

/** The doc's own English copy per reason, used when the portal sends none (:409-423). */
const REASON_COPY_EN: Record<AuthReason, string> = {
  tenant_inactive: "Your provider's account is not active. Contact support.",
  org_inactive: "Your organisation is not active.",
  org_past_due: "Your organisation's payment is overdue.",
  user_inactive: "Your account is disabled.",
  seat_cap_reached: "No seats left in your organisation.",
  device_revoked: "This device was signed out by an admin.",
  session_revoked: "You were signed out. Please sign in again.",
  refresh_reused: "Signed out for security. Please sign in again.",
  refresh_expired: "Your session expired. Please sign in again.",
  invalid_request: "The sign-in request was not valid.",
  invalid_grant: "That sign-in link is no longer valid. Start again.",
  session_required: "Please sign in to continue.",
  portal_unavailable: "Cannot reach the sign-in service. Try again.",
};

export function reasonMessage(reason: AuthReason): string {
  return REASON_COPY_EN[reason];
}

/** Reason → the host's `ApiError`, so the envelope and the reason vocabulary stay the same one. */
export function authError(reason: AuthReason, status: number, message?: string | null): ApiError {
  return new ApiError(reason, message || reasonMessage(reason), status);
}

function fromPortal(error: unknown): ApiError {
  if (error instanceof PortalError) {
    return authError(error.reason, error.status, error.messageEn);
  }
  // Matched by name, not `instanceof`: importing the class as a value would pull `@agentforge/db`'s
  // barrel in statically and open SQLite when this module is imported, which the module comment at
  // ./index.ts forbids and `createHostSessionStore` goes out of its way to avoid.
  if (error instanceof Error && error.name === "PortalProvisionError") {
    // The host already holds this org under a different tenant. Never re-home the rows: refuse the
    // sign-in and let an operator look, because one of the two tenants owns that data.
    return authError("org_inactive", 403);
  }
  throw error;
}

/**
 * Calls that run without a session; everything else under `/api` needs one, whatever the method.
 *
 * The method is part of the answer: `GET /api/v1/components` reports what is installed, while
 * `POST /api/v1/components/install/stream` spends the machine's disk and bandwidth.
 */
export function isSessionExemptPath(method: string, path: string): boolean {
  if (path.startsWith(AUTH_ROUTE_PREFIX)) {
    return true;
  }
  const verb = method.toUpperCase();
  if (verb === "POST") {
    return UNGATED_POSTS.has(path);
  }
  return verb === "GET" && UNGATED_GETS.has(path);
}

/**
 * Which cookie name this process reads.
 *
 * `serverMode` is injected everywhere it is known (`createAuthRoutes` has it) and falls back to the
 * environment for the one caller that does not pass it: the router's session gate
 * (`../router.ts`), which resolves the same flag per request one frame up.
 */
type CookieDeps = Pick<AuthRouteDeps, "store" | "now"> & Partial<Pick<AuthRouteDeps, "serverMode">>;

function cookieMode(deps: { readonly serverMode?: boolean }): { readonly secure: boolean } {
  return { secure: deps.serverMode ?? isServerMode() };
}

function sessionIdOf(request: HostRequest, deps: CookieDeps): string | null {
  return readSessionCookie(request.headers.cookie ?? null, cookieMode(deps));
}

/** Verify the cookie against the store, sliding `lastSeenAt` when the 5 minute window has passed. */
export async function loadSession(
  request: HostRequest,
  deps: CookieDeps,
): Promise<{ id: string | null; verdict: ReturnType<typeof verifySession> }> {
  const id = sessionIdOf(request, deps);
  if (!id) {
    return { id: null, verdict: { ok: false, reason: "session_required" } };
  }
  const now = (deps.now ?? Date.now)();
  const verdict = verifySession(await deps.store.find(id), now);
  if (verdict.ok && verdict.slid) {
    await deps.store.save(verdict.session);
  }
  return { id, verdict };
}

/** A verified session from this request's cookie, or the 401 its verdict names. Never asks the portal. */
async function verifiedSession(request: HostRequest, deps: CookieDeps): Promise<SessionRecord> {
  const { verdict } = await loadSession(request, deps);
  if (!verdict.ok) {
    throw authError(verdict.reason, 401);
  }
  return verdict.session;
}

/**
 * The gate: a verified session the portal still vouches for, or an `ApiError` the router turns into
 * the 401 envelope.
 *
 * With `portalCheck`, a session whose last portal check is older than ten minutes is checked again
 * (`./portal-check.ts`): a terminal answer is a 401 carrying the portal's own reason and copy, which
 * the renderer already reads as "this session is over"; no answer lets the request through. The
 * router always passes one in server mode; without one this is the row check alone.
 */
export async function requireSessionFor(
  request: HostRequest,
  deps: CookieDeps & { readonly portalCheck?: PortalSessionCheck },
): Promise<SessionRecord> {
  const session = await verifiedSession(request, deps);
  if (deps.portalCheck) {
    const checked = await deps.portalCheck.gate(session, { store: deps.store, now: deps.now });
    if (!checked.ok) {
      throw authError(checked.reason, 401, checked.message);
    }
    if (checked.gatewayEndpoint !== undefined && checked.gatewayEndpoint !== session.gatewayEndpoint) {
      return { ...session, gatewayEndpoint: checked.gatewayEndpoint };
    }
  }
  return session;
}

/**
 * `HttpOnly; SameSite=Lax; Path=/; Max-Age=<lifetime>` plus `Secure` and the `__Host-` name on the
 * hosted server (A2 / T1, and the hosted XSS audit). The adapter serialises these attributes
 * (`http-adapter.ts:138-146`) and writes no `Domain`, which `__Host-` also requires; this module
 * never builds a `Set-Cookie` string of its own.
 */
function cookieFor(deps: Pick<AuthRouteDeps, "serverMode" | "now">, session: SessionRecord): HostJsonResult["cookies"] {
  const now = (deps.now ?? Date.now)();
  return [
    {
      name: sessionCookieName(cookieMode(deps)),
      value: session.id,
      path: "/",
      sameSite: "Lax",
      httpOnly: true,
      secure: deps.serverMode,
      maxAge: sessionCookieMaxAge(session, now),
    },
  ];
}

function clearedCookie(deps: Pick<AuthRouteDeps, "serverMode">): HostJsonResult["cookies"] {
  return [
    {
      name: sessionCookieName(cookieMode(deps)),
      value: "",
      path: "/",
      sameSite: "Lax",
      httpOnly: true,
      secure: deps.serverMode,
      maxAge: 0,
    },
  ];
}

/**
 * The state cookie `/auth/start` set: same attributes as the session cookie but ten minutes long,
 * and the same `__Host-` split, because a browser on plain http drops the prefixed name silently.
 */
function stateCookieFor(deps: Pick<AuthRouteDeps, "serverMode">, value: string, maxAge: number): HostCookie {
  return {
    name: loginStateCookieName(cookieMode(deps)),
    value,
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
    secure: deps.serverMode,
    maxAge,
  };
}

/**
 * One state, one attempt. The cookie is cleared on **every** answer this route gives — the sign-in
 * that worked, the one the portal refused, and the one whose state did not match — so a state that
 * has been presented once can never be presented again.
 */
function clearedStateCookie(deps: Pick<AuthRouteDeps, "serverMode">): HostCookie {
  return stateCookieFor(deps, "", 0);
}

function readCode(body: unknown): string {
  const code = (body as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    throw authError("invalid_request", 400, "A sign-in code is required.");
  }
  return code.trim();
}

/**
 * The login-CSRF check (plan §Browser flow step 3).
 *
 * Without it anybody who can make a browser POST here plants **their** authorization code in
 * somebody else's browser, and the victim then works inside the attacker's tenant. The comparison
 * is constant time and neither value is ever echoed back: the refusal is the same
 * `invalid_request` whether the state was absent, stale or forged, because telling the caller
 * which one it was is telling an attacker how close they are.
 */
function readState(request: HostRequest, deps: CookieDeps): void {
  const presented = (request.body as { state?: unknown } | undefined)?.state;
  const expected = readLoginStateCookie(request.headers.cookie ?? null, cookieMode(deps));
  if (typeof presented !== "string" || !statesMatch(presented, expected)) {
    throw authError("invalid_request", 400, "This sign-in link has expired. Start again.");
  }
}

/** Handlers catch and return the envelope, exactly like every other handler in `handlers/`. */
function guarded(
  fn: (request: HostRequest) => Promise<HostJsonResult>,
): (request: HostRequest) => Promise<HostJsonResult> {
  return async (request) => {
    try {
      return await fn(request);
    } catch (error) {
      return jsonError(error) as HostJsonResult;
    }
  };
}

function withCookies(result: HostJsonResult, cookies: HostJsonResult["cookies"]): HostJsonResult {
  return { ...result, cookies };
}

export type AuthRoutes = {
  handleStart: (request: HostRequest) => Promise<HostJsonResult>;
  handleLogin: (request: HostRequest) => Promise<HostJsonResult>;
  handleLogout: (request: HostRequest) => Promise<HostJsonResult>;
  handleSession: (request: HostRequest) => Promise<HostJsonResult>;
  handleRefresh: (request: HostRequest) => Promise<HostJsonResult>;
};

export function createAuthRoutes(deps: AuthRouteDeps): AuthRoutes {
  const clock = () => (deps.now ?? Date.now)();
  const env = (): EnvLike => deps.env ?? process.env;
  const secrets = deps.secrets ?? createSessionSecrets(() => getLocalVaultKey());
  const check =
    deps.portalCheck ??
    createPortalSessionCheck({
      vault: deps.vault,
      portal: deps.portal,
      secrets,
      // The same client the code exchange authenticates as, from the same environment.
      clientCredentials: () => configuredClientCredentials(env()),
      applyRole: deps.applyRole,
    });
  const checkContext = { store: deps.store, now: deps.now };

  /**
   * The refresh token sealed for the new row, or null. A sign-in whose token cannot be sealed still
   * signs in — the session works as sessions did before the token was kept at rest, and signs out
   * at the first restart — and says so, rather than failing a person for a deployment fault.
   */
  function sealForSignIn(session: SessionRecord, tokens: PortalTokens): string | null {
    try {
      return secrets.seal(session.id, { refreshToken: tokens.refreshToken, deviceId: tokens.deviceId });
    } catch (error) {
      log.error("session_refresh_not_sealed", { tenantId: session.tenantId, fault: faultOf(error) });
      return null;
    }
  }

  async function endSession(session: SessionRecord, at: number): Promise<void> {
    await deps.store.save(revokedSession(session, at));
    await deps.vault.delete(session.id);
  }

  /**
   * End the PORTAL's session behind this one, best effort, never throwing.
   *
   * The access token the vault holds is the one from the last rotation, and it lives an hour: a
   * sign-out after an idle afternoon used to present an expired one, the portal answered 401, and
   * the refusal was swallowed, so the portal session — and its refresh token — outlived the
   * sign-out. So refresh first, through the same single-flight path the gate uses, and sign out with
   * the live token that comes back. A terminal answer or an empty vault means there is no portal
   * session left to end; no answer at all still tries the token held, which may be inside its hour.
   */
  async function endPortalSession(session: SessionRecord): Promise<void> {
    // Read before the refresh, and only for its access token: after a restart the vault is empty
    // while the row still holds a sealed refresh token, which `check.refresh` opens itself.
    const held = await deps.vault.get(session.id);
    const outcome = await check.refresh(session, checkContext);
    const accessToken =
      outcome.kind === "rotated"
        ? outcome.tokens.accessToken
        : outcome.kind === "unanswered"
          ? (held?.accessToken ?? null)
          : null;
    if (accessToken === null) {
      return;
    }
    try {
      await deps.portal.logout({ accessToken });
    } catch (error) {
      log.warn("portal_logout_failed", {
        code: error instanceof PortalError ? error.reason : "unknown",
        tenantId: session.tenantId,
      });
    }
  }

  /**
   * Hop one of the browser sign-in: mint a state, keep it where no page script can read it, and
   * say where to send the person.
   *
   * Hosted only, and a 404 rather than a refusal off server mode — exactly what the billing webhook
   * does, and for the same reason: webdev and the desktop have no portal, no client credentials and
   * no public origin, and a desk should not learn that this route exists elsewhere.
   */
  const handleStart = guarded(async () => {
    if (!deps.serverMode) {
      throw new ApiError("not_found", "Not found", 404);
    }
    // Before the state is minted: a misconfigured deployment sets no cookie at all.
    const config = portalLoginConfig(env());
    const state = mintLoginState();
    const authorizeUrl = buildAuthorizeUrl({
      baseUrl: config.portalBaseUrl,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
    });
    return jsonOk({ authorizeUrl }, 200, [stateCookieFor(deps, state, LOGIN_STATE_MAX_AGE_SECONDS)]);
  });

  const exchange = guarded(async (request: HostRequest) => {
    const code = readCode(request.body);
    // Before any portal call, and before the code is read as anything but a string: a request that
    // cannot prove it started at this deployment's own `/auth/start` is not worth a round trip.
    readState(request, deps);
    const credentials = portalClientCredentials(env());
    const redirectUri = publicRedirectUri(env());
    let tokens: PortalTokens;
    try {
      tokens = await deps.portal.exchangeCode({ code, redirectUri, ...credentials });
    } catch (error) {
      // F2: the portal refused or never answered — the failure itself is audited. The tenant is not
      // yet known here, so the row carries the unattributable placeholder rather than nothing.
      reportAuditEvent({
        tenantId: "unknown",
        event: "auth.sign_in",
        actorKind: "user",
        outcome: "failed",
      });
      throw fromPortal(error);
    }
    const now = clock();
    // Phase 3 lane C: first sign-in is what provisions the tenant. The portal has just vouched for
    // these three ids, so this is the one moment the host may write rows for them; every later
    // request only ever READS them (`resolvePortalTenant`), which is what makes a session the host
    // has never provisioned a refusal rather than a new desk. Off server mode nothing signs in, so
    // the desktop never reaches this line.
    const identity: PortalIdentity = {
      tenantId: tokens.tenantId,
      orgId: tokens.orgId,
      userId: tokens.userId,
    };
    try {
      // The role is the portal's, read from the token body by `toTokens` (`null` when it sent none
      // the host recognises). It rides only into provisioning: the seat claim below is about a
      // person, not a privilege, and the session carries no role at all — it is read from the
      // membership row on each request.
      await deps.provision({ ...identity, role: tokens.role });
    } catch (error) {
      reportAuditEvent({
        tenantId: tokens.tenantId,
        event: "auth.sign_in",
        actorKind: "user",
        actorId: tokens.userId,
        outcome: "failed",
      });
      throw fromPortal(error);
    }
    // Phase 5 lane B, and in this order deliberately: provisioning writes the tenant row the seat
    // has a foreign key to, so the seat cannot be claimed before the tenant exists. A refusal here
    // leaves the rows provisioning wrote — they are the portal's facts about who this person is,
    // and they are what an admin raising the cap or revoking a seat acts on. No session is created
    // and no cookie is set, so the browser is exactly as signed out as it was.
    const seat = await deps.claimSeat(identity);
    if (!seat.ok) {
      reportAuditEvent({
        tenantId: tokens.tenantId,
        event: "auth.sign_in",
        actorKind: "user",
        actorId: tokens.userId,
        outcome: "denied",
        rule: "seat_cap_reached",
      });
      throw authError("seat_cap_reached", 403);
    }
    const session = createSession({
      tenantId: tokens.tenantId,
      userId: tokens.userId,
      orgId: tokens.orgId,
      gatewayEndpoint: tokens.gatewayEndpoint,
      now,
    });
    // The tenant's model allowlist arrives beside the token; a portal that sends none (`null`)
    // leaves the desk's own setting governing instead.
    recordTenantModelAllowlist(tokens.tenantId, tokens.modelAllowlist);
    // The row and its sealed refresh token in one insert; the access token only in process memory.
    await deps.store.create(session, sealForSignIn(session, tokens));
    await deps.vault.put(session.id, {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      deviceId: tokens.deviceId,
    });
    reportAuditEvent({
      tenantId: session.tenantId,
      event: "auth.sign_in",
      actorKind: "user",
      actorId: session.userId,
      outcome: "ok",
    });
    return jsonOk(sessionSummary(session), 200, cookieFor(deps, session));
  });

  /**
   * The state is spent whatever happened, so the clearing cookie rides on every answer — the
   * success, the portal's refusal and the mismatch alike. Appended here rather than inside
   * `exchange` because `guarded` turns a thrown `ApiError` into an envelope with no cookies at all,
   * and a failure that left the state behind would leave it replayable.
   */
  const handleLogin = async (request: HostRequest): Promise<HostJsonResult> => {
    const result = await exchange(request);
    return { ...result, cookies: [...(result.cookies ?? []), clearedStateCookie(deps)] };
  };

  /**
   * Where to send the browser after the local sign-out, so the PORTAL's own session ends too.
   *
   * Clearing this deployment's cookie is only half of a sign-out: the portal keeps a 30-day
   * browser session of its own, and while it is live `GET /authorize` answers with a code and no
   * OTP at all — so on a shared browser the next person to press "Sign in" was signed in as the
   * person who just left (`docs/internal/security-register.md`, SR-21). The portal's `/logout`
   * clears that cookie and redirects back, and it only redirects to a URI on an origin the client
   * has registered, which is this deployment's own.
   *
   * `null` rather than a throw when sign-in is not configured: a desk with no portal still signs
   * out locally, and the renderer falls back to its own `/sign-in`.
   */
  function portalLogoutUrl(): string | null {
    try {
      const config = portalLoginConfig(env());
      const url = new URL(`${config.portalBaseUrl}${PORTAL_LOGOUT_PATH}`);
      url.searchParams.set("client_id", config.clientId);
      // The callback's origin, with the sign-in path — `redirectUri` is built from
      // `AGENTFORGE_PUBLIC_URL`, which is the origin the portal has in its allowlist.
      url.searchParams.set("post_logout_redirect_uri", new URL(SIGNED_OUT_PATH, config.redirectUri).toString());
      return url.toString();
    } catch {
      return null;
    }
  }

  function signedOutBody(): Record<string, unknown> {
    const portalLogout = portalLogoutUrl();
    return { signedIn: false, ...(portalLogout ? { portalLogoutUrl: portalLogout } : {}) };
  }

  const handleLogout = guarded(async (request: HostRequest) => {
    const id = sessionIdOf(request, deps);
    const session = id ? await deps.store.find(id) : null;
    if (!session) {
      // Idempotent: a stale or absent cookie still leaves the browser signed out — and still needs
      // the portal hop, because the portal cookie can outlive this one.
      return jsonOk(signedOutBody(), 200, clearedCookie(deps));
    }
    try {
      await endPortalSession(session);
    } finally {
      // Whatever the portal said, or failed to say, this deployment's session ends here.
      await endSession(session, clock());
    }
    reportAuditEvent({
      tenantId: session.tenantId,
      event: "auth.sign_out",
      actorKind: "user",
      actorId: session.userId,
      outcome: "ok",
    });
    return jsonOk(signedOutBody(), 200, clearedCookie(deps));
  });

  /** The membership role for the answer, or none. Never throws: a role we cannot read is no role, not a 500. */
  async function roleForAnswer(session: SessionRecord): Promise<MembershipRole | null> {
    if (!deps.readRole) {
      return null;
    }
    try {
      return await deps.readRole(session);
    } catch (error) {
      log.warn("session_role_not_read", { tenantId: session.tenantId, fault: faultOf(error) });
      return null;
    }
  }

  /**
   * `{ signInMode: "password" }` when the portal says it signs people in with a password, and nothing
   * at all otherwise, so the answer in the default mode is byte for byte what it was. Never throws: a
   * mode the host cannot learn is the default, which is what the screen has always said.
   */
  async function modeFields(): Promise<{ readonly signInMode?: "password" }> {
    if (!deps.signInMode) {
      return {};
    }
    try {
      return (await deps.signInMode()) === "password" ? { signInMode: "password" } : {};
    } catch {
      return {};
    }
  }

  const handleSession = guarded(async (request: HostRequest) => {
    const { id, verdict } = await loadSession(request, deps);
    const mode = await modeFields();
    if (verdict.ok) {
      const role = await roleForAnswer(verdict.session);
      return jsonOk({
        ...(role ? { ...sessionSummary(verdict.session), role } : sessionSummary(verdict.session)),
        ...mode,
      });
    }
    // A visitor who never signed in is not an error and gets no reason to render.
    return jsonOk({ ...(id === null ? { signedIn: false } : { signedIn: false, reason: verdict.reason }), ...mode });
  });

  /**
   * Through the same single-flight path as the gate (`./portal-check.ts`), which also applies the
   * answer: the rotated pair to the vault, or the session ended here. This handler only says so.
   */
  const handleRefresh = guarded(async (request: HostRequest) => {
    // Not `requireSessionFor`: its portal check would rotate once, and this route again.
    const session = await verifiedSession(request, deps);
    const outcome = await check.refresh(session, checkContext);
    switch (outcome.kind) {
      case "no_tokens":
        // Nothing to present to the portal — the host restarted since this browser signed in.
        throw authError("refresh_expired", 401);
      case "ended":
        // Terminal: the portal says this session is over, so it is.
        return withCookies(jsonError(fromPortal(outcome.error)) as HostJsonResult, clearedCookie(deps));
      case "unanswered":
        // Offline, rate-limited or misrouted, not refused: the session survives.
        throw fromPortal(outcome.error);
      case "rotated": {
        const extended = slidSession(session, clock());
        await deps.store.save(extended);
        return jsonOk(sessionSummary(extended), 200, cookieFor(deps, extended));
      }
    }
  });

  return { handleStart, handleLogin, handleLogout, handleSession, handleRefresh };
}
