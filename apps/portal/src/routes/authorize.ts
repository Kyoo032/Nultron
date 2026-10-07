/**
 * The browser login: `GET /authorize`, then the posts of the sign-in.
 *
 *   GET  /authorize                 validate the client -> signed in? redirect with a code : e-mail form
 *   POST /authorize/email           the e-mail step: the portal decides what comes next
 *   POST /authorize/invite          an invitee's invite code (a valid one leads to the e-mailed code)
 *   POST /authorize/invite/resend   "e-mail me my invite again"
 *   POST /authorize/verify          check the e-mailed code -> login gate -> 302 with code+state, or ?error=
 *
 * What the e-mail step decides, and what it says, is `flows/sign-in.ts` and `sign-in-flow.ts`.
 *
 * The client and the `redirect_uri` are re-validated on **every one of those posts**, not just the
 * first. The values travel in hidden fields so they stay out of the URL bar and out of any
 * `Referer`, and a hidden field is a field the user edits -- so it is re-checked against the
 * registered allowlist each time, exactly as if it had just arrived in the query string.
 */
import {
  checkClient,
  issueAuthorizationCode,
  readAuthorizeParams,
  redirectWithCode,
  redirectWithError,
  type AuthorizeParams,
  MAX_EMAIL_LENGTH,
} from "../flows/authorize";
import type { PortalRuntime } from "../flows/context";
import { runBrowserLoginGate, webInstallId } from "../flows/login";
import { redirectErrorReason } from "../flows/reasons";
import { verifyLoginOtp } from "../otp/verify";
import { OTP_TTL_MINUTES } from "../otp/send";
import { normaliseEmail } from "../crypto";
import { mustChangePasswordFirst, versionIsLive, webSessionCookieFor } from "../flows/web-session";
import { boundedField, stringField } from "../security/body";
import { redirectResponse } from "../security/headers";
import type { WebSession } from "../security/web-session";
import type { PortalRequest, PortalResponse, PortalRoute } from "../server";
import { handleChangeStep, handlePasswordStep, passwordEntryResponse, type PasswordSpec } from "./password-flow";
import {
  codeEntryResponse,
  emailEntryResponse,
  handleEmailStep,
  handleInviteResend,
  handleInviteStep,
  type SignInSpec,
} from "./sign-in-flow";
import {
  codeErrorMessage,
  csrfOk,
  htmlError,
  limit,
  readForm,
  requestContext,
  type RequestContext,
} from "./support";

const EMAIL_PATH = "/authorize/email";
const INVITE_PATH = "/authorize/invite";
const INVITE_RESEND_PATH = "/authorize/invite/resend";
const VERIFY_PATH = "/authorize/verify";
/** Password sign-in (`PORTAL_SIGNIN_MODE=password`) has these two posts instead of the four above. */
const PASSWORD_PATH = "/authorize/password";
const PASSWORD_CHANGE_PATH = "/authorize/password/change";

const CLIENT_ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  invalid_request: "error.badRequest",
  invalid_client: "error.invalidClient",
  invalid_redirect: "error.invalidRedirect",
});

/** The three values that travel across every post. An address and a code never ride here. */
function hiddenFor(params: AuthorizeParams): Readonly<Record<string, string>> {
  return {
    response_type: "code",
    client_id: params.clientId ?? "",
    redirect_uri: params.redirectUri ?? "",
    state: params.state ?? "",
  };
}

/**
 * The one extra `form-action` source a page in this flow carries.
 *
 * **Only call this after `checkClient` has returned ok on the same params.** The value it returns
 * is the client's `redirect_uri`, which by then has been exact-matched against that client's
 * registered allowlist; `security/headers.ts` reduces it to `new URL(x).origin` and refuses
 * anything that is not an http(s) origin. Before that check the `redirect_uri` is attacker input
 * and naming it in a policy would be the same mistake as redirecting to it.
 *
 * It has to be named at all because a browser applies `form-action` to every hop of a
 * submission's redirect chain, and the successful `POST /authorize/verify` ends on the client's
 * origin. With `'self'` alone Chromium blocks the post and the page simply does nothing.
 */
function clientFormAction(params: AuthorizeParams): readonly string[] {
  return params.redirectUri ? [params.redirectUri] : [];
}

/** Built only after `checkClient` has returned ok, for the reason `clientFormAction` gives. */
function specFor(params: AuthorizeParams, tenantId: string): SignInSpec {
  return {
    purpose: "portal_login",
    requiredTenantId: tenantId,
    paths: { email: EMAIL_PATH, invite: INVITE_PATH, inviteResend: INVITE_RESEND_PATH, verify: VERIFY_PATH },
    hidden: hiddenFor(params),
    formActionOrigins: clientFormAction(params),
  };
}

/** The same, for the password sign-in's two posts. Built only after `checkClient` has returned ok. */
function passwordSpecFor(params: AuthorizeParams, tenantId: string): PasswordSpec {
  return {
    requiredTenantId: tenantId,
    paths: { password: PASSWORD_PATH, change: PASSWORD_CHANGE_PATH },
    hidden: hiddenFor(params),
    formActionOrigins: clientFormAction(params),
  };
}

function paramsFromFields(fields: Readonly<Record<string, unknown>>): AuthorizeParams {
  return readAuthorizeParams({
    get: (name) => {
      const value = fields[name];
      return typeof value === "string" ? value : null;
    },
  });
}

export function authorizeRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  if (runtime.config.signInMode === "password") {
    // The e-mail, invite and verify posts are not registered at all, so they answer as any other
    // path that does not exist: the server's own 404.
    return [
      { method: "GET", path: "/authorize", handle: (request) => getAuthorize(runtime, request) },
      {
        method: "POST",
        path: PASSWORD_PATH,
        handle: (request) => authorizePost(runtime, request, (flow) => postPassword(runtime, flow)),
      },
      {
        method: "POST",
        path: PASSWORD_CHANGE_PATH,
        handle: (request) => authorizePost(runtime, request, (flow) => postPasswordChange(runtime, flow)),
      },
    ];
  }
  return [
    { method: "GET", path: "/authorize", handle: (request) => getAuthorize(runtime, request) },
    {
      method: "POST",
      path: EMAIL_PATH,
      handle: (request) => authorizePost(runtime, request, (flow) => handleEmailStep(runtime, flow.context, flow.spec, flow.fields)),
    },
    {
      method: "POST",
      path: INVITE_PATH,
      handle: (request) => authorizePost(runtime, request, (flow) => handleInviteStep(runtime, flow.context, flow.spec, flow.fields)),
    },
    {
      method: "POST",
      path: INVITE_RESEND_PATH,
      handle: (request) => authorizePost(runtime, request, (flow) => handleInviteResend(runtime, flow.context, flow.spec, flow.fields)),
    },
    { method: "POST", path: VERIFY_PATH, handle: (request) => authorizePost(runtime, request, (flow) => postVerify(runtime, flow)) },
  ];
}

async function getAuthorize(runtime: PortalRuntime, request: PortalRequest): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  if (!limit([runtime.limiters.authorizeIp, context.ipKey]).ok) {
    return htmlError(context, "error.rateLimited", { status: 429 });
  }

  const params = readAuthorizeParams(request.query);
  const client = await checkClient(runtime, params);
  if (!client.ok) {
    // Nothing redirects here. An unvalidated redirect_uri is an open redirect, and this one would
    // eventually carry an authorization code.
    return htmlError(context, CLIENT_ERROR_COPY[client.reason]);
  }

  const session = context.webSession;
  if (session && session.tenantId === client.tenantId) {
    // `resume` is what makes the 30-day convenience revocable: the cookie's version is compared
    // against `web_session_versions` inside the same transaction that reads the user, so a
    // `POST /auth/logout { all_devices: true }` ends it here on the very next request (SR-21).
    const done = await completeSignIn(runtime, context, params, client.tenantId, session.userId, {
      resume: session,
    });
    if (done) {
      return done;
    }
    // The session's user no longer exists (removed, or the company erased), its cookie has been
    // revoked, or it is for another tenant's user: fall through to the form rather than answering
    // an error nobody can act on. A removed member is then told what any stranger is told.
  }

  if (runtime.config.signInMode === "password") {
    return passwordEntryResponse(runtime, context, passwordSpecFor(params, client.tenantId));
  }
  return emailEntryResponse(runtime, context, specFor(params, client.tenantId));
}

interface AuthorizeFlow {
  readonly context: RequestContext;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly params: AuthorizeParams;
  readonly spec: SignInSpec;
  readonly password: PasswordSpec;
}

/**
 * What every post of this flow does first, in the order that is the security property: the body is
 * parsed, the CSRF token must match, the per-IP page budget is spent, and the client and its
 * `redirect_uri` are validated **again** from the hidden fields. Only then does a handler run.
 */
async function authorizePost(
  runtime: PortalRuntime,
  request: PortalRequest,
  handle: (flow: AuthorizeFlow) => Promise<PortalResponse>,
): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  const body = readForm(request);
  if (!body.ok) {
    return htmlError(context, "error.badRequest", { status: body.reason === "too_large" ? 413 : 400 });
  }
  if (!csrfOk(runtime, context, body.fields)) {
    return htmlError(context, "error.expiredForm", { status: 403 });
  }
  if (!limit([runtime.limiters.authorizeIp, context.ipKey]).ok) {
    return htmlError(context, "error.rateLimited", { status: 429 });
  }

  const params = paramsFromFields(body.fields);
  const client = await checkClient(runtime, params);
  if (!client.ok) {
    return htmlError(context, CLIENT_ERROR_COPY[client.reason]);
  }
  return handle({
    context,
    fields: body.fields,
    params,
    spec: specFor(params, client.tenantId),
    password: passwordSpecFor(params, client.tenantId),
  });
}

/**
 * `POST /authorize/password`: the password sign-in's whole first step. A person who is in goes down
 * exactly the road a verified e-mailed code does -- `completeSignIn`: the login gate (seat cap,
 * disabled, past due), an authorization code, the portal's own session cookie, the 302 -- so what the
 * app receives is the same and needs no new trust decision.
 */
async function postPassword(runtime: PortalRuntime, flow: AuthorizeFlow): Promise<PortalResponse> {
  const step = await handlePasswordStep(runtime, flow.context, flow.password, flow.fields);
  if (step.kind === "response") {
    return step.response;
  }
  const done = await completeSignIn(runtime, flow.context, flow.params, step.tenantId, step.user.id);
  return done ?? htmlError(flow.context, "error.generic", { status: 500 });
}

/** `POST /authorize/password/change`: the forced change, and the same tail once it holds. */
async function postPasswordChange(runtime: PortalRuntime, flow: AuthorizeFlow): Promise<PortalResponse> {
  const step = await handleChangeStep(runtime, flow.context, flow.password, flow.fields);
  if (step.kind === "response") {
    return step.response;
  }
  const done = await completeSignIn(runtime, flow.context, flow.params, step.tenantId, step.user.id);
  return done ?? htmlError(flow.context, "error.generic", { status: 500 });
}

async function postVerify(runtime: PortalRuntime, flow: AuthorizeFlow): Promise<PortalResponse> {
  const { context, fields, params, spec } = flow;
  const typed = boundedField(fields, "email", MAX_EMAIL_LENGTH);
  const email = typed === null ? null : normaliseEmail(typed);
  const code = stringField(fields, "code");
  if (!email) {
    return emailEntryResponse(runtime, context, spec, { error: context.t("signIn.emailMissing"), status: 400 });
  }
  if (!code) {
    return retryCode(runtime, context, spec, email, context.t("code.missing"));
  }

  const verified = await verifyLoginOtp(
    { store: runtime.store, log: runtime.log, clock: runtime.clock },
    {
      email,
      code,
      requiredTenantId: spec.requiredTenantId,
      purpose: "portal_login",
      ip: context.ip,
    },
  );
  if (!verified.ok) {
    return retryCode(runtime, context, spec, email, codeErrorMessage(context, verified));
  }

  const done = await completeSignIn(runtime, context, params, verified.tenantId, verified.user.id);
  return done ?? htmlError(context, "error.generic", { status: 500 });
}

/** A refused code: the same screen, with the reason and the way to ask again. */
function retryCode(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  email: string,
  error: string,
): PortalResponse {
  return codeEntryResponse(runtime, context, spec, {
    email,
    lead: context.t("sent.body", { email, minutes: OTP_TTL_MINUTES }),
    error,
    status: 400,
  });
}

/**
 * The shared tail: login gate, authorization code, 302.
 *
 * A gate denial redirects with `?error=<reason>` rather than rendering, so the product's own
 * sign-in screen shows the copy -- which is where `seat_cap_reached` belongs, next to the admin
 * who can free a seat. `null` means the session's user has gone and the caller should render the
 * form instead.
 */
async function completeSignIn(
  runtime: PortalRuntime,
  context: RequestContext,
  params: AuthorizeParams,
  tenantId: string,
  userId: string,
  options: { readonly resume?: WebSession } = {},
): Promise<PortalResponse | null> {
  const clientId = params.clientId as string;
  const redirectUri = params.redirectUri as string;
  const state = params.state ?? "";
  const installId = webInstallId(clientId);

  const outcome = await runtime.store.tx(tenantId, async (ops) => {
    // Before the user is even read: a cookie whose version is behind the stored one was revoked,
    // and "sign in again" is the only honest answer.
    if (options.resume && !(await versionIsLive(ops, options.resume))) {
      return { kind: "unknown_user" as const };
    }
    const user = await ops.users.findById(userId);
    if (!user) {
      return { kind: "unknown_user" as const };
    }
    // A cookie is not a way past the forced change: a person still owed a new password is shown the
    // form (password mode only; a sign-in that has just proved the password is never in this branch).
    if (options.resume && (await mustChangePasswordFirst(runtime, ops, userId))) {
      return { kind: "unknown_user" as const };
    }
    const gate = await runBrowserLoginGate(ops, { tenantId, user, installId });
    if (!gate.ok) {
      await ops.audit.append({
        tenantId,
        orgId: user.orgId,
        actorKind: "user",
        actorUserId: user.id,
        action: "login.denied",
        targetKind: "user",
        targetId: user.id,
        reasonCode: gate.reason,
        ip: context.ip,
      });
      return { kind: "denied" as const, reason: gate.reason };
    }
    const code = await issueAuthorizationCode(ops, {
      tenantId,
      user,
      device: gate.device,
      clientId,
      redirectUri,
      state,
      ip: context.ip,
    });
    // Minted inside the same transaction that issued the code, so the version it carries is the
    // one that was live when this sign-in happened.
    const cookie = await webSessionCookieFor(runtime, ops, {
      tenantId,
      userId: user.id,
      orgId: user.orgId,
      installId,
    });
    return { kind: "ok" as const, code, cookie };
  });

  if (outcome.kind === "unknown_user") {
    return null;
  }
  if (outcome.kind === "denied") {
    return redirectResponse(redirectWithError(redirectUri, redirectErrorReason(outcome.reason), state));
  }

  return redirectResponse(redirectWithCode(redirectUri, outcome.code, state), {
    cookie: outcome.cookie,
  });
}
