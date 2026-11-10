/**
 * The voice client: what a browser does against the host, minus the screen. It speaks the contract in
 * `packages/core/src/voice/protocol.ts` and nothing the host's own code could tell it.
 *
 * - H1 / H3 and the routes around them are plain HTTP with `Origin` set to the base URL on every request, the
 *   cookies the host handed out sent back, and the CSRF header on a mutating call (the host mints the cookie on
 *   an `/api` GET; the browser echoes it in `x-agentforge-csrf`).
 * - H2 is a WebSocket on `streamPath` with the same `Origin` and the same cookies on the handshake. Binary frames
 *   are PCM16 mono 24 kHz in both directions; text frames are the JSON unions in `protocol.ts`.
 * - Every frame the host sends and every frame sent is on one timeline with a monotonic timestamp.
 * - The browser's side of barge-in is played here: pause and `played` on a barge, drop on `stop_audio`, resume
 *   on `resume_audio`.
 *
 * Cookies live in memory for the run and are never printed, logged or written to a result file.
 */
import {
  type VoiceBrowserFrame,
  type VoiceHostFrame,
  type VoiceMode,
  type VoiceSessionCreated,
  parseVoiceHostFrame,
} from "@agentforge/core/voice";
import WebSocket from "ws";
import { type Clock, realClock } from "./clock";
import { type Mic, createMic } from "./mic";
import { type Playback, createPlayback } from "./playback";

// ---------------------------------------------------------------------------------------------------------
// Errors

/** An expected frame did not arrive in time. A case turns this into a failed check, not a crash. */
export class WaitTimeout extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`no ${label} within ${Math.round(timeoutMs)} ms`);
    this.name = "WaitTimeout";
  }
}

/** The socket closed while a case was still waiting for something. */
export class SocketClosed extends Error {
  constructor(
    readonly label: string,
    readonly code: number,
  ) {
    super(`the socket closed (code ${code}) while waiting for ${label}`);
    this.name = "SocketClosed";
  }
}

/** H1 answered with a refusal. `code` is the host's own: `voice_disabled`, `gateway_blocked`, ... */
export class H1Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "H1Refused";
  }
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

export type HttpResult = { status: number; body: unknown };

export type VoiceHttp = {
  /** The base URL's origin, sent as `Origin` on every request. */
  readonly origin: string;
  get(path: string, timeoutMs?: number): Promise<HttpResult>;
  post(path: string, body?: unknown, timeoutMs?: number): Promise<HttpResult>;
  del(path: string, timeoutMs?: number): Promise<HttpResult>;
  /** The `Cookie` header to send on the socket handshake, or undefined when the host set none. */
  cookieHeader(): string | undefined;
};

const CSRF_COOKIES = ["__Host-agentforge_csrf", "agentforge_csrf"] as const;
const CSRF_HEADER = "x-agentforge-csrf";
const TRANSPORT_HEADER = "x-agentforge-transport";
const REQUEST_TIMEOUT_MS = 30_000;

/** The error code in either answer shape: `{ error: { code } }` or the flat `{ error: "gateway_blocked" }`. */
export function errorCodeOf(body: unknown): string | null {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      return typeof code === "string" ? code : null;
    }
  }
  return null;
}

export function errorMessageOf(body: unknown): string | null {
  if (body && typeof body === "object") {
    const top = (body as { message?: unknown }).message;
    if (typeof top === "string") {
      return top;
    }
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return null;
}

function parseSetCookie(line: string): { name: string; value: string; expired: boolean } | null {
  const [pair = "", ...attributes] = line.split(";");
  const at = pair.indexOf("=");
  if (at <= 0) {
    return null;
  }
  const expired = attributes.some((attribute) => {
    const [key = "", value = ""] = attribute.split("=");
    return key.trim().toLowerCase() === "max-age" && Number(value.trim()) <= 0;
  });
  return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), expired };
}

export function createVoiceHttp(options: {
  base: string;
  fetch?: typeof fetch;
  locale?: string;
  /** A `Cookie` header value to start from (a signed-in session on a hosted desk). Never printed. */
  cookie?: string;
}): VoiceHttp {
  const origin = new URL(options.base).origin;
  const call = options.fetch ?? globalThis.fetch;
  const jar = new Map<string, string>();
  for (const pair of (options.cookie ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) {
      jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }

  function cookieHeader(): string | undefined {
    return jar.size === 0 ? undefined : [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function csrfToken(): string | null {
    for (const name of CSRF_COOKIES) {
      const value = jar.get(name);
      if (value) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
    return null;
  }

  async function request(method: string, path: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
    const headers = new Headers({ Origin: origin });
    if (options.locale) {
      headers.set("Accept-Language", options.locale);
    }
    const cookie = cookieHeader();
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    if (method !== "GET") {
      headers.set(TRANSPORT_HEADER, "web");
      const token = csrfToken();
      if (token) {
        headers.set(CSRF_HEADER, token);
      }
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body);
    }
    const response = await call(`${origin}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const cookieSet = parseSetCookie(line);
      if (cookieSet) {
        if (cookieSet.expired || cookieSet.value === "") {
          jar.delete(cookieSet.name);
        } else {
          jar.set(cookieSet.name, cookieSet.value);
        }
      }
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
    }
    return { status: response.status, body: parsed };
  }

  /** A browser's first mutation primes the CSRF cookie with one cheap GET when it has none. */
  async function primeCsrf(): Promise<void> {
    if (csrfToken()) {
      return;
    }
    try {
      await request("GET", "/api/v1/ping", undefined, 10_000);
    } catch {
      // The call below is sent anyway; the host answers csrf_missing if it cares.
    }
  }

  return {
    origin,
    get: (path, timeoutMs = REQUEST_TIMEOUT_MS) => request("GET", path, undefined, timeoutMs),
    async post(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      await primeCsrf();
      return request("POST", path, body ?? {}, timeoutMs);
    },
    async del(path, timeoutMs = REQUEST_TIMEOUT_MS) {
      await primeCsrf();
      return request("DELETE", path, undefined, timeoutMs);
    },
    cookieHeader,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Timeline

export type Rec =
  | { readonly kind: "frame"; readonly at: number; readonly frame: VoiceHostFrame }
  | { readonly kind: "audio"; readonly at: number; readonly bytes: number }
  /** A text frame the host sent that `parseVoiceHostFrame` did not accept. */
  | { readonly kind: "bad"; readonly at: number; readonly length: number }
  /** A text frame this client sent. */
  | { readonly kind: "sent"; readonly at: number; readonly frame: VoiceBrowserFrame }
  | { readonly kind: "close"; readonly at: number; readonly code: number };

export type FrameRec = Extract<Rec, { kind: "frame" }>;
export type AudioRec = Extract<Rec, { kind: "audio" }>;

export const isAudio = (rec: Rec): rec is AudioRec => rec.kind === "audio";

export function isFrame<T extends VoiceHostFrame["type"]>(
  type: T,
): (rec: Rec) => rec is Extract<Rec, { kind: "frame" }> & { frame: Extract<VoiceHostFrame, { type: T }> } {
  return (rec): rec is FrameRec & { frame: Extract<VoiceHostFrame, { type: T }> } =>
    rec.kind === "frame" && rec.frame.type === type;
}

export type CaptionFrame = Extract<VoiceHostFrame, { type: "caption" }>;

export function captions(timeline: readonly Rec[], role: "user" | "assistant", since = 0): Array<{ at: number; caption: CaptionFrame }> {
  const found: Array<{ at: number; caption: CaptionFrame }> = [];
  for (let i = since; i < timeline.length; i += 1) {
    const rec = timeline[i];
    if (rec?.kind === "frame" && rec.frame.type === "caption" && rec.frame.role === role) {
      found.push({ at: rec.at, caption: rec.frame });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Session

export type SessionInfo = VoiceSessionCreated;

type Waiter = { match: (rec: Rec) => boolean; resolve: (rec: Rec) => void; reject: (error: Error) => void; label: string };

export type WaitOptions = {
  /** Look from this timeline index on. Default 0: everything so far counts. */
  since?: number;
  timeoutMs: number;
  label: string;
};

export type VoiceSession = {
  readonly info: SessionInfo;
  readonly timeline: readonly Rec[];
  readonly mic: Mic;
  readonly playback: Playback;
  readonly clock: Clock;
  /** The timeline length now: pass it as `since` to look only at what happens next. */
  mark(): number;
  waitFor(match: (rec: Rec) => boolean, options: WaitOptions): Promise<Rec>;
  /** First record from `since` on that matches, if any. */
  find(match: (rec: Rec) => boolean, since?: number): Rec | undefined;
  findAll(match: (rec: Rec) => boolean, since?: number): Rec[];
  send(frame: VoiceBrowserFrame): void;
  /** The person speaks over the agent: pause locally, send `barge_in`, then `played` with what was heard. */
  bargeIn(): void;
  commit(): void;
  /** H3. The first call also closes the socket from the host's side. */
  endViaHttp(): Promise<HttpResult>;
  /** H3, then waits a moment for the socket to close, then stops the stream. Safe to call twice. */
  end(): Promise<void>;
  readonly closed: boolean;
};

export type UpgradeProbe =
  /** The handshake got an HTTP refusal, or the socket was dropped before it completed. */
  | { outcome: "refused"; status: number | null; detail: string }
  /** The upgrade completed and the socket closed again within a second with nothing sent. */
  | { outcome: "refused-after-upgrade"; closeCode: number }
  /** The upgrade completed and stayed open, or frames came. */
  | { outcome: "accepted"; frames: number }
  | { outcome: "timeout" };

export type DeskSettings = {
  readonly voice: { readonly enabled: boolean; readonly model: string | null } | null;
  readonly runtime: string | null;
  readonly locale: string | null;
};

export type ThreadMessage = { readonly role: string; readonly text: string; readonly partTypes: readonly string[] };

export type VoiceClient = {
  readonly base: string;
  readonly http: VoiceHttp;
  readonly clock: Clock;
  settings(): Promise<DeskSettings>;
  createThread(): Promise<string>;
  readMessages(threadId: string): Promise<ThreadMessage[]>;
  deleteThread(threadId: string): Promise<boolean>;
  /** H1 raw: the status and body as the host sent them. */
  postSession(threadId: string, mode?: VoiceMode): Promise<HttpResult>;
  /** H1: throws `H1Refused` on a refusal. */
  startSession(threadId: string, mode?: VoiceMode): Promise<SessionInfo>;
  /** H2: opens the socket, waits for `ready`, and starts the microphone stream. */
  connect(info: SessionInfo): Promise<VoiceSession>;
  /** H2 without a session behind it: tries the handshake with this `Origin` (null sends none). */
  probeUpgrade(info: SessionInfo, origin: string | null): Promise<UpgradeProbe>;
  /** H3 raw. */
  endSession(sessionId: string): Promise<HttpResult>;
};

const READY_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 2_000;
const PROBE_SETTLE_MS = 1_000;

function wsUrlFor(origin: string, streamPath: string): string {
  const url = new URL(streamPath, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function rawLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.length, 0);
  }
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function createVoiceClient(options: {
  base: string;
  fetch?: typeof fetch;
  clock?: Clock;
  locale?: string;
  cookie?: string;
}): VoiceClient {
  const clock = options.clock ?? realClock;
  const http = createVoiceHttp({
    base: options.base,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
  });
  let chatAgentId: string | null = null;

  async function agentId(): Promise<string> {
    if (chatAgentId) {
      return chatAgentId;
    }
    const chat = await http.get("/api/v1/chat");
    const id = record(record(chat.body).agent).id;
    if (chat.status !== 200 || typeof id !== "string") {
      throw new Error(`GET /api/v1/chat did not name the Chat agent (HTTP ${chat.status})`);
    }
    chatAgentId = id;
    return id;
  }

  function socketHeaders(): Record<string, string> {
    const cookie = http.cookieHeader();
    return cookie ? { Cookie: cookie } : {};
  }

  async function connect(info: SessionInfo): Promise<VoiceSession> {
    const timeline: Rec[] = [];
    const waiters = new Set<Waiter>();
    const playback = createPlayback();
    let closed = false;
    let closeCode = 0;

    const ws = new WebSocket(wsUrlFor(http.origin, info.streamPath), {
      origin: http.origin,
      headers: socketHeaders(),
      handshakeTimeout: READY_TIMEOUT_MS,
      // No compression: zlib runs on a thread pool and would add jitter to the latency being measured.
      perMessageDeflate: false,
    });

    const mic = createMic({
      clock,
      send(frame) {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("the socket is not open");
        }
        ws.send(frame, { binary: true });
      },
    });

    function push(rec: Rec): void {
      timeline.push(rec);
      for (const waiter of [...waiters]) {
        if (waiter.match(rec)) {
          waiters.delete(waiter);
          waiter.resolve(rec);
        }
      }
    }

    function sendFrame(frame: VoiceBrowserFrame): void {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error(`cannot send ${frame.type}: the socket is not open`);
      }
      ws.send(JSON.stringify(frame));
      push({ kind: "sent", at: clock.now(), frame });
    }

    function react(frame: VoiceHostFrame, at: number): void {
      if (frame.type === "stop_audio") {
        const ms = playback.stop(at);
        if (ws.readyState === WebSocket.OPEN) {
          sendFrame({ type: "played", ms: Math.floor(ms) });
        }
      } else if (frame.type === "resume_audio") {
        playback.resume(at);
      } else if (frame.type === "ended") {
        void mic.stop();
      }
    }

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const at = clock.now();
      if (isBinary) {
        const bytes = rawLength(data);
        push({ kind: "audio", at, bytes });
        playback.onAudio(bytes, at);
        return;
      }
      const text = rawText(data);
      const frame = parseVoiceHostFrame(text);
      if (!frame) {
        push({ kind: "bad", at, length: text.length });
        return;
      }
      push({ kind: "frame", at, frame });
      react(frame, at);
    });

    const closedPromise = new Promise<void>((resolve) => {
      ws.on("close", (code: number) => {
        closed = true;
        closeCode = code;
        push({ kind: "close", at: clock.now(), code });
        for (const waiter of [...waiters]) {
          waiters.delete(waiter);
          waiter.reject(new SocketClosed(waiter.label, code));
        }
        void mic.stop();
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error(`the voice socket was refused: HTTP ${response.statusCode ?? "?"}`));
        ws.terminate();
      });
      ws.once("error", (error) => reject(new Error(`the voice socket failed to open: ${error.message}`)));
    });
    // A later error (a reset) is a close; the listener above only guards the handshake.
    ws.on("error", () => undefined);

    function find(match: (rec: Rec) => boolean, since = 0): Rec | undefined {
      for (let i = since; i < timeline.length; i += 1) {
        const rec = timeline[i];
        if (rec && match(rec)) {
          return rec;
        }
      }
      return undefined;
    }

    const session: VoiceSession = {
      info,
      timeline,
      mic,
      playback,
      clock,
      mark: () => timeline.length,
      find,
      findAll(match, since = 0) {
        return timeline.slice(since).filter(match);
      },
      waitFor(match, waitOptions) {
        const hit = find(match, waitOptions.since ?? 0);
        if (hit) {
          return Promise.resolve(hit);
        }
        if (closed) {
          return Promise.reject(new SocketClosed(waitOptions.label, closeCode));
        }
        return new Promise<Rec>((resolve, reject) => {
          const timer = clock.after(waitOptions.timeoutMs, () => {
            waiters.delete(waiter);
            reject(new WaitTimeout(waitOptions.label, waitOptions.timeoutMs));
          });
          const waiter: Waiter = {
            match,
            label: waitOptions.label,
            resolve: (rec) => {
              timer.cancel();
              resolve(rec);
            },
            reject: (error) => {
              timer.cancel();
              reject(error);
            },
          };
          waiters.add(waiter);
        });
      },
      send: sendFrame,
      bargeIn() {
        const at = clock.now();
        playback.pause(at);
        sendFrame({ type: "barge_in" });
        sendFrame({ type: "played", ms: Math.floor(playback.playedMs(at)) });
      },
      commit() {
        sendFrame({ type: "commit" });
      },
      endViaHttp: () => http.post(`/api/v1/voice/sessions/${encodeURIComponent(info.sessionId)}/end`),
      async end() {
        if (!closed) {
          try {
            await http.post(`/api/v1/voice/sessions/${encodeURIComponent(info.sessionId)}/end`);
          } catch {
            // The socket is closed below either way.
          }
          const timer = new Promise<void>((resolve) => clock.after(CLOSE_WAIT_MS, resolve));
          await Promise.race([closedPromise, timer]);
        }
        await mic.stop();
        if (!closed) {
          ws.terminate();
          await closedPromise;
        }
      },
      get closed() {
        return closed;
      },
    };

    try {
      await session.waitFor(isFrame("ready"), { timeoutMs: READY_TIMEOUT_MS, label: "the ready frame" });
    } catch (error) {
      ws.terminate();
      await mic.stop();
      throw error;
    }
    mic.start();
    return session;
  }

  function probeUpgrade(info: SessionInfo, originHeader: string | null): Promise<UpgradeProbe> {
    return new Promise((resolve) => {
      let opened = false;
      let frames = 0;
      let settled = false;
      let settle: { cancel(): void } | null = null;
      const ws = new WebSocket(wsUrlFor(http.origin, info.streamPath), {
        ...(originHeader === null ? {} : { origin: originHeader }),
        headers: socketHeaders(),
        handshakeTimeout: 5_000,
        perMessageDeflate: false,
      });
      const done = (result: UpgradeProbe): void => {
        if (settled) {
          return;
        }
        settled = true;
        settle?.cancel();
        resolve(result);
        ws.terminate();
      };
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        done({ outcome: "refused", status: response.statusCode ?? null, detail: `HTTP ${response.statusCode ?? "?"}` });
      });
      ws.on("error", (error) => {
        if (opened) {
          return;
        }
        done(
          /timed out/i.test(error.message)
            ? { outcome: "timeout" }
            : { outcome: "refused", status: null, detail: error.message },
        );
      });
      ws.on("open", () => {
        opened = true;
        settle = clock.after(PROBE_SETTLE_MS, () => done({ outcome: "accepted", frames }));
      });
      ws.on("message", () => {
        frames += 1;
      });
      ws.on("close", (code: number) => {
        if (!opened) {
          done({ outcome: "refused", status: null, detail: `closed before the upgrade (code ${code})` });
        } else if (frames === 0) {
          done({ outcome: "refused-after-upgrade", closeCode: code });
        } else {
          done({ outcome: "accepted", frames });
        }
      });
    });
  }

  function postSession(threadId: string, mode?: VoiceMode): Promise<HttpResult> {
    return http.post("/api/v1/voice/sessions", mode ? { threadId, mode } : { threadId });
  }

  return {
    base: http.origin,
    http,
    clock,
    async settings() {
      const answer = await http.get("/api/v1/settings");
      if (answer.status !== 200) {
        throw new Error(`GET /api/v1/settings answered HTTP ${answer.status}`);
      }
      const body = record(answer.body);
      const voice = record(body.voice);
      return {
        voice:
          typeof voice.enabled === "boolean"
            ? { enabled: voice.enabled, model: typeof voice.model === "string" ? voice.model : null }
            : null,
        runtime: typeof body.runtime === "string" ? body.runtime : null,
        locale: typeof body.locale === "string" ? body.locale : null,
      };
    },
    async createThread() {
      const created = await http.post("/api/v1/threads", { agentId: await agentId() });
      const id = record(record(created.body).thread).id;
      if (created.status !== 201 || typeof id !== "string") {
        throw new Error(`POST /api/v1/threads answered HTTP ${created.status}`);
      }
      return id;
    },
    async readMessages(threadId) {
      const answer = await http.get(`/api/v1/threads/${encodeURIComponent(threadId)}`);
      if (answer.status !== 200) {
        throw new Error(`GET /api/v1/threads/:id answered HTTP ${answer.status}`);
      }
      const rows = record(answer.body).messages;
      if (!Array.isArray(rows)) {
        throw new Error("the thread answer has no messages list");
      }
      return rows.map((row) => {
        const message = record(row);
        const parts = Array.isArray(message.content) ? message.content.map(record) : [];
        return {
          role: typeof message.role === "string" ? message.role : "",
          text: parts
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("\n"),
          partTypes: parts.map((part) => (typeof part.type === "string" ? part.type : "?")),
        };
      });
    },
    async deleteThread(threadId) {
      const answer = await http.del(`/api/v1/threads/${encodeURIComponent(threadId)}`);
      return answer.status === 200;
    },
    postSession,
    async startSession(threadId, mode) {
      const answer = await postSession(threadId, mode);
      if (answer.status === 201) {
        const body = record(answer.body);
        if (
          typeof body.sessionId === "string" &&
          typeof body.streamPath === "string" &&
          typeof body.threadId === "string"
        ) {
          return {
            sessionId: body.sessionId,
            threadId: body.threadId,
            model: typeof body.model === "string" ? body.model : "",
            streamPath: body.streamPath,
            endsAt: typeof body.endsAt === "number" ? body.endsAt : 0,
          };
        }
        throw new Error("H1 answered 201 without a sessionId, threadId and streamPath");
      }
      const code = errorCodeOf(answer.body) ?? `http_${answer.status}`;
      throw new H1Refused(answer.status, code, errorMessageOf(answer.body) ?? `H1 refused the session: ${code}`);
    },
    connect,
    probeUpgrade,
    endSession(sessionId) {
      return http.post(`/api/v1/voice/sessions/${encodeURIComponent(sessionId)}/end`);
    },
  };
}
