/**
 * The two posts of the password sign-in, shared by `/authorize/*` and `/activate/*` so the two doors
 * cannot drift (`PORTAL_SIGNIN_MODE=password`).
 *
 *   POST .../password           a username or an address, and a password
 *   POST .../password/change    the current password, and a new one (when the credential says to)
 *
 * The decisions are `flows/password-sign-in.ts`'s. What is here is the translation to a page: which
 * screen, which status, which sentence -- and the budgets that stand in front of the work. They are
 * spent BEFORE the account is looked up, whatever the outcome, so a refusal says nothing about the
 * account: 20 posts per 15 minutes per source, 10 per identifier per source (a real account or not), on
 * top of the per-IP page budget the door has already spent. A source is an IPv4 address or an IPv6
 * /56 (`sourceBucket`), so a network that owns 2^72 addresses is one source. The identifier budget is
 * per source on purpose: shared by all sources it would let anyone spend a named person's budget.
 * Behind them, `503` when eight sign-ins are already deriving (`PasswordHasher.admit`).
 *
 * The routes keep what is theirs: the CSRF check and the client / device-code validation, and the
 * values every form of that flow carries forward (`spec.hidden`). Nothing here puts an identifier or a
 * password in a URL, a log line, an audit row or a page. The only value a page gets back is the
 * identifier, and only to save a retype.
 */
import { changePasswordAndSignIn, normaliseIdentifier, signInWithPassword } from "../flows/password-sign-in";
import type { PortalRuntime } from "../flows/context";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordRefusal } from "../password/policy";
import { boundedField } from "../security/body";
import { sourceBucket } from "../security/client-ip";
import { htmlResponse } from "../security/headers";
import type { User } from "../store/types";
import type { PortalResponse } from "../server";
import { changePasswordPage, passwordSignInPage } from "../views/pages";
import { MAX_EMAIL_LENGTH } from "../flows/authorize";
import { ensureCsrf, limit, type RequestContext } from "./support";

export interface PasswordSpec {
  /** The OAuth client's tenant on `/authorize`, the pending device code's on `/activate`. */
  readonly requiredTenantId: string | null;
  readonly paths: { readonly password: string; readonly change: string };
  /** What every form of this flow carries forward: the OAuth parameters, or the `user_code`. */
  readonly hidden: Readonly<Record<string, string>>;
  /** Extra `form-action` origins -- the client's, on `/authorize` only (SR-20). */
  readonly formActionOrigins: readonly string[];
}

type Fields = Readonly<Record<string, unknown>>;

/** What a step ends in: a person who is in, or a page to send back. */
export type PasswordStepResult =
  | { readonly kind: "signed_in"; readonly tenantId: string; readonly user: User }
  | { readonly kind: "response"; readonly response: PortalResponse };

function respond(
  csrf: { readonly cookie: string | undefined },
  spec: PasswordSpec,
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

export function passwordEntryResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  options: {
    readonly identifier?: string;
    readonly error?: string;
    readonly status?: number;
    readonly retryAfter?: number;
  } = {},
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    passwordSignInPage({
      locale: context.locale,
      t: context.t,
      action: spec.paths.password,
      csrfToken: csrf.token,
      hidden: spec.hidden,
      identifier: options.identifier,
      error: options.error,
    }),
    { status: options.status, retryAfter: options.retryAfter },
  );
}

function changeEntryResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  options: {
    readonly identifier: string;
    readonly error?: string;
    readonly status?: number;
    readonly retryAfter?: number;
  },
): PortalResponse {
  const csrf = ensureCsrf(runtime, context);
  return respond(
    csrf,
    spec,
    changePasswordPage({
      locale: context.locale,
      t: context.t,
      action: spec.paths.change,
      csrfToken: csrf.token,
      hidden: spec.hidden,
      identifier: options.identifier,
      minLength: PASSWORD_MIN_LENGTH,
      error: options.error,
    }),
    { status: options.status, retryAfter: options.retryAfter },
  );
}

/**
 * The change screen for a person who has just proved their password and then turned out to owe a new one:
 * the credential was flagged (`reset-password`) after the password check and before the sign-in ended, so
 * the end of the sign-in (`completeSignIn`, `signedInOnActivate`) found `must_change` and issued nothing.
 * The same screen the forced change opens on, with the identifier typed back and no error: the person did
 * nothing wrong.
 */
export function changeRequiredResponse(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  fields: Fields,
): PortalResponse {
  return changeEntryResponse(runtime, context, spec, {
    identifier: boundedField(fields, "identifier", MAX_EMAIL_LENGTH) ?? "",
  });
}

function refusalCopy(context: RequestContext, reason: PasswordRefusal): string {
  return context.t(`change.refusal.${reason}`, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/**
 * Where a request comes from, for everything the password sign-in counts: an IPv4 address as it is, an
 * IPv6 address as its /56 (`sourceBucket`). The password routes only -- `context.ipKey`, which the
 * e-mailed-code limits count, is still the whole address.
 */
function sourceOf(context: RequestContext): string {
  return sourceBucket(context.ip);
}

/** How long, in seconds, a person who was told "busy" is asked to wait. */
const BUSY_RETRY_AFTER_SECONDS = 2;

/**
 * Counted before the work, whatever the outcome, and independent of the account existing.
 *
 * **Both budgets are per source.** The one per identifier is per identifier AND source: a budget that
 * every source shares is a way to spend a named person's budget for them, and the answer to the next
 * thing they type from their own address would be "too many attempts" (`429`) whatever the lock said.
 * What the account itself allows is the lock's, in the database, and it is the same for every source.
 */
function passwordStepAllowed(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  identifier: string,
): { readonly ok: boolean; readonly retryAfter: number } {
  const { limiters } = runtime;
  const source = sourceOf(context);
  return limit(
    [limiters.passwordAttemptIp, source],
    [
      limiters.passwordAttemptIdentifier,
      `${spec.requiredTenantId ?? "-"}|${normaliseIdentifier(identifier) ?? identifier}|${source}`,
    ],
  );
}

/**
 * The password exactly as typed. Not trimmed, because a space may be part of a password, and not
 * `stringField`, which trims. Anything that is not a non-empty string is absent.
 */
function passwordField(fields: Fields, name: string): string | null {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// The two posts
// ---------------------------------------------------------------------------

/** `POST .../password`: identify, verify, and either a session to issue, the change screen, or a refusal. */
export async function handlePasswordStep(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  fields: Fields,
): Promise<PasswordStepResult> {
  const identifier = boundedField(fields, "identifier", MAX_EMAIL_LENGTH);
  const password = passwordField(fields, "password");
  if (identifier === null || password === null) {
    return {
      kind: "response",
      response: passwordEntryResponse(runtime, context, spec, {
        identifier: identifier ?? undefined,
        error: context.t("password.missing"),
        status: 400,
      }),
    };
  }
  const allowed = passwordStepAllowed(runtime, context, spec, identifier);
  if (!allowed.ok) {
    return {
      kind: "response",
      response: passwordEntryResponse(runtime, context, spec, {
        identifier,
        error: context.t("password.rateLimited"),
        status: 429,
        retryAfter: allowed.retryAfter,
      }),
    };
  }

  const state = await signInWithPassword(runtime, {
    identifier,
    password,
    requiredTenantId: spec.requiredTenantId,
    ip: context.ip,
    source: sourceOf(context),
  });
  switch (state.kind) {
    case "signed_in":
      return { kind: "signed_in", tenantId: state.tenantId, user: state.user };
    case "change_required":
      return { kind: "response", response: changeEntryResponse(runtime, context, spec, { identifier }) };
    case "busy":
      return {
        kind: "response",
        response: passwordEntryResponse(runtime, context, spec, {
          identifier,
          error: context.t("password.busy"),
          status: 503,
          retryAfter: BUSY_RETRY_AFTER_SECONDS,
        }),
      };
    case "refused":
      return {
        kind: "response",
        response: passwordEntryResponse(runtime, context, spec, {
          identifier,
          error: context.t("password.invalid"),
          status: 400,
        }),
      };
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

/** `POST .../password/change`: the current password again, a new one, and a session when it holds. */
export async function handleChangeStep(
  runtime: PortalRuntime,
  context: RequestContext,
  spec: PasswordSpec,
  fields: Fields,
): Promise<PasswordStepResult> {
  const identifier = boundedField(fields, "identifier", MAX_EMAIL_LENGTH);
  if (identifier === null) {
    return { kind: "response", response: passwordEntryResponse(runtime, context, spec, { status: 400 }) };
  }
  const currentPassword = passwordField(fields, "current_password");
  const newPassword = passwordField(fields, "new_password");
  const confirmPassword = passwordField(fields, "confirm_password");
  if (currentPassword === null || newPassword === null || confirmPassword === null) {
    return {
      kind: "response",
      response: changeEntryResponse(runtime, context, spec, {
        identifier,
        error: context.t("change.missing"),
        status: 400,
      }),
    };
  }
  const allowed = passwordStepAllowed(runtime, context, spec, identifier);
  if (!allowed.ok) {
    return {
      kind: "response",
      response: changeEntryResponse(runtime, context, spec, {
        identifier,
        error: context.t("password.rateLimited"),
        status: 429,
        retryAfter: allowed.retryAfter,
      }),
    };
  }

  const outcome = await changePasswordAndSignIn(runtime, {
    identifier,
    currentPassword,
    newPassword,
    confirmPassword,
    requiredTenantId: spec.requiredTenantId,
    ip: context.ip,
    source: sourceOf(context),
  });
  switch (outcome.kind) {
    case "signed_in":
      return { kind: "signed_in", tenantId: outcome.tenantId, user: outcome.user };
    case "busy":
      return {
        kind: "response",
        response: changeEntryResponse(runtime, context, spec, {
          identifier,
          error: context.t("password.busy"),
          status: 503,
          retryAfter: BUSY_RETRY_AFTER_SECONDS,
        }),
      };
    case "refused":
      return {
        kind: "response",
        response: changeEntryResponse(runtime, context, spec, {
          identifier,
          error: refusalCopy(context, outcome.reason),
          status: 400,
        }),
      };
    case "invalid":
      return {
        kind: "response",
        response: changeEntryResponse(runtime, context, spec, {
          identifier,
          error: context.t("password.invalid"),
          status: 400,
        }),
      };
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}
