import { parseGatewayGate, type GatewayGatePayload } from "./gateway-gate";

/**
 * "Start over" contract with the host.
 *
 * The host does the deleting; this module only reads what it answered. A `key`
 * reset forgets the gateway key on every desk and keeps the owner's work; an
 * `all` reset wipes the local data directory and is applied on the next boot,
 * which is why the host asks the app to relaunch.
 */

/**
 * Phase 8 adds `tenant`: the hosted "Start over", which erases the signed-in account's own content
 * and leaves every other tenant on the box untouched. It is a third scope rather than a hosted
 * reading of `all` so that neither target can reach the other's button — the host refuses `all` in
 * server mode and `tenant` off it, both before it reads the confirmation word.
 */
export const RESET_SCOPES = ["key", "all", "tenant"] as const;

export type ResetScope = (typeof RESET_SCOPES)[number];

/**
 * Literal word the owner types before a fresh-install reset. Never translated.
 *
 * `@agentforge/core` exports the same literal from `src/gateway/reset-types.ts`, but only through the
 * root barrel, which drags Node-only modules (`node:async_hooks` via `tools/secret-scope`) into the
 * browser bundle and breaks the Vite build. Until core publishes a browser-safe subpath for it, this
 * copy is the renderer's. It is only the confirm box's placeholder and enable check: what travels to
 * the host is what the owner typed, and the host compares against its own copy.
 */
export const RESET_CONFIRM_WORD = "RESET";

/**
 * The phrase an owner types to erase a whole hosted company account. Never translated.
 *
 * Not `RESET`: erasing a company deletes every person in it and signs them all out (owner decision
 * 2026-10-01, SR-65), so it asks for its own word, and the host refuses the desk's word for it. The
 * same literal as `TENANT_ERASE_CONFIRM_WORD` in `@agentforge/core`, which this bundle cannot import
 * for the reason above; `reset-app.test.ts` holds the two together. A fixed word rather than the
 * company's name because the host holds no reliable name (the portal sends ids).
 */
export const ERASE_ACCOUNT_CONFIRM_WORD = "DELETE";

/** Does what the owner typed unlock the final step? Trimmed, because the trimmed text is what is sent. */
export function eraseAccountPhraseMatches(typed: string): boolean {
  return typed.trim() === ERASE_ACCOUNT_CONFIRM_WORD;
}

export type ResetResult = {
  ok: boolean;
  scope: ResetScope;
  /**
   * `tenant` only: the erase signed the caller out too (they were one of the people it deleted), so
   * the renderer leaves through the ordinary sign-out instead of going to a desk. Only an explicit
   * `true` from the host counts.
   */
  signedOut?: boolean;
  /** Phase 8, `tenant` only: object bytes the erase actually freed, for the confirmation line. */
  bytesFreed?: number;
  /** The host wipes on the next start, so the app has to restart to finish. */
  relaunch: boolean;
  /** A wipe is queued in `reset-pending.json` and will be applied by the next packaged boot. */
  resetPending: boolean;
  gateway: GatewayGatePayload | null;
  /** Host message for a refused reset. Absent when the host said nothing usable. */
  error?: string;
  /** The host's error code (`tenant_reset_forbidden`, ...), so the UI can use its own words for it. */
  code?: string;
};

/** `DELETE /api/v1/settings/reset` → was the queued wipe actually called off? */
export type CancelResetResult = {
  ok: boolean;
  resetPending: boolean;
  error?: string;
};

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function isResetScope(value: unknown): value is ResetScope {
  return typeof value === "string" && (RESET_SCOPES as readonly string[]).includes(value);
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `{ error: { code, message } }` from the host, or `undefined` for any other body. */
function errorMessage(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  const direct = trimmedOrUndefined(error);
  if (direct) {
    return direct;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return trimmedOrUndefined((error as Record<string, unknown>).message);
}

/** `{ error: { code } }` from the host, or `undefined` for any other body. */
function errorCode(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return trimmedOrUndefined((error as Record<string, unknown>).code);
}

/**
 * `POST /api/v1/settings/reset` response → typed result.
 *
 * Fails closed: anything that is not an explicit `200 { ok: true }` is reported
 * as not done, so the UI never claims a reset the host did not perform.
 */
export function parseResetResult(status: number, body: unknown, requested: ResetScope = "key"): ResetResult {
  const record = asRecord(body);
  if (!record) {
    return { ok: false, scope: requested, relaunch: false, resetPending: false, gateway: null };
  }
  const scope = isResetScope(record.scope) ? record.scope : requested;
  const gateway = parseGatewayGate(record.gateway);
  const resetPending = record.resetPending === true;
  if (status !== 200 || record.ok !== true) {
    const message = errorMessage(record);
    // Only the hosted company erase has words of its own for a refusal. A desk's result keeps exactly
    // the shape it always had (the owner's rule, 2026-10-01: change the hosted version only).
    const code = scope === "tenant" ? errorCode(record) : undefined;
    return {
      ok: false,
      scope,
      relaunch: false,
      resetPending,
      gateway,
      ...(message ? { error: message } : {}),
      ...(code ? { code } : {}),
    };
  }
  return {
    ok: true,
    scope,
    relaunch: record.relaunch === true,
    resetPending,
    gateway,
    ...(record.signedOut === true ? { signedOut: true } : {}),
    ...(typeof record.bytesFreed === "number" ? { bytesFreed: record.bytesFreed } : {}),
  };
}

/**
 * `DELETE /api/v1/settings/reset` response → typed result.
 *
 * Fails closed the other way round: anything that is not an explicit `200 { ok: true }` leaves
 * `resetPending` true, so a cancel the host did not perform never hides the banner. The host's own
 * `resetPending` is read when it sent one, since only the host knows whether the marker is gone.
 */
export function parseCancelResetResult(status: number, body: unknown): CancelResetResult {
  const record = asRecord(body);
  if (!record || status !== 200 || record.ok !== true) {
    const message = record ? errorMessage(record) : undefined;
    return { ok: false, resetPending: true, ...(message ? { error: message } : {}) };
  }
  return { ok: true, resetPending: record.resetPending === true };
}
