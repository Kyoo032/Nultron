/**
 * `GET /activate` and the approval it leads to -- the browser half of the device-code flow.
 *
 *   GET  /activate?code=K7M4-PQ9T   sign in (if needed), then Approve / Deny
 *   POST /activate/email            the e-mail step: the portal decides what comes next
 *   POST /activate/invite           an invitee's invite code
 *   POST /activate/invite/resend    "e-mail me my invite again"
 *   POST /activate/verify           check the e-mailed code, then show Approve / Deny
 *   POST /auth/device/approve       the decision (form from this page, or JSON per the doc)
 *
 * The three sign-in posts are the same functions `/authorize/*` uses (`sign-in-flow.ts`), so the
 * invite gate and its limits are one decision and this door is not a way round the other.
 *
 * The approve screen shows the requesting device's `platform` and `label` **from the
 * `device_codes` row**, never from the query string: the browser is a different party from the
 * device and must not be able to restate what the device claimed
 * (`device-code-login.md`, "Device metadata sent at registration").
 *
 * A signed-in person is told who the portal thinks they are, with a way out ("Not you? Sign out").
 * "Signed in" here means a cookie whose version is current AND a member who still exists and is
 * active (`liveWebSessionUser`): a removed member's old cookie is refused like no cookie at all.
 */
import { normaliseEmail, normaliseUserCode } from "../crypto";
import type { PortalRuntime } from "../flows/context";
import { decideDeviceCode, type ApproveDecision } from "../flows/device";
import { errorBody, statusFor } from "../flows/reasons";
import { OTP_TTL_MINUTES } from "../otp/send";
import { verifyLoginOtp } from "../otp/verify";
import { MAX_EMAIL_LENGTH } from "../flows/authorize";
import { liveWebSessionUser, webSessionCookieFor } from "../flows/web-session";
import { boundedField, stringField } from "../security/body";
import { htmlResponse } from "../security/headers";
import type { PortalRequest, PortalResponse, PortalRoute } from "../server";
import type { DeviceCode } from "../store/types";
import { approvePage, outcomePage, userCodePage, type AccountBanner } from "../views/pages";
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
  ensureCsrf,
  htmlError,
  jsonResponse,
  limit,
  readForm,
  readJson,
  requestContext,
  wantsJson,
  type RequestContext,
} from "./support";
import { LOGOUT_PATH } from "./logout";

const ACTIVATE_PATH = "/activate";
const EMAIL_PATH = "/activate/email";
const INVITE_PATH = "/activate/invite";
const INVITE_RESEND_PATH = "/activate/invite/resend";
const VERIFY_PATH = "/activate/verify";
const APPROVE_PATH = "/auth/device/approve";
/** `XXXX-XXXX`, or the eight characters without the dash. */
const MAX_USER_CODE_LENGTH = 9;

export function activateRoutes(runtime: PortalRuntime): readonly PortalRoute[] {
  return [
    { method: "GET", path: ACTIVATE_PATH, handle: (request) => getActivate(runtime, request) },
    {
      method: "POST",
      path: EMAIL_PATH,
      handle: (request) => activatePost(runtime, request, (flow) => handleEmailStep(runtime, flow.context, flow.spec, flow.fields)),
    },
    {
      method: "POST",
      path: INVITE_PATH,
      handle: (request) => activatePost(runtime, request, (flow) => handleInviteStep(runtime, flow.context, flow.spec, flow.fields)),
    },
    {
      method: "POST",
      path: INVITE_RESEND_PATH,
      handle: (request) => activatePost(runtime, request, (flow) => handleInviteResend(runtime, flow.context, flow.spec, flow.fields)),
    },
    { method: "POST", path: VERIFY_PATH, handle: (request) => activatePost(runtime, request, (flow) => postVerify(runtime, flow)) },
    { method: "POST", path: APPROVE_PATH, handle: (request) => postApprove(runtime, request) },
  ];
}

/** The pending row behind a `user_code`, inside its own tenant's scope. */
async function loadPending(
  runtime: PortalRuntime,
  userCode: string | null,
): Promise<{ readonly tenantId: string; readonly code: DeviceCode } | null> {
  if (!userCode) {
    return null;
  }
  const normalised = normaliseUserCode(userCode);
  const tenantId = await runtime.store.resolve.byUserCode(normalised);
  if (!tenantId) {
    return null;
  }
  const code = await runtime.store.tx(tenantId, (ops) => ops.deviceCodes.findByUserCode(normalised));
  if (code?.status !== "pending" || new Date(code.expiresAt) <= runtime.clock.now()) {
    return null;
  }
  return { tenantId, code };
}

function specFor(userCode: string | null, tenantId: string | null): SignInSpec {
  return {
    purpose: "activate",
    requiredTenantId: tenantId,
    paths: { email: EMAIL_PATH, invite: INVITE_PATH, inviteResend: INVITE_RESEND_PATH, verify: VERIFY_PATH },
    hidden: { user_code: userCode ?? "" },
    // Nothing leaves this origin on the device-code screens: no client redirect to name.
    formActionOrigins: [],
  };
}

function accountFor(email: string, csrfToken: string): AccountBanner {
  return { email, signOutAction: LOGOUT_PATH, csrfToken };
}

function approveScreen(
  context: RequestContext,
  pending: { readonly code: DeviceCode },
  cookie: string | undefined,
  csrfToken: string,
  account: AccountBanner,
): PortalResponse {
  return htmlResponse(
    approvePage({
      locale: context.locale,
      t: context.t,
      action: APPROVE_PATH,
      csrfToken,
      userCode: pending.code.userCode,
      platform: context.t(`platform.${pending.code.platform ?? "unknown"}`),
      deviceLabel: pending.code.clientName,
      account,
    }),
    { cookie },
  );
}

function userCodeScreen(
  context: RequestContext,
  userCode: string | null,
  cookie: string | undefined,
  csrfToken: string,
  account: AccountBanner,
): PortalResponse {
  return htmlResponse(
    userCodePage({
      locale: context.locale,
      t: context.t,
      action: ACTIVATE_PATH,
      csrfToken,
      userCode: userCode ?? undefined,
      error: userCode ? context.t("approve.unknownCode") : undefined,
      account,
    }),
    { status: userCode ? 400 : 200, cookie },
  );
}

async function getActivate(runtime: PortalRuntime, request: PortalRequest): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  if (!limit([runtime.limiters.authorizeIp, context.ipKey]).ok) {
    return htmlError(context, "error.rateLimited", { status: 429 });
  }

  const asked = request.query.get("code");
  const userCode = asked && asked.length <= MAX_USER_CODE_LENGTH ? asked : null;
  const pending = await loadPending(runtime, userCode);
  const csrf = ensureCsrf(runtime, context);

  if (pending) {
    await runtime.store.tx(pending.tenantId, (ops) =>
      ops.audit.append({
        tenantId: pending.tenantId,
        actorKind: "system",
        action: "activate.viewed",
        targetKind: "device_code",
        targetId: pending.code.id,
        ip: context.ip,
      }),
    );
  }

  // A cookie is not a session until its version has been checked and its member found active
  // (SR-21): a revoked one, or one for a member who has been removed, falls through to the sign-in
  // form exactly as an absent one does.
  const member = await liveWebSessionUser(runtime, context.webSession);
  if (!member || !context.webSession) {
    return emailEntryResponse(runtime, context, specFor(userCode, pending?.tenantId ?? null));
  }

  const account = accountFor(member.email, csrf.token);
  if (pending && pending.tenantId === context.webSession.tenantId) {
    return approveScreen(context, pending, csrf.cookie, csrf.token, account);
  }
  return userCodeScreen(context, userCode, csrf.cookie, csrf.token, account);
}

interface ActivateFlow {
  readonly context: RequestContext;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly userCode: string | null;
  readonly pending: { readonly tenantId: string; readonly code: DeviceCode } | null;
  readonly spec: SignInSpec;
}

/** Body, CSRF, the per-IP page budget, then the pending device code the flow belongs to. */
async function activatePost(
  runtime: PortalRuntime,
  request: PortalRequest,
  handle: (flow: ActivateFlow) => Promise<PortalResponse>,
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

  const userCode = boundedField(body.fields, "user_code", MAX_USER_CODE_LENGTH);
  // "the tenant is resolved before a code is minted -- from device_codes.tenant_id when ?code=
  // carried a tenant_hint" (device-code-login.md, GET /activate).
  const pending = await loadPending(runtime, userCode);
  return handle({
    context,
    fields: body.fields,
    userCode,
    pending,
    spec: specFor(userCode, pending?.tenantId ?? null),
  });
}

async function postVerify(runtime: PortalRuntime, flow: ActivateFlow): Promise<PortalResponse> {
  const { context, fields, userCode, pending, spec } = flow;
  const typed = boundedField(fields, "email", MAX_EMAIL_LENGTH);
  const email = typed === null ? null : normaliseEmail(typed);
  const code = stringField(fields, "code");

  if (!email) {
    return emailEntryResponse(runtime, context, spec, { error: context.t("signIn.emailMissing"), status: 400 });
  }
  const retry = (message: string): PortalResponse =>
    codeEntryResponse(runtime, context, spec, {
      email,
      lead: context.t("sent.body", { email, minutes: OTP_TTL_MINUTES }),
      error: message,
      status: 400,
    });
  if (!code) {
    return retry(context.t("code.missing"));
  }

  const verified = await verifyLoginOtp(
    { store: runtime.store, log: runtime.log, clock: runtime.clock },
    { email, code, requiredTenantId: pending?.tenantId ?? null, purpose: "activate", ip: context.ip },
  );
  if (!verified.ok) {
    return retry(codeErrorMessage(context, verified));
  }

  // The session cookie is the response's one Set-Cookie, so the CSRF token already in the
  // browser is reused rather than reminted.
  const csrf = ensureCsrf(runtime, context);
  const cookie = await runtime.store.tx(verified.tenantId, (ops) =>
    webSessionCookieFor(runtime, ops, {
      tenantId: verified.tenantId,
      userId: verified.user.id,
      orgId: verified.user.orgId,
      installId: `web-client-activate-${verified.user.id}`,
    }),
  );

  const account = accountFor(verified.user.email, csrf.token);
  if (pending && pending.tenantId === verified.tenantId) {
    return approveScreen(context, pending, cookie, csrf.token, account);
  }
  return userCodeScreen(context, userCode, cookie, csrf.token, account);
}

async function postApprove(runtime: PortalRuntime, request: PortalRequest): Promise<PortalResponse> {
  const context = requestContext(runtime, request);
  const json = wantsJson(request);
  const body = json ? readJson(request) : readForm(request);
  if (!body.ok) {
    return json
      ? jsonResponse(statusFor("invalid_request"), errorBody("invalid_request"))
      : htmlError(context, "error.badRequest", { status: 400 });
  }

  const member = await liveWebSessionUser(runtime, context.webSession);
  const session = member ? context.webSession : null;
  if (!session) {
    return json
      ? jsonResponse(statusFor("invalid_client"), errorBody("invalid_client"))
      : htmlError(context, "error.expiredForm", { status: 401 });
  }
  // The doc: "authenticated by the portal session cookie + CSRF token". Both halves, both shapes.
  if (!csrfOk(runtime, context, body.fields)) {
    return json
      ? jsonResponse(statusFor("invalid_request"), errorBody("invalid_request"))
      : htmlError(context, "error.expiredForm", { status: 403 });
  }
  if (!limit([runtime.limiters.approveUser, session.userId]).ok) {
    return json
      ? jsonResponse(statusFor("rate_limited"), errorBody("rate_limited"))
      : htmlError(context, "error.rateLimited", { status: 429 });
  }

  const userCode = boundedField(body.fields, "user_code", MAX_USER_CODE_LENGTH);
  const raw = stringField(body.fields, "decision");
  const decision: ApproveDecision = raw === "deny" ? "deny" : "approve";
  if (!userCode || (raw !== "deny" && raw !== "approve")) {
    return json
      ? jsonResponse(statusFor("invalid_request"), errorBody("invalid_request"))
      : htmlError(context, "error.badRequest", { status: 400 });
  }

  const result = await decideDeviceCode(runtime, {
    userCode: normaliseUserCode(userCode),
    decision,
    tenantId: session.tenantId,
    userId: session.userId,
    ip: context.ip,
  });

  if (!result.ok) {
    return json
      ? jsonResponse(statusFor(result.reason), errorBody(result.reason))
      : htmlResponse(
          outcomePage({
            locale: context.locale,
            t: context.t,
            title: context.t("error.title"),
            message: context.t(`reason.${result.reason}`),
          }),
          { status: statusFor(result.reason) },
        );
  }

  if (json) {
    return jsonResponse(200, { status: result.status, device_label: result.deviceLabel });
  }
  const approved = result.status === "approved";
  return htmlResponse(
    outcomePage({
      locale: context.locale,
      t: context.t,
      title: context.t(approved ? "approved.title" : "denied.title"),
      message: context.t(approved ? "approved.body" : "denied.body"),
    }),
  );
}
