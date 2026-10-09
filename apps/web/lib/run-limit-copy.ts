import { t } from "./i18n";

/**
 * SR-138: the host refuses a run over the hosted caps before any stream starts, as an ordinary JSON
 * error. The renderer's half is to say it in the desk's language instead of printing the host's
 * English `message`, which is written for the log. These are the host's reason codes
 * (`packages/host/src/run-limits.ts`); they only ever arrive from the hosted server, so on a desk
 * nothing here fires.
 *
 * The sentence is put in at the transport (`apiFetch`), not in each studio: every studio reads
 * `error.message` off a refused request, so every one of them, and every one added later, shows it.
 */
export const TOO_MANY_RUNS = "too_many_runs";
export const SERVER_BUSY = "server_busy";

/** The statuses the host refuses with: 429 for the tenant's own cap, 503 for the server's. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** The catalog sentence for a run-limit reason code, or `null` for any other value. */
export function runLimitMessage(code: unknown): string | null {
  if (code === TOO_MANY_RUNS) {
    return t("common.runLimit.tooManyRuns");
  }
  if (code === SERVER_BUSY) {
    return t("common.runLimit.serverBusy");
  }
  return null;
}

/**
 * A refusal body with the host's text swapped for the catalog sentence; any other body, and any other
 * status, comes back as the same object. Pure: the caller's own body is never written to.
 */
export function localizeRunLimitBody(status: number, body: unknown): unknown {
  if (!REFUSAL_STATUSES.has(status) || !body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const envelope = (body as { error?: unknown }).error;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return body;
  }
  const message = runLimitMessage((envelope as { code?: unknown }).code);
  return message === null ? body : { ...body, error: { ...envelope, message } };
}

/**
 * The same for a `Response` off the wire. A refusal that is not JSON, or not one of ours, is returned
 * as it came, and the original is only ever read through a clone.
 */
export async function localizeRunLimitRefusal(response: Response): Promise<Response> {
  if (!REFUSAL_STATUSES.has(response.status) || typeof response.clone !== "function") {
    return response;
  }
  const original: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const localized = localizeRunLimitBody(response.status, original);
  if (localized === original) {
    return response;
  }
  return new Response(JSON.stringify(localized), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "application/json" },
  });
}
