/**
 * The harness's only way out of the process: HTTP to the webdev host on this machine.
 *
 * Loopback is checked on every request, not once at start-up, because the cases drive a billed
 * gateway key and carry content the owner typed into the desk. A mutating call carries
 * `Origin: <base origin>`, which the host's loopback rule accepts (`isAllowedMutatingApiRequest`,
 * `packages/host/src/local-request.ts`); the `Host` header is the one `fetch` derives from the URL.
 */
import { SseParser, readFrames, type SseFrame, type StreamEvent } from "./sse";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function requireLoopbackBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`--base must be a URL, got ${JSON.stringify(base)}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`--base must be loopback (127.0.0.1 / localhost / ::1), got ${url.hostname}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--base must be http or https, got ${url.protocol}`);
  }
  return url.origin;
}

export type HttpResult = { status: number; body: unknown };

export type StreamResult = {
  status: number;
  events: StreamEvent[];
  malformed: number;
  /** A non-event-stream answer (the 4xx JSON a closed gate or a bad body gets). */
  body: unknown;
  /** The stream broke or timed out part-way; the events above are what arrived before that. */
  streamError: string | null;
};

export type Http = {
  readonly base: string;
  get(path: string, timeoutMs?: number): Promise<HttpResult>;
  postJson(path: string, body: unknown, timeoutMs?: number): Promise<HttpResult>;
  postForm(path: string, form: FormData, timeoutMs?: number): Promise<HttpResult>;
  del(path: string, timeoutMs?: number): Promise<HttpResult>;
  stream(path: string, body: unknown, timeoutMs: number): Promise<StreamResult>;
};

export const REQUEST_TIMEOUT_MS = 30_000;

export function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Plain words for an error thrown by `fetch` or a reader, so a timeout reads as one. */
export function describeError(error: unknown, timeoutMs?: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return timeoutMs ? `timed out after ${timeoutMs} ms` : "timed out";
    }
    return error.message || error.name;
  }
  return String(error);
}

/**
 * The host answers an error two ways: `{ error: { code, message } }`, and for a closed gateway gate
 * the flat `{ error: "gateway_blocked", status, message }` (`packages/host/src/errors.ts`).
 */
export function errorText(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown; message?: unknown }).error;
    const topMessage = (body as { message?: unknown }).message;
    if (typeof error === "string") {
      return `HTTP ${status} ${error}${typeof topMessage === "string" ? `: ${topMessage}` : ""}`;
    }
    if (error && typeof error === "object") {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return `HTTP ${status} ${typeof code === "string" ? code : "error"}${typeof message === "string" ? `: ${message}` : ""}`;
    }
  }
  return `HTTP ${status}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function createHttp(options: { base: string; fetch?: typeof fetch }): Http {
  const origin = requireLoopbackBase(options.base);
  const call = options.fetch ?? globalThis.fetch;

  function request(method: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    requireLoopbackBase(origin);
    const headers = new Headers(init.headers);
    if (method !== "GET") {
      headers.set("Origin", origin);
    }
    return call(`${origin}${path}`, { ...init, method, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function json(method: string, path: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
    const init: RequestInit =
      body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
    const response = await request(method, path, init, timeoutMs);
    return { status: response.status, body: await readBody(response) };
  }

  return {
    base: origin,
    get: (path, timeoutMs = REQUEST_TIMEOUT_MS) => json("GET", path, undefined, timeoutMs),
    postJson: (path, body, timeoutMs = REQUEST_TIMEOUT_MS) => json("POST", path, body, timeoutMs),
    del: (path, timeoutMs = REQUEST_TIMEOUT_MS) => json("DELETE", path, undefined, timeoutMs),
    async postForm(path, form, timeoutMs = REQUEST_TIMEOUT_MS) {
      const response = await request("POST", path, { body: form }, timeoutMs);
      return { status: response.status, body: await readBody(response) };
    },
    async stream(path, body, timeoutMs) {
      const response = await request(
        "POST",
        path,
        { body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "text/event-stream" } },
        timeoutMs,
      );
      const isStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!isOk(response.status) || !isStream || !response.body) {
        return { status: response.status, events: [], malformed: 0, body: await readBody(response), streamError: null };
      }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const frames: SseFrame[] = [];
      let streamError: string | null = null;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          frames.push(...parser.push(decoder.decode(value, { stream: true })));
        }
        frames.push(...parser.push(decoder.decode()));
        frames.push(...parser.flush());
      } catch (error) {
        streamError = describeError(error, timeoutMs);
      }
      const { events, malformed } = readFrames(frames);
      return { status: response.status, events, malformed, body: null, streamError };
    },
  };
}
