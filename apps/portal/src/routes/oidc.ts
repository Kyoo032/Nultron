/**
 * `GET /auth/oidc/<provider>/start` and `GET /auth/oidc/<provider>/callback`: the OIDC
 * Authorization Code + PKCE sign-in (F8b). Routes exist only for providers that are configured;
 * an unconfigured provider id is the server's own 404.
 *
 * `start` validates the door the same way that door always validates (the OAuth client and its
 * `redirect_uri` on `/authorize`, the pending device code on `/activate`), seals the round-trip
 * secrets into `oidc_login_states`, and sends the browser to the provider. `callback` consumes
 * the state, exchanges the code (client secret in the POST body, never in a URL), verifies the
 * ID token end to end, matches the verified e-mail (or an existing (issuer, subject) binding) to
 * a seat, and finishes on the same tail a code or password sign-in finishes on.
 */
import type { PortalRuntime } from "../flows/context";
import { type AuthorizeParams, checkClient, readAuthorizeParams } from "../flows/authorize";
import { mustChangePasswordFirst, webSessionCookieFor } from "../flows/web-session";
import { hashEquals, normaliseUserCode, sha256 } from "../crypto";
import { createDiscovery, type OidcDiscovery } from "../oidc/discovery";
import { createJwks } from "../oidc/jwks";
import { mintPkce } from "../oidc/pkce";
import { sealJson, unsealJson } from "../oidc/seal";
import { type OidcProvider, type OidcProviderId, oidcProviders } from "../oidc/providers";
import { verifyIdToken } from "../oidc/verify-id-token";
import { serialiseCookie } from "../security/cookies";
import { redirectResponse } from "../security/headers";
import type { PortalRequest, PortalResponse, PortalRoute } from "../server";
import type { PortalOps, User } from "../store/types";
import { completeSignIn } from "./authorize";
import { htmlError, limit, requestContext } from "./support";

/** How long a `start` -> `callback` round trip may take. */
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_FETCH_TIMEOUT_MS = 10_000;

export interface OidcSsoLink {
  readonly provider: OidcProviderId;
  readonly href: string;
}

export interface OidcSeams {
  /** The fetch behind discovery, JWKS and the token exchange; tests pass a stub IdP's. */
  readonly fetchImpl?: typeof fetch;
  /** The verifier, swapped in by the route test so it can mint tokens without JWKS. */
  readonly verifyIdTokenImpl?: typeof verifyIdToken;
}

type Door =
  | { readonly kind: "authorize"; readonly params: AuthorizeParams }
  | { readonly kind: "activate"; readonly userCode: string | null };

/** What `code_verifier_sealed` carries: the verifier and the door context the callback resumes. */
interface SealedState {
  readonly v: string;
  readonly d: "a" | "c";
  readonly p: Record<string, string>;
}

/**
 * The "Sign in with …" buttons a sign-in page offers, one per configured provider, pointing at
 * `start` with this door's own context. Empty when no provider is configured.
 */
export function oidcSsoLinks(runtime: PortalRuntime, door: Door): readonly OidcSsoLink[] {
  // On the activate door a link without a pending code can only fail at `start`: bare `/activate`
  // gets no buttons, and `start` would have nothing to resume anyway.
  if (door.kind === "activate" && !door.userCode) {
    return [];
  }
  const providers = oidcProviders(runtime.config.oidc);
  const links: OidcSsoLink[] = [];
  for (const provider of providers.values()) {
    const query = new URLSearchParams();
    if (door.kind === "authorize") {
      query.set("door", "authorize");
      if (door.params.responseType) query.set("response_type", door.params.responseType);
      if (door.params.clientId) query.set("client_id", door.params.clientId);
      if (door.params.redirectUri) query.set("redirect_uri", door.params.redirectUri);
      if (door.params.state) query.set("state", door.params.state);
    } else {
      query.set("door", "activate");
      // Named `code`, the parameter the deploy proxy strips from its request logs.
      query.set("code", door.userCode as string);
    }
    links.push({ provider: provider.id, href: `/auth/oidc/${provider.id}/start?${query.toString()}` });
  }
  return links;
}

/**
 * The tenant flag that replaces `/activate`'s e-mail page with the IdP's: when
 * `tenant_config.feature_flags.sso_provider` names a configured provider, that is the only
 * sign-in the door offers (`spec: "the tenant OIDC provider that /activate redirects to"`).
 */
export async function oidcRedirectForActivate(
  runtime: PortalRuntime,
  tenantId: string | null,
  userCode: string | null,
): Promise<PortalResponse | null> {
  if (!tenantId) {
    return null;
  }
  const providerName = await runtime.store.tx(
    tenantId,
    async (ops) => (await ops.tenantConfig.get(tenantId))?.featureFlags.sso_provider ?? null,
  );
  if (!providerName) {
    return null;
  }
  const provider = oidcProviders(runtime.config.oidc).get(providerName as OidcProviderId);
  if (!provider) {
    return null;
  }
  const links = oidcSsoLinks(runtime, { kind: "activate", userCode });
  const link = links.find((entry) => entry.provider === provider.id);
  return link ? redirectResponse(link.href) : null;
}

export function oidcRoutes(runtime: PortalRuntime, seams: OidcSeams = {}): readonly PortalRoute[] {
  const fetchImpl = seams.fetchImpl ?? fetch;
  const verify = seams.verifyIdTokenImpl ?? verifyIdToken;
  const discovery = createDiscovery(() => runtime.clock.now().getTime(), fetchImpl);
  const jwks = createJwks(() => runtime.clock.now().getTime(), fetchImpl);
  const providers = oidcProviders(runtime.config.oidc);

  const routes: PortalRoute[] = [];
  for (const provider of providers.values()) {
    routes.push({
      method: "GET",
      path: `/auth/oidc/${provider.id}/start`,
      handle: (request) => startOidc(runtime, provider, discovery, request),
    });
    routes.push({
      method: "GET",
      path: `/auth/oidc/${provider.id}/callback`,
      handle: (request) => callbackOidc(runtime, provider, discovery, jwks, verify, fetchImpl, request),
    });
  }
  return Object.freeze(routes);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startOidc(
  runtime: PortalRuntime,
  provider: OidcProvider,
  discovery: ReturnType<typeof createDiscovery>,
  request: PortalRequest,
): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  if (!limit([runtime.limiters.oidcStartIp, context.ipKey]).ok) {
    return htmlError(context, "error.rateLimited", { status: 429 });
  }

  // The door context is validated exactly as the door validates it: nothing is stored, and the
  // browser is not sent anywhere, before the client and its redirect_uri (or the pending user
  // code) have checked out.
  const doorKind = request.query.get("door");
  let door: Door;
  let tenantId: string;
  if (doorKind === "authorize") {
    const params = readAuthorizeParams(request.query);
    const client = await checkClient(runtime, params);
    if (!client.ok) {
      return htmlError(context, `reason.${client.reason}`, { status: 400 });
    }
    door = { kind: "authorize", params };
    tenantId = client.tenantId;
  } else if (doorKind === "activate") {
    const raw = request.query.get("code");
    const userCode = raw === null ? null : normaliseUserCode(raw);
    const resolved = userCode === null ? null : await runtime.store.resolve.byUserCode(userCode);
    if (!userCode || !resolved) {
      return htmlError(context, "oidc.error", { status: 400 });
    }
    const live = await runtime.store.tx(resolved, async (ops) => {
      const code = await ops.deviceCodes.findByUserCode(userCode);
      return code?.status === "pending" && new Date(code.expiresAt) > runtime.clock.now();
    });
    if (!live) {
      return htmlError(context, "oidc.error", { status: 400 });
    }
    door = { kind: "activate", userCode };
    tenantId = resolved;
  } else {
    return htmlError(context, "oidc.error", { status: 400 });
  }

  const document = await discovery.get(provider.discoveryUrl).catch(() => null);
  if (!document) {
    return htmlError(context, "oidc.unavailable", { status: 503 });
  }

  const pkce = mintPkce();
  const sealed = sealJson(runtime.keys.current, sealedFor(door, pkce.codeVerifier));
  await runtime.store.tx(tenantId, (ops) =>
    ops.oidc.createState({
      tenantId,
      stateHash: sha256(pkce.state),
      nonceHash: sha256(pkce.nonce),
      sealed,
      provider: provider.id,
      expiresAt: new Date(runtime.clock.now().getTime() + STATE_TTL_MS),
    }),
  );

  const target = new URL(document.authorizationEndpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", provider.clientId);
  target.searchParams.set("redirect_uri", callbackUri(runtime, provider));
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", pkce.state);
  target.searchParams.set("nonce", pkce.nonce);
  target.searchParams.set("code_challenge", pkce.codeChallenge);
  target.searchParams.set("code_challenge_method", "S256");
  // The browser binding: `callback` requires `sha256(state)` back in this cookie, so a callback
  // link clicked in a browser that never started the sign-in cannot mint a session there.
  const txCookie = serialiseCookie(runtime.cookies.oidcTx, sha256(pkce.state).toString("base64url"), {
    secure: runtime.secureCookies,
    maxAgeSeconds: STATE_TTL_MS / 1000,
  });
  return redirectResponse(target.toString(), { cookie: txCookie });
}

function sealedFor(door: Door, verifier: string): SealedState {
  if (door.kind === "authorize") {
    return {
      v: verifier,
      d: "a",
      p: {
        response_type: door.params.responseType ?? "",
        client_id: door.params.clientId ?? "",
        redirect_uri: door.params.redirectUri ?? "",
        state: door.params.state ?? "",
      },
    };
  }
  return { v: verifier, d: "c", p: { user_code: door.userCode ?? "" } };
}

function callbackUri(runtime: PortalRuntime, provider: OidcProvider): string {
  return `${runtime.issuer}/auth/oidc/${provider.id}/callback`;
}

// ---------------------------------------------------------------------------
// callback
// ---------------------------------------------------------------------------

async function callbackOidc(
  runtime: PortalRuntime,
  provider: OidcProvider,
  discovery: ReturnType<typeof createDiscovery>,
  jwks: ReturnType<typeof createJwks>,
  verify: typeof verifyIdToken,
  fetchImpl: typeof fetch,
  request: PortalRequest,
): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  if (!limit([runtime.limiters.oidcCallbackIp, context.ipKey]).ok) {
    return htmlError(context, "error.rateLimited", { status: 429 });
  }

  const failed = (key: string, status = 400): PortalResponse => htmlError(context, key, { status });

  const state = request.query.get("state");
  const code = request.query.get("code");
  if (request.query.get("error") !== null || !state || !code || code.length > 4096) {
    return failed("oidc.denied");
  }
  // The state must also come back in the cookie `start` set: a valid callback arriving in a
  // browser that never started the sign-in is a planted session, not a resumed one.
  const txCookie = context.cookies[runtime.cookies.oidcTx];
  if (!txCookie || !hashEquals(sha256(state), Buffer.from(txCookie, "base64url"))) {
    return failed("oidc.denied");
  }
  const stateHash = sha256(state);
  const tenantId = await runtime.store.resolve.byOidcState(stateHash);
  if (!tenantId) {
    return failed("oidc.denied");
  }

  // Single-use: a replayed callback (or a second tab) finds the row gone.
  const stored = await runtime.store.tx(tenantId, (ops) => ops.oidc.consumeState(tenantId, stateHash));
  if (!stored || stored.provider !== provider.id) {
    return failed("oidc.denied");
  }
  const sealed = unsealJson(runtime.keys.current, stored.sealed) as SealedState | null;
  if (!sealed || typeof sealed.v !== "string" || (sealed.d !== "a" && sealed.d !== "c")) {
    return failed("oidc.denied");
  }

  const document = await discovery.get(provider.discoveryUrl).catch(() => null);
  if (!document) {
    return failed("oidc.unavailable", 503);
  }

  const idToken = await exchangeCode(document, provider, callbackUri(runtime, provider), code, sealed.v, fetchImpl);
  if (!idToken) {
    await runtime.store.tx(tenantId, (ops) => denyOps(ops, tenantId, null, "oidc_token_exchange", context.ip));
    return failed("oidc.denied");
  }

  const verified = await verify(
    idToken,
    {
      provider,
      expectedNonceHash: stored.nonceHash,
      expectedAudience: provider.clientId,
      nowSeconds: Math.floor(runtime.clock.now().getTime() / 1000),
    },
    (kid) => jwks.getKey(document.jwksUri, kid),
  );
  if (!verified.ok) {
    await runtime.store.tx(tenantId, (ops) => denyOps(ops, tenantId, null, `oidc_token_${verified.reason}`, context.ip));
    return failed("oidc.denied");
  }

  const claims = verified.claims;
  const subject = claims.sub as string;
  const issuer = claims.iss as string;
  const email = provider.emailFromClaims(claims);

  // Who the session is for: an existing (issuer, subject) binding first, then the seat the
  // provider's verified e-mail matches. Neither is a sign-in; there is no JIT account creation.
  const matched = await runtime.store.tx(tenantId, async (ops) => {
    const boundId = await ops.oidc.findUserByIdentity(tenantId, issuer, subject);
    const member = boundId ? await ops.users.findById(boundId) : null;
    const candidate = member ?? (email === null ? null : await ops.users.findByEmail(tenantId, email));
    if (!candidate) {
      await denyOps(ops, tenantId, null, "oidc_no_member", context.ip);
      return { kind: "none" as const };
    }
    if (candidate.status !== "active") {
      await denyOps(ops, tenantId, candidate, "user_not_active", context.ip);
      return { kind: "none" as const };
    }
    const org = await ops.orgs.findById(candidate.orgId);
    const ssoRequired = org?.ssoRequired === true && candidate.role !== "owner";
    if (ssoRequired) {
      // Mandatory SSO names its provider through `tenant_config.feature_flags.sso_provider`:
      // sign-in through another enabled provider is not the SSO the org required.
      const named = (await ops.tenantConfig.get(tenantId))?.featureFlags.sso_provider;
      if (named && named !== provider.id) {
        await denyOps(ops, tenantId, candidate, "oidc_wrong_provider", context.ip);
        return { kind: "none" as const };
      }
    }
    if (!boundId) {
      // First sign-in through this provider: a seat check before the binding exists, the same
      // arithmetic `beginSignIn` applies before a code is ever sent.
      if (!(await ops.orgs.hasSeatFor(candidate.orgId, candidate.id))) {
        await denyOps(ops, tenantId, candidate, "seat_cap_reached", context.ip);
        return { kind: "none" as const };
      }
      await ops.oidc.bindIdentity({ tenantId, userId: candidate.id, issuer, subject });
    }
    return { kind: "member" as const, member: candidate, ssoRequired };
  });
  if (matched.kind === "none") {
    return failed("oidc.denied");
  }

  const member = matched.member;
  await runtime.store.tx(tenantId, async (ops) => {
    await ops.audit.append({
      tenantId,
      orgId: member.orgId,
      actorKind: "user",
      actorUserId: member.id,
      action: "oidc.sign_in",
      targetKind: "user",
      targetId: member.id,
      after: { provider: provider.id },
      ip: context.ip,
    });
  });

  // `orgs.sso_required` leaves a non-owner no password door: a pending forced change can never
  // be satisfied by them, so the provider's proof stands in for it. Everyone else keeps it.
  const mustChangeExempt = matched.ssoRequired;

  if (sealed.d === "a") {
    const params = readAuthorizeParams({ get: (name) => sealed.p[name] ?? null });
    // Validated again on this hop: a client or redirect_uri withdrawn while the browser was at
    // the provider must not receive the authorization code the callback is about to mint.
    const client = await checkClient(runtime, params);
    if (!client.ok || client.tenantId !== tenantId) {
      return failed("oidc.denied");
    }
    const response = await completeSignIn(runtime, context, params, tenantId, member.id, {
      mustChangeExempt,
    });
    return response ?? failed("oidc.denied");
  }

  // The activate door: the cookie is minted on the code sign-in's own install-id shape, and the
  // browser re-hits `GET /activate` which now sees the live session and the pending code. A
  // pending forced change gets no cookie -- the code door's own sign-in holds it to the change.
  const userCode = sealed.p.user_code;
  const landing = `/activate?code=${encodeURIComponent(userCode)}`;
  const cookie = await runtime.store.tx(tenantId, async (ops) => {
    if (!mustChangeExempt && (await mustChangePasswordFirst(runtime, ops, member.id))) {
      return null;
    }
    return webSessionCookieFor(runtime, ops, {
      tenantId,
      userId: member.id,
      orgId: member.orgId,
      installId: `web-client-activate-${member.id}`,
    });
  });
  return cookie ? redirectResponse(landing, { cookie }) : redirectResponse(landing);
}

/** A `login.denied` row inside the resolved tenant -- the failure half of AC-8b.5's audit pair. */
function denyOps(ops: PortalOps, tenantId: string, member: User | null, reasonCode: string, ip: string | null) {
  return ops.audit.append({
    tenantId,
    orgId: member?.orgId,
    actorKind: "system",
    action: "login.denied",
    targetKind: "user",
    targetId: member?.id,
    reasonCode,
    ip,
  });
}

/** The code -> token exchange: client secret in the POST body, never in a URL. */
async function exchangeCode(
  document: OidcDiscovery,
  provider: OidcProvider,
  redirectUri: string,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: verifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(document.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const idToken = parsed?.id_token;
  return typeof idToken === "string" && idToken.length <= 16_384 ? idToken : null;
}
