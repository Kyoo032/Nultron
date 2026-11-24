import { isCatalogMutationPath, notifyCatalogChanged } from "./catalog-version";
import { publishGate } from "./gate-state";
import { noteGatewayResponse } from "./gateway-blocked";
import { parseGatewayGate, type GatewayGatePayload } from "./gateway-gate";
import {
  parseCancelResetResult,
  parseResetResult,
  type CancelResetResult,
  type ResetResult,
  type ResetScope,
} from "./reset-app";
import { notePlanResponse } from "./plan-block";
import { localizeRunLimitRefusal } from "./run-limit-copy";
import { noteApiResponse } from "./session-signal";

export type { CancelResetResult, ResetResult, ResetScope } from "./reset-app";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Stamped on every mutating browser call. The host requires it on the destructive routes: a cross-site
 * HTML form can POST to the local server but cannot set a custom header, so its presence proves the
 * call came from our own code rather than from a page that merely knows the URL.
 */
const TRANSPORT_HEADER = "x-agentforge-transport";

const CSRF_COOKIE_SECURE = "__Host-agentforge_csrf";
const CSRF_COOKIE = "agentforge_csrf";
const CSRF_HEADER = "x-agentforge-csrf";

/** The cheapest GET on the API. The host mints the cookie on any `/api` GET that arrives without one. */
const CSRF_PRIME_PATH = "/api/v1/ping";

/** One cookie by exact name, or null when it is absent, empty or badly encoded. */
function cookieValue(jar: string, name: string): string | null {
  for (const part of jar.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The CSRF token the host minted for this browser, or null before an `/api` GET has answered. */
export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const jar = document.cookie;
  return cookieValue(jar, CSRF_COOKIE_SECURE) ?? cookieValue(jar, CSRF_COOKIE);
}

/**
 * The token to echo on a mutating call, minting one first when the jar is empty.
 *
 * The cookie only exists once an `/api` GET has answered, so the first action after a cold
 * navigation - a deep link that opens straight onto a form - would otherwise have nothing to send and
 * would be refused by the hosted server. One `GET /api/v1/ping`, with the caller's own credentials so
 * the browser keeps the `Set-Cookie`, fills the jar before the real call goes out. If that GET fails,
 * the call is sent anyway and the host answers `csrf_missing`, rather than this layer inventing an
 * error of its own.
 */
async function csrfTokenForMutation(init: RequestInit): Promise<string | null> {
  if (typeof document === "undefined") {
    return null;
  }
  const existing = readCsrfCookie();
  if (existing) {
    return existing;
  }
  try {
    await fetch(CSRF_PRIME_PATH, { method: "GET", credentials: init.credentials, signal: init.signal });
  } catch {
    return null;
  }
  return readCsrfCookie();
}

/** Returns a copy of `init` carrying the transport and CSRF headers; safe methods are untouched. */
async function withMutatingHeaders(init: RequestInit, method: string): Promise<RequestInit> {
  if (SAFE_METHODS.has(method)) {
    return init;
  }
  const headers = new Headers(init.headers);
  headers.set(TRANSPORT_HEADER, "web");
  const csrf = await csrfTokenForMutation(init);
  if (csrf) {
    headers.set(CSRF_HEADER, csrf);
  }
  return { ...init, headers };
}

async function transportFetch(input: string, init: RequestInit, method: string): Promise<Response> {
  const response = await fetch(input, await withMutatingHeaders(init, method));
  noteApiResponse(response);
  notePlanResponse(response);
  noteGatewayResponse(response);
  return localizeRunLimitRefusal(response);
}

type InflightRead = { response: Promise<Response>; joiners: number; startedAt: number };

const JOIN_WINDOW_MS = 2_000;

const inflightReads = new Map<string, InflightRead>();

/**
 * Callers that keep an answer of their own (`settings-read`) and must drop it the moment this
 * renderer writes anything. They are told at exactly the points the shared reads above are dropped,
 * at the start and at the end of a write (a streamed write is over when its body ends), so a kept
 * answer has the same freshness rule as an in-flight one: never older than the last write.
 */
const writeListeners = new Set<() => void>();

export function subscribeToWrites(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

function dropSharedReads(): void {
  inflightReads.clear();
  for (const listener of writeListeners) {
    listener();
  }
}

function sharedReadKey(input: string, init: RequestInit, method: string): string | null {
  if (method !== "GET") {
    return null;
  }
  for (const [name, value] of Object.entries(init)) {
    if (name !== "method" && value !== undefined) {
      return null;
    }
  }
  return input;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("Content-Type") ?? "").includes("text/event-stream");
}

function sharedRead(key: string, input: string, init: RequestInit): Promise<Response> {
  const running = inflightReads.get(key);
  if (running && Date.now() - running.startedAt < JOIN_WINDOW_MS) {
    running.joiners += 1;
    const turn = running.joiners;
    // Callbacks run in the order they were registered, the starter's first, so by the time the last
    // joiner's runs every clone has been taken and the original is free to hand over.
    return running.response.then((response) => {
      if (isEventStream(response)) {
        return transportFetch(input, init, "GET");
      }
      return turn === running.joiners ? response : response.clone();
    });
  }
  const started: InflightRead = { response: transportFetch(input, init, "GET"), joiners: 0, startedAt: Date.now() };
  inflightReads.set(key, started);
  const release = () => {
    if (inflightReads.get(key) === started) {
      inflightReads.delete(key);
    }
  };
  // Registered before the caller's own continuation, so `joiners` is final when that one runs.
  started.response.then(release, release);
  return started.response.then((response) =>
    started.joiners === 0 || isEventStream(response) ? response : response.clone(),
  );
}

/**
 * The same response, with the shared reads dropped once its body is over: read to the end, failed,
 * or given up on. The last matters. A job stream is read only as far as its terminal event and then
 * cancelled (`runJobStream`), and a `TransformStream`'s `flush` runs on a clean close only, so a
 * reader that cancelled left a read that began during the run free to answer one that began after
 * the host had saved.
 */
function clearReadsWhenStreamEnds(response: Response): Response {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          dropSharedReads();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        dropSharedReads();
        controller.error(error);
      }
    },
    async cancel(reason) {
      dropSharedReads();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function sendWrite(input: string, init: RequestInit, method: string): Promise<Response> {
  dropSharedReads();
  return transportFetch(input, init, method).then(
    (response) => {
      dropSharedReads();
      if (response.ok && isCatalogMutationPath(input)) {
        notifyCatalogChanged();
      }
      return isEventStream(response) ? clearReadsWhenStreamEnds(response) : response;
    },
    (error: unknown) => {
      dropSharedReads();
      throw error;
    },
  );
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const key = sharedReadKey(input, init, method);
  if (key !== null) {
    return sharedRead(key, input, init);
  }
  return SAFE_METHODS.has(method) ? transportFetch(input, init, method) : sendWrite(input, init, method);
}

/**
 * Force a fresh gateway key check on the host.
 * Returns `null` when the host reported no usable gate; callers must not open on that.
 */
export async function checkGateway(signal?: AbortSignal): Promise<GatewayGatePayload | null> {
  const res = await apiFetch("/api/v1/settings/gateway/check", { method: "POST", signal });
  const body = (await res.json().catch(() => null)) as { gateway?: unknown } | null;
  const gate = parseGatewayGate(body?.gateway);
  // A re-check is a fresh verdict from the host: every pane that is showing "add your key" (or not)
  // hears it. Hosted only inside; the Personal app is untouched.
  publishGate(gate);
  return gate;
}

/**
 * Start over: forget the gateway key (`key`) or delete all local data (`all`).
 *
 * An `all` reset needs `confirm: "RESET"`; the host refuses anything else with
 * `400 invalid_request`. The wipe lands on the next boot, so the caller has to
 * restart the app when `relaunch` comes back true.
 */
export async function resetApp(scope: ResetScope, confirm?: string): Promise<ResetResult> {
  const res = await apiFetch("/api/v1/settings/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirm ? { scope, confirm } : { scope }),
  });
  const body = await res.json().catch(() => null);
  return parseResetResult(res.status, body, scope);
}

/**
 * Call off a wipe that is queued for the next boot.
 *
 * Only an `all` reset queues one, and it stays queued until the app restarts — which is the window
 * in which the owner can still change their mind. The host removes `reset-pending.json` and answers
 * with the `resetPending` it now reports.
 */
export async function cancelReset(): Promise<CancelResetResult> {
  const res = await apiFetch("/api/v1/settings/reset", { method: "DELETE" });
  const body = await res.json().catch(() => null);
  return parseCancelResetResult(res.status, body);
}

export function mediaSrc(url: string): string {
  return url;
}
