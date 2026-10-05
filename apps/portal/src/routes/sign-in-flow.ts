/**
 * The e-mail step and the two second steps of both browser sign-ins, shared by `/authorize/*` and
 * `/activate/*` so the two doors cannot drift.
 *
 *   POST .../email          an address (or "send me a new code", or "use a different e-mail")
 *   POST .../invite         the address and the invite code that was e-mailed to it
 *   POST .../invite/resend  "e-mail me my invite again"
 *
 * The decisions are `flows/sign-in.ts`'s. What is here is the translation to a page: which screen,
 * which status, which sentence -- and the rate limits that stand in for the neutral page the e-mail
 * step used to be (owner decision 2026-10-01, SR-30). Because the step now tells a person whether
 * an address is a member, an invitee or neither, it is limited per IP and per address before it
 * looks anything up, so a sweep of addresses is not cheap.
 *
 * The routes keep what is theirs: the CSRF check, the client / device-code validation, and the
 * values every form of that flow carries forward (`spec.hidden`). Nothing here ever puts an
 * address, a code or a state in a URL.
 */
import { normaliseEmail } from "../crypto";
import { beginSignIn, resendInvite, submitInvite, type SignInState } from "../flows/sign-in";
import type { PortalRuntime } from "../flows/context";
import { OTP_TTL_MINUTES } from "../otp/send";
import { boundedField, stringField } from "../security/body";
import { htmlResponse } from "../security/headers";
import type { OtpPurpose } from "../store/types";
import type { PortalResponse } from "../server";
import { type Vars, waitText } from "../views/i18n";
import { enterCodePage, inviteCodePage, signInPage, statePage } from "../views/pages";
import { MAX_EMAIL_LENGTH } from "../flows/authorize";
import { ensureCsrf, htmlError, limit, type RequestContext } from "./support";

export interface SignInSpec {
  readonly purpose: OtpPurpose;
  /** The OAuth client's tenant on `/authorize`, the pending device code's on `/activate`. */
  readonly requiredTenantId: string | null;
  readonly paths: {
    readonly email: string;
    readonly invite: string;
    readonly inviteResend: string;
    readonly verify: string;
  };
  /** What every form of this flow carries forward: the OAuth parameters, or the `user_code`. */
  readonly hidden: Readonly<Record<string, string>>;
  /** Extra `form-action` origins -- the client's, on `/authorize` only (SR-20). */
  readonly formActionOrigins: readonly string[];
}

/** An invite code is 20 characters in groups of five; anything past this is junk and is cut. */
export const MAX_INVITE_FIELD_LENGTH = 64;

type Fields = Readonly<Record<string, unknown>>;

function minutesFor(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

function respond(
  csrf: { readonly cookie: string | undefined },
  spec: SignInSpec,
  body: string,
  options: { readonly status?: number; readonly retryAfter?: number } = {},
): PortalResponse {
  return htmlResponse(body, {
    status: options.status ?? 200,
    cookie: csrf.cookie,
    formActionOrigins: spec.formActionOrigins,
    headers: options.retryAfter === undefined ? undefined : { "retry-after": String(options.retryAfter) },
  });
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

export function emailEntryResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  options: { readonly email?: string; readonly error?: string; readonly status?: number } = {},
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    signInPage({
      locale: context.locale,
      t: context.t,
      action: spec.paths.email,
      csrfToken: csrf.token,
      hidden: spec.hidden,
      email: options.email,
      error: options.error,
    }),
    { status: options.status },
  );
}

export function codeEntryResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  input: {
    readonly email: string;
    readonly lead: string;
    readonly error?: string;
    readonly notice?: string;
    readonly status?: number;
    readonly retryAfter?: number;
  },
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    enterCodePage({
      locale: context.locale,
      t: context.t,
      action: spec.paths.verify,
      resendAction: spec.paths.email,
      restartAction: spec.paths.email,
      csrfToken: csrf.token,
      hidden: spec.hidden,
      email: input.email,
      lead: input.lead,
      error: input.error,
      notice: input.notice,
    }),
    { status: input.status, retryAfter: input.retryAfter },
  );
}

function inviteEntryResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  input: {
    readonly email: string;
    readonly error?: string;
    readonly notice?: string;
    readonly status?: number;
    readonly retryAfter?: number;
  },
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    inviteCodePage({
      locale: context.locale,
      t: context.t,
      action: spec.paths.invite,
      resendAction: spec.paths.inviteResend,
      restartAction: spec.paths.email,
      csrfToken: csrf.token,
      hidden: spec.hidden,
      email: input.email,
      error: input.error,
      notice: input.notice,
    }),
    { status: input.status, retryAfter: input.retryAfter },
  );
}

/**
 * The sentence under a dead end's title. The seat-cap page does not restate the reason: it says
 * what the portal already says for `seat_cap_reached` (`reason.*`, the one copy the JSON error
 * bodies and the redirect page also read) and adds only what to do about it.
 */
function deadEndMessage(context: RequestContext, key: string, vars?: Vars): string {
  return key === "seatCap"
    ? `${context.t("reason.seat_cap_reached")} ${context.t("state.seatCap.next")}`
    : context.t(`state.${key}.body`, vars);
}

function deadEndResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  key: "expired" | "noAccess" | "inviteLocked" | "otpLocked" | "seatCap",
  status: number,
  vars?: Vars,
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    statePage({
      locale: context.locale,
      t: context.t,
      title: context.t(`state.${key}.title`),
      message: deadEndMessage(context, key, vars),
      restartAction: spec.paths.email,
      csrfToken: csrf.token,
      hidden: spec.hidden,
    }),
    { status },
  );
}

/** One state, one page. The switch is exhaustive, so a new state is a compile error here. */
function respondTo(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  email: string,
  state: SignInState,
): PortalResponse {
  const { t } = context;
  switch (state.kind) {
    case "code_sent":
      return codeEntryResponse(runtime, context, spec, {
        email,
        lead: t(state.afterInvite ? "sent.bodyAfterInvite" : "sent.body", { email, minutes: OTP_TTL_MINUTES }),
      });
    case "code_wait":
      return codeEntryResponse(runtime, context, spec, {
        email,
        lead: t("sent.bodyWait", { email }),
        notice: t(state.why === "cooldown" ? "sent.cooldown" : "sent.limited", {
          minutes: minutesFor(state.retryAfter),
        }),
        status: 429,
        retryAfter: state.retryAfter,
      });
    case "code_mail_failed":
      return codeEntryResponse(runtime, context, spec, {
        email,
        lead: t("sent.bodyFailed", { email }),
        notice: t("sent.mailFailed"),
        status: 503,
      });
    case "invite_required": {
      const notice = state.notice;
      return inviteEntryResponse(runtime, context, spec, {
        email,
        notice:
          notice === null
            ? undefined
            : notice.kind === "resent"
              ? t("invite.resent")
              : notice.kind === "wait"
                ? t("invite.wait", { minutes: minutesFor(notice.retryAfter) })
                : t("invite.mailFailed"),
        status: notice?.kind === "wait" ? 429 : notice?.kind === "mail_failed" ? 503 : 200,
        retryAfter: notice?.kind === "wait" ? notice.retryAfter : undefined,
      });
    }
    case "invite_wrong":
      return inviteEntryResponse(runtime, context, spec, {
        email,
        error: t("invite.wrong", { attempts: state.attemptsRemaining }),
        status: 400,
      });
    case "invite_unusable":
      return deadEndResponse(runtime, context, spec, "expired", 200);
    case "invite_locked":
      return deadEndResponse(runtime, context, spec, "inviteLocked", 429);
    case "otp_locked":
      return deadEndResponse(runtime, context, spec, "otpLocked", 429, {
        wait: waitText(t, state.retryAfter),
      });
    case "no_access":
      return deadEndResponse(runtime, context, spec, "noAccess", 200);
    case "seat_cap_reached":
      // 403, not 200: unlike "ask your admin to invite you", this is a refusal with a known
      // cause that only an admin can lift, and nothing was spent finding out.
      return deadEndResponse(runtime, context, spec, "seatCap", 403);
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/**
 * The e-mail step's limits, on top of the per-IP page budget the route has already spent: the
 * send limit every sign-in post always met, plus the two strict ones the step needs now that its
 * answer depends on who the address is. All of them count the request whatever the outcome, and
 * none depends on the address existing.
 */
function emailStepAllowed(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  email: string,
): boolean {
  const { limiters } = runtime;
  const address = `${spec.requiredTenantId ?? "-"}|${email}`;
  return limit(
    [limiters.otpSendIp, context.ipKey],
    [limiters.signInEmailIp, context.ipKey],
    [limiters.signInEmailAddress, address],
  ).ok;
}

function rateLimited(context: RequestContext): PortalResponse {
  return htmlError(context, "error.rateLimited", { status: 429 });
}

function readEmail(fields: Fields): string | null {
  const typed = boundedField(fields, "email", MAX_EMAIL_LENGTH);
  return typed === null ? null : normaliseEmail(typed);
}

// ---------------------------------------------------------------------------
// The three posts
// ---------------------------------------------------------------------------

function deps(runtime: PortalRuntime) {
  return { store: runtime.store, mailer: runtime.mailer, log: runtime.log, clock: runtime.clock };
}

/** `POST .../email`: the first step, "send me a new code", and "use a different e-mail". */
export async function handleEmailStep(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  fields: Fields,
): Promise<PortalResponse> {
  if (stringField(fields, "restart") !== null) {
    return emailEntryResponse(runtime, context, spec);
  }
  const email = readEmail(fields);
  if (email === null) {
    return emailEntryResponse(runtime, context, spec, { error: context.t("signIn.emailMissing"), status: 400 });
  }
  if (!emailStepAllowed(runtime, context, spec, email)) {
    return rateLimited(context);
  }

  const state = await beginSignIn(deps(runtime), {
    email,
    requiredTenantId: spec.requiredTenantId,
    purpose: spec.purpose,
    locale: context.locale,
    ip: context.ip,
    resend: stringField(fields, "resend") !== null,
  });
  return respondTo(runtime, context, spec, email, state);
}

/** `POST .../invite`: the invite code the person was e-mailed. */
export async function handleInviteStep(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  fields: Fields,
): Promise<PortalResponse> {
  const email = readEmail(fields);
  if (email === null) {
    return emailEntryResponse(runtime, context, spec, { error: context.t("signIn.emailMissing"), status: 400 });
  }
  const inviteCode = stringField(fields, "invite_code")?.slice(0, MAX_INVITE_FIELD_LENGTH) ?? null;
  if (inviteCode === null) {
    return inviteEntryResponse(runtime, context, spec, {
      email,
      error: context.t("invite.missing"),
      status: 400,
    });
  }
  // Counted BEFORE the work, whatever the outcome: counting only refusals afterwards left a window
  // in which a parallel burst got through ten at a time. A valid code is rare enough that counting
  // it too costs nobody anything.
  if (!runtime.limiters.inviteAttemptIp.check(context.ipKey).ok) {
    return rateLimited(context);
  }

  const state = await submitInvite(deps(runtime), {
    email,
    inviteCode,
    requiredTenantId: spec.requiredTenantId,
    purpose: spec.purpose,
    locale: context.locale,
    ip: context.ip,
  });
  return respondTo(runtime, context, spec, email, state);
}

/** `POST .../invite/resend`: "e-mail me my invite again". */
export async function handleInviteResend(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: SignInSpec,
  fields: Fields,
): Promise<PortalResponse> {
  const email = readEmail(fields);
  if (email === null) {
    return emailEntryResponse(runtime, context, spec, { error: context.t("signIn.emailMissing"), status: 400 });
  }
  if (!emailStepAllowed(runtime, context, spec, email)) {
    return rateLimited(context);
  }

  const state = await resendInvite(deps(runtime), {
    email,
    requiredTenantId: spec.requiredTenantId,
    purpose: spec.purpose,
    locale: context.locale,
    ip: context.ip,
  });
  return respondTo(runtime, context, spec, email, state);
}
