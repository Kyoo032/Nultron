/**
 * The host voice relay, driven with a scripted talker, a clock the test moves, and a real socket
 * on 127.0.0.1 port 0. No gateway call.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WORKSPACE_COOKIE, type TenantContext } from "@agentforge/core";
import {
  VOICE_LIMITS,
  VOICE_MAX_AUDIO_FRAME_BYTES,
  VOICE_STREAM_PATH_PATTERN,
  parseVoiceHostFrame,
  type VoiceHostFrame,
  type VoiceMode,
} from "@agentforge/core/voice";
import { WebSocket } from "ws";
import { createSession, sessionCookieName } from "../auth/session";
import { createMemorySessionStore } from "../auth/session-store";
import type { PortalSessionCheck } from "../auth/portal-check";
import type { HostJsonResult, HostResult } from "../types";
import { resetRateLimiters } from "../rate-limit";
import { readSelectedWorkspaceId, selectedWorkspacePath } from "../workspace";
import { dispatch } from "../router";
import { agentService, getTenant } from "../tenant";
import { createThread, listMessages } from "../threads";
import { rmSync } from "node:fs";
import { listTenantUsage } from "../tenant-usage";
import { manualClock, type ManualClock } from "./clock";
import { outboundBacklogTooHigh, pcmDurationMs, VOICE_OUTBOUND_BACKLOG_BYTES } from "./pcm";
import { resetVoiceSessionsForTests, voiceSessions } from "./sessions";
import { TURN_TIMING } from "./turns";
import { TalkerError, type Talker, type TalkerEvent, type TalkerSession, type TalkerUsage, type Transcriber } from "./talker";
import { attachVoiceUpgrade, type VoiceUpgradeOptions } from "./upgrade";
import { setVoiceWiringForTests, type VoiceWiring } from "./wiring";
import { VOICE_DEFAULT_MODEL, VOICE_DEFAULT_VOICE } from "./flag";
import { ACK_SENTENCE, ASK_NULTRON_NAME } from "./talker-prompt";
import { resetTalkerCachesForTests, whenAcknowledgementSettled } from "./talker-omni-http";
import type { AskResult } from "./ask";

const USAGE: TalkerUsage = { inputTokens: 3, outputTokens: 5, inputAudioTokens: 1, outputAudioTokens: 4 };
const ANSWER = "alpha bravo charlie delta echo foxtrot";
/** Not the talker's id (`fake-talker`), so the ledger rows of the two can be told apart. */
const TRANSCRIBER_MODEL = "fake-transcriber";

type ReplyCall = {
  pcm: Buffer;
  mustAnswer: boolean;
  signal: AbortSignal;
  kind: "reply" | "answer";
  callId?: string;
  text?: string;
};

class FakeSession implements TalkerSession {
  readonly calls: ReplyCall[] = [];
  readonly remembered: Array<{ user: string | null; assistant: string; interrupted: boolean }> = [];
  closed = false;

  constructor(private readonly owner: FakeTalker) {}

  reply(pcm: Buffer, options: { signal: AbortSignal; mustAnswer?: boolean }): AsyncIterable<TalkerEvent> {
    const call: ReplyCall = {
      pcm: Buffer.from(pcm),
      mustAnswer: options.mustAnswer === true,
      signal: options.signal,
      kind: "reply",
    };
    this.calls.push(call);
    return this.owner.script(call);
  }

  answer(callId: string, text: string, options: { signal: AbortSignal; mustAnswer?: boolean }): AsyncIterable<TalkerEvent> {
    const call: ReplyCall = {
      pcm: Buffer.alloc(0),
      mustAnswer: options.mustAnswer === true,
      signal: options.signal,
      kind: "answer",
      callId,
      text,
    };
    this.calls.push(call);
    return this.owner.script(call);
  }

  remember(turn: { user: string | null; assistant: string; interrupted: boolean }): void {
    this.remembered.push(turn);
  }

  hearShort(speech: Buffer, signal: AbortSignal): Promise<string | null> {
    return this.owner.hear(speech, signal);
  }

  acknowledgement(): { pcm: Buffer; text: string } | null {
    return this.owner.ack;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeTalker implements Talker {
  readonly model = "fake-talker";
  readonly sessions: FakeSession[] = [];
  ack: { pcm: Buffer; text: string } | null = null;
  hear: (speech: Buffer, signal: AbortSignal) => Promise<string | null> = async () => null;
  script: (call: ReplyCall) => AsyncIterable<TalkerEvent> = spoken;

  open(): FakeSession {
    const session = new FakeSession(this);
    this.sessions.push(session);
    return session;
  }
}

function dormant(): Talker {
  return new FakeTalker();
}

async function* spoken(call: ReplyCall): AsyncIterable<TalkerEvent> {
  await Promise.resolve();
  if (call.signal.aborted) return;
  yield { type: "text", delta: "hello from the desk" };
  yield { type: "audio", pcm: tone(200) };
  yield { type: "usage", usage: USAGE };
  yield { type: "done" };
}

function tone(ms: number, amplitude = 0.2): Buffer {
  const samples = Math.round((ms * 24_000) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24_000) * 32767);
    buf.writeInt16LE(value, i * 2);
  }
  return buf;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round(ms * 48));
}

function pcm(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** One socket frame may not exceed `maxPayload`. A longer utterance goes out as several frames. */
function sendPcm(ws: WebSocket, buf: Buffer): void {
  const limit = VOICE_MAX_AUDIO_FRAME_BYTES;
  for (let offset = 0; offset < buf.length; offset += limit) {
    ws.send(buf.subarray(offset, Math.min(offset + limit, buf.length)));
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") lines.push(candidate.text);
  }
  return lines.join("\n");
}

type Box = { frames: VoiceHostFrame[]; bins: Buffer[] };

function collect(ws: WebSocket): Box {
  const box: Box = { frames: [], bins: [] };
  ws.on("message", (data, isBinary) => {
    if (isBinary) box.bins.push(Buffer.from(data as Buffer));
    else {
      const frame = parseVoiceHostFrame(data.toString());
      if (frame) box.frames.push(frame);
    }
  });
  return box;
}

async function until(pred: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function states(box: Box): string[] {
  return box.frames.filter((frame) => frame.type === "state").map((frame) => (frame.type === "state" ? frame.value : ""));
}

let server: Server;
let port = 0;
let clock: ManualClock;
let talker: FakeTalker;
let transcriber: Transcriber;
let tenant: TenantContext;
let threadId = "";
const sockets: WebSocket[] = [];
const upgradeOptions: VoiceUpgradeOptions = {};
const portalCheck: PortalSessionCheck = {
  async refresh() {
    throw new Error("voice test must not refresh a portal session");
  },
  async gate() {
    return { ok: true };
  },
};

function transcribeOk(): Transcriber {
  return {
    async transcribe() {
      return { text: "hello there", seconds: 0.4 };
    },
  };
}

function armWiring(ask?: VoiceWiring["ask"]): void {
  clock = manualClock(1_000_000);
  setVoiceWiringForTests({
    clock,
    modelsFor: () => ({ talker, transcriber, transcriberModel: TRANSCRIBER_MODEL }),
    ...(ask ? { ask } : {}),
  });
}

/** `workspaceId` is what the adapter reads from the desk cookie. */
async function postSession(
  body: { threadId: string; mode?: VoiceMode } = { threadId },
  workspaceId?: string,
): Promise<HostResult> {
  return dispatch({
    method: "POST",
    path: "/api/v1/voice/sessions",
    query: {},
    params: {},
    headers: {},
    body,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

/**
 * On the hosted server nothing reads the machine's selected desk (`readSelectedWorkspaceId` is empty there).
 * These tests reach the hosted rules through the upgrade's `serverMode` option, so the environment still
 * says desk and the selection file must go, or a request with no desk cookie would resolve through it.
 */
function hostedLikeNoMachineDesk(): void {
  rmSync(selectedWorkspacePath(), { force: true });
  expect(readSelectedWorkspaceId()).toBeUndefined();
}

async function endSession(id: string): Promise<HostResult> {
  return dispatch({
    method: "POST",
    path: `/api/v1/voice/sessions/${id}/end`,
    query: {},
    params: {},
    headers: {},
    body: {},
  });
}

function enableVoice(): void {
  process.env.AGENTFORGE_VOICE = "on";
}

async function openReady(mode?: VoiceMode): Promise<{ ws: WebSocket; box: Box; created: { sessionId: string; streamPath: string } }> {
  enableVoice();
  const result = await postSession(mode ? { threadId, mode } : { threadId });
  expect(result.status).toBe(201);
  const created = (result as HostJsonResult).body as { sessionId: string; streamPath: string; endsAt: number; model: string; threadId: string };
  const ws = connect(created.streamPath);
  const box = collect(ws);
  await until(() => box.frames.some((frame) => frame.type === "ready"), "ready");
  return { ws, box, created };
}

function connect(path: string, headers: Record<string, string | undefined> = {}): WebSocket {
  const origin = headers.origin === undefined ? `http://127.0.0.1:${port}` : headers.origin;
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "origin" || value === undefined) continue;
    extra[key] = value;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { ...(origin ? { origin } : {}), ...extra },
  });
  sockets.push(ws);
  return ws;
}

function refused(path: string, headers: Record<string, string | undefined> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = connect(path, headers);
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const timer = setTimeout(() => finish(-1), 1500);
    ws.on("open", () => {
      clearTimeout(timer);
      finish(101);
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      finish(res.statusCode ?? 0);
    });
    ws.on("error", () => {
      clearTimeout(timer);
      finish(0);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      finish(0);
    });
  });
}

async function playOut(box: Box): Promise<void> {
  const savedBefore = box.frames.filter((frame) => frame.type === "saved").length;
  await until(() => states(box).includes("speaking"), "speaking");
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = box.bins.reduce((sum, bin) => sum + bin.length, 0);
  clock.advance(pcmDurationMs(bytes) + 30);
  await until(() => box.frames.filter((frame) => frame.type === "saved").length > savedBefore, "saved");
}

describe("voice relay", () => {
  beforeAll(async () => {
    server = createServer();
    attachVoiceUpgrade(server, upgradeOptions);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id, "Voice");
    if (!thread) throw new Error("thread was not created");
    threadId = thread.id;
  });

  afterEach(() => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
    sockets.length = 0;
    resetVoiceSessionsForTests();
    setVoiceWiringForTests(null);
    delete process.env.AGENTFORGE_VOICE;
    delete process.env.AGENTFORGE_TRUSTED_ORIGINS;
    delete process.env.AGENTFORGE_RATE_IP_RPM;
    resetRateLimiters();
    process.env.AGENTFORGE_RUNTIME = "stub";
    upgradeOptions.serverMode = undefined;
    upgradeOptions.sessionStore = undefined;
    upgradeOptions.portalCheck = undefined;
    upgradeOptions.now = undefined;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  it("refuses H1 when voice is off, the thread is unknown, the gate is shut, the process is full, or no talker is wired", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();

    process.env.AGENTFORGE_VOICE = "off";
    const disabled = await postSession();
    expect(disabled.status).toBe(403);
    expect((disabled as HostJsonResult).body).toMatchObject({ error: { code: "voice_disabled" } });

    enableVoice();
    const missing = await postSession({ threadId: "missing-thread" });
    expect(missing.status).toBe(404);
    expect((missing as HostJsonResult).body).toMatchObject({ error: { code: "not_found", message: "Thread not found" } });

    process.env.AGENTFORGE_RUNTIME = "ai";
    const blocked = await postSession();
    expect(blocked.status).toBe(403);
    const flat = (blocked as HostJsonResult).body as { error?: unknown; status?: unknown; message?: unknown };
    expect(flat.error).toBe("gateway_blocked");
    expect(typeof flat.status).toBe("string");
    expect(typeof flat.message).toBe("string");
    expect(flat).not.toHaveProperty("error.code");
    process.env.AGENTFORGE_RUNTIME = "stub";

    for (let i = 0; i < VOICE_LIMITS.maxOpenPerProcess; i += 1) {
      const opened = voiceSessions().open({
        tenant: { ...tenant, userId: `other-${i}` },
        threadId,
        mode: "hands_free",
        locale: "en",
        model: "fake-talker",
        talker: dormant(),
        transcriber,
        transcriberModel: TRANSCRIBER_MODEL,
      });
      expect(opened.ok).toBe(true);
    }
    const capped = await postSession();
    expect(capped.status).toBe(429);
    expect((capped as HostJsonResult).body).toMatchObject({ error: { code: "voice_session_limit" } });
    resetVoiceSessionsForTests();
    armWiring();

    setVoiceWiringForTests({ clock, modelsFor: () => null });
    const unwired = await postSession();
    expect(unwired.status).toBe(503);
    expect((unwired as HostJsonResult).body).toMatchObject({ error: { code: "voice_model_unavailable" } });
  });

  it("opens a session and replaces an older one of the same person", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    const first = await postSession();
    expect(first.status).toBe(201);
    const created = (first as HostJsonResult).body as {
      sessionId: string;
      threadId: string;
      model: string;
      streamPath: string;
      endsAt: number;
    };
    expect(created.threadId).toBe(threadId);
    expect(created.model).toBe("qwen3.5-omni-flash");
    expect(created.streamPath).toMatch(VOICE_STREAM_PATH_PATTERN);
    expect(created.endsAt).toBe(clock.now() + VOICE_LIMITS.maxSessionMs);
    const second = await postSession();
    expect(second.status).toBe(201);
    const replaced = voiceSessions().get(created.sessionId);
    expect(replaced?.endedReason).toBe("replaced");
    expect(voiceSessions().openCount()).toBe(1);
  });

  it("ends on H3 twice with the same minutes and 404s another person", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { created } = await openReady();
    clock.advance(90_000);
    const once = await endSession(created.sessionId);
    const twice = await endSession(created.sessionId);
    expect(once.status).toBe(200);
    expect(twice.status).toBe(200);
    expect((once as HostJsonResult).body).toEqual({ minutes: 1.5 });
    expect((twice as HostJsonResult).body).toEqual({ minutes: 1.5 });
    const foreign = voiceSessions().open({
      tenant: { ...tenant, userId: "someone-else" },
      threadId,
      mode: "hands_free",
      locale: "en",
      model: "fake-talker",
      talker: dormant(),
      transcriber,
      transcriberModel: TRANSCRIBER_MODEL,
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    const hidden = await endSession(foreign.session.id);
    expect(hidden.status).toBe(404);
    expect((hidden as HostJsonResult).body).toMatchObject({ error: { code: "not_found", message: "Voice session not found" } });
    expect(voiceSessions().get(foreign.session.id)?.endedReason).toBeNull();
    const unknown = await endSession("does-not-exist-at-all");
    expect(unknown.status).toBe(404);
    expect(JSON.stringify((unknown as HostJsonResult).body)).toBe(JSON.stringify((hidden as HostJsonResult).body));
  });

  it("leaves a non-voice upgrade untouched", async () => {
    let seen = false;
    const onUpgrade = (req: IncomingMessage, socket: Socket) => {
      if (!req.url?.startsWith("/vite-hmr")) return;
      seen = true;
      expect(socket.destroyed).toBe(false);
      socket.end("HTTP/1.1 404 No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    };
    server.on("upgrade", onUpgrade);
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          sock.write(
            "GET /vite-hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
        });
        sock.on("data", () => {
          sock.end();
          resolve();
        });
        sock.on("error", reject);
      });
    } finally {
      server.off("upgrade", onUpgrade);
    }
    expect(seen).toBe(true);
  });

  it("refuses the upgrade before any handshake", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    const created = (await postSession()) as HostJsonResult;
    const path = (created.body as { streamPath: string; sessionId: string }).streamPath;
    const id = (created.body as { sessionId: string }).sessionId;

    expect(await refused(path, { origin: "" })).toBe(403);
    expect(await refused(path, { origin: "https://evil.example" })).toBe(403);
    expect(await refused(`/api/v1/voice/sessions/${"a".repeat(22)}/stream`)).toBe(404);

    const foreign = voiceSessions().open({
      tenant: { ...tenant, userId: "someone-else" },
      threadId,
      mode: "hands_free",
      locale: "en",
      model: "fake-talker",
      talker: dormant(),
      transcriber,
      transcriberModel: TRANSCRIBER_MODEL,
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(await refused(`/api/v1/voice/sessions/${foreign.session.id}/stream`)).toBe(404);

    process.env.AGENTFORGE_VOICE = "off";
    expect(await refused(path)).toBe(403);
    enableVoice();

    await endSession(id);
    expect(await refused(path)).toBe(404);

    upgradeOptions.serverMode = true;
    upgradeOptions.sessionStore = createMemorySessionStore();
    upgradeOptions.portalCheck = portalCheck;
    process.env.AGENTFORGE_TRUSTED_ORIGINS = "https://desk.example";
    const secure = await postSession();
    expect(secure.status).toBe(201);
    const securePath = ((secure as HostJsonResult).body as { streamPath: string }).streamPath;
    expect(await refused(securePath, { origin: "https://desk.example", host: "desk.example" })).toBe(403);
    expect(
      await refused(securePath, { origin: "https://desk.example", host: "desk.example", "x-forwarded-proto": "https" }),
    ).toBe(401);
  });

  it("refuses a second socket and drops junk without closing", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box, created } = await openReady();
    expect(await refused(created.streamPath)).toBe(404);
    ws.send(JSON.stringify({ type: "nope" }));
    ws.send("x".repeat(5000));
    ws.send(Buffer.from([1, 2, 3]));
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended" && frame.reason === "user"), "ended");
  });

  it("closes the socket when a binary frame exceeds maxPayload", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws } = await openReady();
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(Buffer.alloc(VOICE_MAX_AUDIO_FRAME_BYTES + 2));
    const code = await closed;
    expect(code).not.toBe(1000);
  });

  it("says ready and then listening, so the view leaves connecting", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { box } = await openReady();
    await until(() => states(box).length > 0, "the first state");
    // The view starts in `connecting`, and `ready` does not move it: only a state frame does.
    expect(box.frames[0]?.type).toBe("ready");
    expect(box.frames[1]).toEqual({ type: "state", value: "listening" });
  });

  it("plays a plain turn into the thread with a usage row", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await playOut(box);
    const order = states(box);
    expect(order.indexOf("hearing")).toBeLessThan(order.indexOf("thinking"));
    expect(order.indexOf("thinking")).toBeLessThan(order.indexOf("speaking"));
    expect(order.at(-1)).toBe("listening");
    expect(box.bins.length).toBeGreaterThan(0);
    expect(box.bins.every((bin) => bin.length % 2 === 0 && bin.length <= VOICE_MAX_AUDIO_FRAME_BYTES)).toBe(true);
    const captions = box.frames.filter((frame) => frame.type === "caption");
    expect(captions.some((frame) => frame.type === "caption" && frame.role === "assistant" && frame.final && frame.text.includes("hello from the desk"))).toBe(true);
    expect(captions.some((frame) => frame.type === "caption" && frame.role === "user" && frame.final && frame.text === "hello there")).toBe(true);
    const savedAt = box.frames.findIndex((frame) => frame.type === "saved");
    const metricsAt = box.frames.findIndex((frame) => frame.type === "metrics");
    expect(metricsAt).toBeGreaterThan(savedAt);
    const metrics = box.frames[metricsAt];
    expect(metrics?.type).toBe("metrics");
    if (metrics?.type === "metrics") {
      expect(metrics.speechEndToFirstAudioMs).toEqual(expect.any(Number));
      expect(metrics.talkerFirstAudioMs).toEqual(expect.any(Number));
      expect(metrics.transcribeMs).toEqual(expect.any(Number));
    }
    const rows = await listMessages(tenant, threadId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(textOf(rows[0]?.content)).toBe("hello there");
    expect(textOf(rows[1]?.content)).toContain("hello from the desk");
    const usage = listTenantUsage(tenant);
    expect(usage.some((row) => row.mode === "voice" && row.unit === "tokens" && row.inputTokens === 3 && row.outputTokens === 5)).toBe(true);
    expect(
      usage.some(
        (row) =>
          row.mode === "voice" &&
          row.unit === "seconds" &&
          row.quantity === 1 &&
          row.unpricedReason === "no_list_price",
      ),
    ).toBe(true);
    expect(talker.sessions[0]?.remembered).toEqual([{ user: "hello there", assistant: "hello from the desk", interrupted: false }]);
  });

  it("records transcription seconds and session seconds under different models", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const secondsOn = (model: string) =>
      listTenantUsage(tenant).filter((row) => row.mode === "voice" && row.unit === "seconds" && row.model === model);
    const known = new Set(listTenantUsage(tenant).map((row) => row.id));
    const fresh = (model: string) => secondsOn(model).filter((row) => !known.has(row.id));
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await playOut(box);
    clock.advance(60_000);
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");

    // The 0.4 s transcript, rounded up to a whole second, on the transcriber's own model.
    const transcribed = fresh(TRANSCRIBER_MODEL);
    expect(transcribed).toHaveLength(1);
    expect(transcribed[0]).toMatchObject({ quantity: 1, unpricedReason: "no_list_price" });
    // The time the session was open, on the model H1 opened the session with (the talker's).
    const open = fresh(VOICE_DEFAULT_MODEL);
    expect(open).toHaveLength(1);
    expect(open[0]?.quantity).toBeGreaterThanOrEqual(60);
    expect(open[0]?.model).not.toBe(transcribed[0]?.model);
  });

  it("aborts an early reply when speech resumes and answers the whole utterance once", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(400), tone(200), silence(800)));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) >= 2, "two replies");
    const calls = talker.sessions[0]?.calls ?? [];
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(calls[1]?.pcm.length).toBeGreaterThanOrEqual(tone(200).length * 2);
    await playOut(box);
    expect(talker.sessions[0]?.remembered).toHaveLength(1);
  });

  it("waits, then must answer after the silence cap", async () => {
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (!call.mustAnswer) {
        yield { type: "wait" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: "now then" };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(2700)));
    await until(() => talker.sessions[0]?.calls.some((call) => call.mustAnswer) === true, "mustAnswer");
    expect(talker.sessions[0]?.calls[0]?.mustAnswer).toBe(false);
    await playOut(box);
    const rows = await listMessages(tenant, threadId);
    expect(textOf(rows.at(-1)?.content)).toBe("now then");
  });

  it("asks the desk, plays the acknowledgement first, and sends a card when the desk needs a tap", async () => {
    const asks: string[] = [];
    talker = new FakeTalker();
    talker.ack = { pcm: tone(120), text: "Sebentar, saya cek dulu." };
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-1", question: "What is on my desk?" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: call.text ?? "" };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    const answer: AskResult = { kind: "answer", text: "The desk is clear.", toolCalls: [] };
    armWiring(async (input) => {
      asks.push(input.question);
      return answer;
    });
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await playOut(box);
    expect(asks).toEqual(["What is on my desk?"]);
    const answerCall = talker.sessions[0]?.calls.find((call) => call.kind === "answer");
    expect(answerCall?.callId).toBe("call-1");
    expect(answerCall?.text).toBe("The desk is clear.");
    const ackCaption = box.frames.find((frame) => frame.type === "caption" && frame.text === "Sebentar, saya cek dulu.");
    const userCaption = box.frames.find((frame) => frame.type === "caption" && frame.role === "user");
    expect(userCaption && userCaption.type === "caption" ? userCaption.text : "").toBe("What is on my desk?");
    expect(ackCaption).toBeTruthy();
    expect(box.bins[0]?.length).toBe(tone(120).length);
    const rows = await listMessages(tenant, threadId);
    const saved = rows.slice(-2);
    expect(textOf(saved[0]?.content)).toBe("What is on my desk?");
    expect(textOf(saved[1]?.content)).toBe("The desk is clear.");
    expect(textOf(saved[1]?.content)).not.toContain("Sebentar");

    resetVoiceSessionsForTests();
    const tapped: AskResult = {
      kind: "needs_tap",
      text: "I can send that once you tap.",
      card: { prompt: "send the note", summary: "Send the note" },
    };
    armWiring(async () => tapped);
    talker = new FakeTalker();
    talker.ack = { pcm: tone(120), text: "Sebentar, saya cek dulu." };
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-2", question: "Send the note" };
        return;
      }
      yield { type: "text", delta: "Ready when you tap." };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    const again = await openReady();
    sendPcm(again.ws, pcm(tone(200), silence(800)));
    await until(() => again.box.frames.some((frame) => frame.type === "card"), "card");
    const card = again.box.frames.find((frame) => frame.type === "card");
    expect(card && card.type === "card" ? card.card : null).toEqual({ prompt: "send the note", summary: "Send the note" });
    await playOut(again.box);
  });

  it("saves a delegated ask's tool call before its spoken answer, and captions who it asked", async () => {
    const delegatePart = {
      type: "tool_call" as const,
      toolKey: "delegate",
      status: "completed" as const,
      input: { agent: "research", task: "Find three reliable sources on QRIS fees." },
      output: {
        ok: true,
        agent: "research",
        agentName: "Research agent",
        thread: { id: "t-9" },
        summary: "Fees are capped at 0.3 percent.",
        truncated: false,
        toolsUsed: ["web_search"],
      },
    };
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-d", question: "Ask research about QRIS fees" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: call.text ?? "" };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring(async (input) => {
      input.onProgress?.("Research agent");
      return { kind: "answer", text: "Research says fees are capped.", toolCalls: [delegatePart] };
    });
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(
      () => box.frames.some((frame) => frame.type === "caption" && frame.text.includes("Research agent")),
      "delegating caption",
    );
    const caption = box.frames.find((frame) => frame.type === "caption" && frame.text.includes("Research agent"));
    expect(caption && caption.type === "caption" ? caption.text : "").toContain("Research agent");
    await playOut(box);
    const rows = (await listMessages(tenant, threadId)).slice(before);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const parts = rows[1]?.content as Array<Record<string, unknown>>;
    // The tool part leads the text, the way a typed turn saves it, so the delegate card renders.
    expect(parts[0]).toMatchObject({ type: "tool_call", toolKey: "delegate", status: "completed" });
    expect(parts[1]).toMatchObject({ type: "text", text: "Research says fees are capped." });
    // The progress caption was for the screen only: nothing of it reached the thread.
    expect(JSON.stringify(rows)).not.toContain("Asking ");
  });

  it("does not end an idle session while an ask is still working", async () => {
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-i", question: "Ask Tide bot for the tide" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: call.text ?? "" };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    let releaseAsk: () => void = () => {};
    let askStarted = false;
    const gate = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    armWiring(async () => {
      askStarted = true;
      await gate;
      return { kind: "answer", text: "The tide is at 06:10.", toolCalls: [] };
    });
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => askStarted, "ask in flight");
    // Well past the idle limit with the ask still running: the session must not end.
    clock.advance(VOICE_LIMITS.idleMs + 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(box.frames.some((frame) => frame.type === "ended")).toBe(false);
    releaseAsk();
    await playOut(box);
    const rows = (await listMessages(tenant, threadId)).slice(before);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(textOf(rows[1]?.content)).toBe("The tide is at 06:10.");
  });

  it("interrupts a long overlap, trims the reply, and keeps the overlap as the next utterance", async () => {
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.pcm.length > tone(500).length) {
        yield { type: "text", delta: "second" };
        yield { type: "audio", pcm: tone(200) };
        yield { type: "usage", usage: USAGE };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(2000) };
      yield { type: "usage", usage: USAGE };
      await new Promise<void>((resolve) => {
        if (call.signal.aborted) {
          resolve();
          return;
        }
        call.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    transcriber = { async transcribe() { return null; } };
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    sendPcm(ws, tone(1000));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio");
    expect(talker.sessions[0]?.calls[0]?.signal.aborted).toBe(true);
    ws.send(JSON.stringify({ type: "played", ms: 1000 }));
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved");
    const caption = box.frames.find((frame) => frame.type === "caption" && frame.role === "assistant" && frame.final);
    expect(caption && caption.type === "caption" ? caption.interrupted : false).toBe(true);
    expect(caption && caption.type === "caption" ? caption.text : "").toBe("alpha bravo charlie");
    const rows = await listMessages(tenant, threadId);
    const saved = rows.slice(-2);
    expect(textOf(saved.find((row) => row.role === "assistant")?.content)).toBe("alpha bravo charlie");
    expect(textOf(saved.find((row) => row.role === "user")?.content)).toBe("Voice message");
    // The browser counts a reply's heard ms from zero at `listening` and nowhere else, so a cut says it before it
    // goes on to hearing the person: otherwise the next reply's `played` would carry this one's.
    const cutAt = box.frames.findIndex((frame) => frame.type === "stop_audio");
    const afterCut = box.frames
      .slice(cutAt)
      .filter((frame) => frame.type === "state")
      .map((frame) => (frame.type === "state" ? frame.value : ""));
    expect(afterCut.slice(0, 2)).toEqual(["listening", "hearing"]);
    sendPcm(ws, silence(800));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) >= 2, "next utterance");
    expect(talker.sessions[0]?.calls[1]?.pcm.length).toBeGreaterThanOrEqual(tone(700).length);
  });

  /** A reply that speaks `ANSWER` and then stays open until it is cut. A longer utterance is answered with "second". */
  function holdsOpenUntilCut(): FakeTalker {
    const held = new FakeTalker();
    held.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.pcm.length > tone(500).length) {
        yield { type: "text", delta: "second" };
        yield { type: "audio", pcm: tone(200) };
        yield { type: "usage", usage: USAGE };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(2000) };
      yield { type: "usage", usage: USAGE };
      await new Promise<void>((resolve) => {
        if (call.signal.aborted) {
          resolve();
          return;
        }
        call.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    return held;
  }

  /** A transcriber whose first answer waits for `release`; later ones are instant. */
  function slowFirstTranscript(): { transcriber: Transcriber; release: (text: string) => void; started: () => number } {
    let release: (text: string) => void = () => {};
    const first = new Promise<string>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    return {
      release: (text) => release(text),
      started: () => calls,
      transcriber: {
        async transcribe() {
          calls += 1;
          if (calls === 1) return { text: await first, seconds: 0.4 };
          return { text: "second words", seconds: 0.4 };
        },
      },
    };
  }

  function threadLines(rows: Awaited<ReturnType<typeof listMessages>>): string[] {
    return rows.map((row) => `${row.role}:${textOf(row.content)}`);
  }

  it("saves the person's own words for a reply cut before the transcript arrived, without holding the next turn", async () => {
    talker = holdsOpenUntilCut();
    const slow = slowFirstTranscript();
    transcriber = slow.transcriber;
    armWiring();
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    await until(() => slow.started() === 1, "the transcriber has the first utterance");
    sendPcm(ws, tone(1000));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio");
    ws.send(JSON.stringify({ type: "played", ms: 1000 }));
    // The words are not in, and the person is heard anyway: the next utterance goes to the talker.
    sendPcm(ws, silence(800));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) >= 2, "the next utterance reaches the talker");
    expect(box.frames.some((frame) => frame.type === "saved")).toBe(false);
    expect(await listMessages(tenant, threadId)).toHaveLength(before);

    slow.release("what is the date");
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved");
    expect(threadLines((await listMessages(tenant, threadId)).slice(before))).toEqual([
      "user:what is the date",
      "assistant:alpha bravo charlie",
    ]);
    // Its caption comes late, under the id the turn had when it was cut.
    const late = box.frames.find(
      (frame) => frame.type === "caption" && frame.role === "user" && frame.final && frame.text === "what is the date",
    );
    expect(late).toBeDefined();
    const second = box.frames.find(
      (frame) => frame.type === "caption" && frame.role === "user" && frame.text === "second words",
    );
    expect(late && late.type === "caption" ? late.id : "same").not.toBe(second && second.type === "caption" ? second.id : "same");
    // The talker is told what it said; the cut turn's words were not known when the next turn began.
    expect(talker.sessions[0]?.remembered[0]).toEqual({ user: null, assistant: "alpha bravo charlie", interrupted: true });

    // The turn after it lands behind it in the thread.
    await until(
      () => box.bins.reduce((sum, bin) => sum + bin.length, 0) >= tone(2000).length + tone(200).length,
      "the second reply",
    );
    clock.advance(5000);
    await until(() => box.frames.filter((frame) => frame.type === "saved").length >= 2, "second saved");
    expect(threadLines((await listMessages(tenant, threadId)).slice(before))).toEqual([
      "user:what is the date",
      "assistant:alpha bravo charlie",
      "user:second words",
      "assistant:second",
    ]);
  });

  it("keeps the person's words when the session ends while the transcript is still on its way", async () => {
    talker = holdsOpenUntilCut();
    const slow = slowFirstTranscript();
    transcriber = slow.transcriber;
    armWiring();
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    await until(() => slow.started() === 1, "the transcriber has the utterance");
    ws.send(JSON.stringify({ type: "stop" }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(box.frames.some((frame) => frame.type === "ended")).toBe(false);
    slow.release("what is the date");
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");
    expect(threadLines((await listMessages(tenant, threadId)).slice(before))).toEqual([
      "user:what is the date",
      `assistant:${ANSWER}`,
    ]);
  });

  it("falls back to the placeholder when the words never arrive for a cut turn", async () => {
    talker = holdsOpenUntilCut();
    transcriber = {
      async transcribe(_pcm, options) {
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        return null;
      },
    };
    armWiring();
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    sendPcm(ws, tone(1000));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio");
    ws.send(JSON.stringify({ type: "played", ms: 1000 }));
    sendPcm(ws, silence(800));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) >= 2, "the next utterance reaches the talker");
    clock.advance(20_001);
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved");
    expect(threadLines((await listMessages(tenant, threadId)).slice(before))).toEqual([
      "user:Voice message",
      "assistant:alpha bravo charlie",
    ]);
  });

  /**
   * An asked reply, cut while the answer is held open: `ackMs` of acknowledgement, then 2 s of answer for
   * `ANSWER` (38 characters). `played` is what the browser reports; null means no `played` arrives and
   * the host estimates from its own clock, `heardMs` after the first audio went out.
   */
  async function cutAnAskedReply(options: { ackMs: number; played: number | null; heardMs?: number }): Promise<{
    caption: { text: string; interrupted: boolean } | null;
    saved: string[];
    remembered: string | undefined;
  }> {
    const ANSWER_MS = 2000;
    talker = new FakeTalker();
    if (options.ackMs > 0) talker.ack = { pcm: tone(options.ackMs), text: "Sebentar, saya cek dulu." };
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-cut", question: "What is on my desk?" };
        return;
      }
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(ANSWER_MS) };
      yield { type: "usage", usage: USAGE };
      await new Promise<void>((resolve) => {
        if (call.signal.aborted) {
          resolve();
          return;
        }
        call.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    transcriber = transcribeOk();
    armWiring(async () => ({ kind: "answer", text: ANSWER, toolCalls: [] }));
    const before = (await listMessages(tenant, threadId)).length;
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    const forwarded = (options.ackMs > 0 ? tone(options.ackMs).length : 0) + tone(ANSWER_MS).length;
    await until(() => box.bins.reduce((sum, bin) => sum + bin.length, 0) >= forwarded, "the acknowledgement and the answer");
    if (options.heardMs) clock.advance(options.heardMs);
    sendPcm(ws, tone(1000));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio");
    if (options.played === null) clock.advance(TURN_TIMING.playedWaitMs);
    else ws.send(JSON.stringify({ type: "played", ms: options.played }));
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved");
    const cut = box.frames.find((frame) => frame.type === "caption" && frame.role === "assistant" && frame.interrupted === true);
    const rows = (await listMessages(tenant, threadId)).slice(before);
    return {
      caption: cut && cut.type === "caption" ? { text: cut.text, interrupted: cut.interrupted === true } : null,
      saved: rows.filter((row) => row.role === "assistant").map((row) => textOf(row.content)),
      remembered: talker.sessions[0]?.remembered.at(-1)?.assistant,
    };
  }

  it("saves nothing of the answer when the cut lands inside the acknowledgement", async () => {
    // 600 ms heard of a 1000 ms acknowledgement: the answer has not started to play.
    const cut = await cutAnAskedReply({ ackMs: 1000, played: 600 });
    expect(cut.caption).toEqual({ text: "", interrupted: true });
    expect(cut.saved).toEqual([]);
    expect(cut.remembered).toBe("");
  });

  it("keeps about half the answer when the cut lands halfway through it, the acknowledgement not counted", async () => {
    // 1000 ms of acknowledgement and 1000 ms of the 2000 ms answer heard. Counting the acknowledgement
    // in the total as well would have said 2000 of 3000 and kept "alpha bravo charlie delta".
    const cut = await cutAnAskedReply({ ackMs: 1000, played: 2000 });
    expect(cut.caption).toEqual({ text: "alpha bravo charlie", interrupted: true });
    expect(cut.saved).toEqual(["alpha bravo charlie"]);
    expect(cut.remembered).toBe("alpha bravo charlie");
  });

  it("does the same on the host's own estimate when no played frame arrives", async () => {
    // 1500 ms since the first audio went out: 1000 of acknowledgement, then 500 of the 2000 ms answer.
    const cut = await cutAnAskedReply({ ackMs: 1000, played: null, heardMs: 1500 });
    expect(cut.caption).toEqual({ text: "alpha", interrupted: true });
    expect(cut.saved).toEqual(["alpha"]);
  });

  it("is unchanged when there is no acknowledgement", async () => {
    const half = await cutAnAskedReply({ ackMs: 0, played: 1000 });
    expect(half.caption).toEqual({ text: "alpha bravo charlie", interrupted: true });
    expect(half.saved).toEqual(["alpha bravo charlie"]);
    resetVoiceSessionsForTests();
    const estimated = await cutAnAskedReply({ ackMs: 0, played: null, heardMs: 1000 });
    expect(estimated.caption).toEqual({ text: "alpha bravo charlie", interrupted: true });
    expect(estimated.saved).toEqual(["alpha bravo charlie"]);
  });

  it("resumes on a short backchannel and on a barge with no speech", async () => {
    talker = new FakeTalker();
    talker.hear = async () => "iya";
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(2000) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    sendPcm(ws, pcm(tone(200), silence(300)));
    await until(() => box.frames.some((frame) => frame.type === "resume_audio"), "resume");
    expect(talker.sessions[0]?.calls[0]?.signal.aborted).toBe(false);

    const quiet = await openReady();
    sendPcm(quiet.ws, pcm(tone(200), silence(800)));
    await until(() => states(quiet.box).includes("speaking"), "speaking again");
    quiet.ws.send(JSON.stringify({ type: "barge_in" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock.advance(600);
    await until(() => quiet.box.frames.some((frame) => frame.type === "resume_audio"), "silent barge");
    expect(talker.sessions.at(-1)?.calls[0]?.signal.aborted).toBe(false);
  });

  it("counts the speech itself over the reply: a 0.55 s 'iya' is a backchannel, not an interruption", async () => {
    // The eval's `backchannel.wav` is 0.55 s of speech. The audio the host keeps from before the detector was
    // sure (200 ms) and the quiet it waits out afterwards (300 ms) are not speech, and counted as it was they
    // carried a 0.55 s sound past the 700 ms line.
    talker = new FakeTalker();
    talker.hear = async () => "iya";
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(3000) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    sendPcm(ws, pcm(tone(550), silence(500)));
    await until(() => box.frames.some((frame) => frame.type === "resume_audio"), "resume");
    expect(box.frames.some((frame) => frame.type === "stop_audio")).toBe(false);
    expect(talker.sessions[0]?.calls[0]?.signal.aborted).toBe(false);
  });

  it("interrupts when the speech itself passes 700 ms, while the person is still speaking", async () => {
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(3000) };
      yield { type: "usage", usage: USAGE };
      await new Promise<void>((resolve) => {
        if (call.signal.aborted) {
          resolve();
          return;
        }
        call.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    // 650 ms of speech and no quiet after it: under the line, so nothing is cut yet.
    sendPcm(ws, tone(650));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(box.frames.some((frame) => frame.type === "stop_audio")).toBe(false);
    // Speech that carries on past 700 ms is cut without waiting for it to end.
    sendPcm(ws, tone(150));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio");
  });

  it("lets push-to-talk ignore silence until commit", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady("push_to_talk");
    ws.send(JSON.stringify({ type: "commit" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(talker.sessions[0]?.calls ?? []).toHaveLength(0);
    sendPcm(ws, pcm(tone(200), silence(2000)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(talker.sessions[0]?.calls ?? []).toHaveLength(0);
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) === 1, "commit");
    expect(talker.sessions[0]?.calls[0]?.mustAnswer).toBe(true);
    await playOut(box);
  });

  it("handles immediate-onset PTT speech starting loudly on frame 0 and short PTT bursts on commit", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady("push_to_talk");
    // Loud speech from sample 0 with no leading silence: must NOT raise floor to suppress speech_start.
    sendPcm(ws, tone(300, 0.25));
    await until(() => states(box).includes("hearing"), "immediate onset hearing");
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) === 1, "immediate commit");
    await playOut(box);

    // Short <120 ms speech energy with commit still commits cleanly via energy fallback.
    sendPcm(ws, tone(80, 0.15));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) === 2, "short burst commit");
    await playOut(box);
  });

  it("commits PTT barge-in over speaking agent (<700 ms and >=700 ms during waitPlayed) without stranding", async () => {
    talker = new FakeTalker();
    let turn = 0;
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      turn += 1;
      if (turn === 1 || turn === 3) {
        yield { type: "text", delta: ANSWER };
        yield { type: "audio", pcm: tone(3000) };
        yield { type: "usage", usage: USAGE };
        await new Promise<void>((resolve) => {
          if (call.signal.aborted) {
            resolve();
            return;
          }
          call.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      yield { type: "text", delta: "Second reply" };
      yield { type: "audio", pcm: tone(200) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady("push_to_talk");

    // Turn 1: trigger agent speaking (3 s audio).
    sendPcm(ws, tone(200));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => states(box).includes("speaking"), "speaking turn 1");

    // Case A: PTT barge-in <700 ms (barge_in + 300 ms tone + commit).
    ws.send(JSON.stringify({ type: "barge_in" }));
    sendPcm(ws, tone(300));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "stop_audio <700ms");
    ws.send(JSON.stringify({ type: "played", ms: 200 }));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) === 2, "committed <700ms PTT barge-in");
    await until(() => box.frames.some((frame) => frame.type === "caption" && frame.text === "Second reply"), "reply 2");
    await playOut(box);

    // Case B: PTT barge-in >=700 ms where commit arrives WHILE doInterrupt() is awaiting waitPlayed().
    sendPcm(ws, tone(200));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ws.send(JSON.stringify({ type: "commit" }));
    await until(() => states(box).filter((s) => s === "speaking").length >= 3, "speaking turn 3");

    ws.send(JSON.stringify({ type: "barge_in" }));
    sendPcm(ws, tone(800));
    await until(() => box.frames.filter((frame) => frame.type === "stop_audio").length >= 2, "stop_audio >=700ms");
    // Release Hold (commit) BEFORE sending played (while waitPlayed() is pending!).
    ws.send(JSON.stringify({ type: "commit" }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    ws.send(JSON.stringify({ type: "played", ms: 250 }));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) === 4, "committed >=700ms PTT barge-in");
    await playOut(box);
  });

  it("transitions to thinking after ack during slow ask_nultron and waits for the spoken answer before finalizing", async () => {
    talker = new FakeTalker();
    talker.ack = { pcm: tone(1000), text: "One moment, let me check." };
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      if (call.kind === "reply") {
        yield { type: "ask", callId: "call-slow", question: "Check my Q3 revenue" };
        yield { type: "done" };
        return;
      }
      yield { type: "text", delta: "Revenue was twelve million." };
      yield { type: "audio", pcm: tone(3000) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    let resolveAsk!: (value: AskResult) => void;
    armWiring(
      () =>
        new Promise<AskResult>((resolve) => {
          resolveAsk = resolve;
        }),
    );
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));

    // Ack starts playing -> speaking.
    await until(() => states(box).includes("speaking"), "ack speaking");
    // Advance past the 1 s ack while ask_nultron is still running (5 s total delay) -> must move back to thinking.
    clock.advance(1100);
    await until(() => states(box).slice(-1)[0] === "thinking", "thinking during slow ask");

    // Finish the remaining ~4 s of the 5 s ask delay and return an answer with PII to verify masking too.
    clock.advance(3900);
    resolveAsk({ kind: "answer", text: "Revenue was twelve million, contact rina@example.com.", toolCalls: [] });
    await until(() => states(box).filter((s) => s === "speaking").length === 2, "answer speaking");

    const answerCall = talker.sessions[0]?.calls.find((call) => call.kind === "answer");
    expect(answerCall?.text).not.toContain("rina@example.com");
    expect(answerCall?.text).toContain("[email]");

    // Wait a tick for talker answer `done` to call schedulePlayback().
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Must NOT finalize at delay=0 or mid-answer (1.5 s into a 3 s answer).
    clock.advance(1500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(box.frames.some((frame) => frame.type === "saved")).toBe(false);

    // Advance past the full 3 s spoken answer -> now finalizes and moves to listening.
    clock.advance(1600);
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved after 3 s answer");
    await until(() => states(box).slice(-1)[0] === "listening", "listening after answer");
    expect(states(box)).toEqual(["listening", "hearing", "thinking", "speaking", "thinking", "speaking", "listening"]);
  });

  it("cuts immediately on barge_in with immediate=true without waiting for speech or resuming", async () => {
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) return;
      yield { type: "text", delta: ANSWER };
      yield { type: "audio", pcm: tone(3000) };
      yield { type: "usage", usage: USAGE };
      yield { type: "done" };
    };
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await until(() => states(box).includes("speaking"), "speaking");
    ws.send(JSON.stringify({ type: "barge_in", immediate: true }));
    await until(() => box.frames.some((frame) => frame.type === "stop_audio"), "immediate stop_audio");
    expect(box.frames.some((frame) => frame.type === "resume_audio")).toBe(false);
    ws.send(JSON.stringify({ type: "played", ms: 400 }));
    await until(() => box.frames.some((frame) => frame.type === "saved"), "saved after immediate interrupt");
  });

  it("ends on connect, idle, max length, and a closed socket", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    const created = (await postSession()) as HostJsonResult;
    const id = (created.body as { sessionId: string }).sessionId;
    clock.advance(VOICE_LIMITS.connectMs);
    expect(voiceSessions().get(id)?.endedReason).toBe("dropped");
    expect(voiceSessions().openCount()).toBe(0);

    const idle = await openReady();
    clock.advance(VOICE_LIMITS.idleMs);
    await until(() => idle.box.frames.some((frame) => frame.type === "ended" && frame.reason === "idle"), "idle");

    const limited = await openReady();
    let stepped = 0;
    while (stepped < VOICE_LIMITS.maxSessionMs) {
      limited.ws.send(JSON.stringify({ type: "mode", value: "hands_free" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const step = Math.min(110_000, VOICE_LIMITS.maxSessionMs - stepped);
      clock.advance(step);
      stepped += step;
      if (limited.box.frames.some((frame) => frame.type === "ended")) break;
    }
    await until(
      () => limited.box.frames.some((frame) => frame.type === "ended" && frame.reason === "max_length"),
      "max_length",
    );

    const dropped = await openReady();
    dropped.ws.close();
    await until(() => voiceSessions().get(dropped.created.sessionId)?.endedReason === "dropped", "socket close");
    expect(voiceSessions().openCount()).toBe(0);
  });

  it("ends when inbound audio is faster than real time", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    const { ws, box } = await openReady();
    for (let i = 0; i < 4; i += 1) ws.send(Buffer.alloc(VOICE_MAX_AUDIO_FRAME_BYTES));
    await new Promise((resolve) => setTimeout(resolve, 30));
    clock.advance(1000);
    ws.send(Buffer.alloc(960));
    await until(() => box.frames.some((frame) => frame.type === "ended" && frame.reason === "dropped"), "flood");
  });

  it("saves a placeholder when transcription fails twice and ends after three talker failures", async () => {
    talker = new FakeTalker();
    let attempts = 0;
    transcriber = {
      async transcribe() {
        attempts += 1;
        return null;
      },
    };
    armWiring();
    const { ws, box } = await openReady();
    sendPcm(ws, pcm(tone(200), silence(800)));
    await playOut(box);
    expect(attempts).toBe(2);
    const rows = await listMessages(tenant, threadId);
    expect(textOf(rows.at(-2)?.content)).toBe("Voice message");

    resetVoiceSessionsForTests();
    talker = new FakeTalker();
    talker.script = async function* (call) {
      await Promise.resolve();
      if (call.signal.aborted) {
        yield { type: "done" };
        return;
      }
      throw new TalkerError("unavailable", "down");
    };
    armWiring();
    const failing = await openReady();
    for (let i = 0; i < 3; i += 1) {
      const heard = states(failing.box).filter((value) => value === "listening").length;
      sendPcm(failing.ws, pcm(tone(200), silence(800)));
      await until(() => (talker.sessions[0]?.calls.length ?? 0) >= i + 1, `failure ${i + 1}`);
      await until(
        () =>
          failing.box.frames.some((frame) => frame.type === "ended") ||
          states(failing.box).filter((value) => value === "listening").length > heard,
        `listening after ${i + 1}`,
      );
    }
    // Transient errors #1 and #2 emit a retry/status caption instead of dropping silently.
    const retryCaptions = failing.box.frames.filter(
      (frame) => frame.type === "caption" && frame.role === "assistant" && frame.text.includes("hiccup"),
    );
    expect(retryCaptions).toHaveLength(2);
    await until(() => failing.box.frames.some((frame) => frame.type === "ended" && frame.reason === "error"), "error");
  });

  it("allows voice by default when unset, and refuses every voice route and upgrade when AGENTFORGE_VOICE=off", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    delete process.env.AGENTFORGE_VOICE;
    const defaultOn = await postSession();
    expect(defaultOn.status).toBe(201);
    if (defaultOn.status === 201) {
      await endSession((defaultOn as HostJsonResult & { body: { sessionId: string } }).body.sessionId);
    }

    process.env.AGENTFORGE_VOICE = "off";
    const created = await postSession();
    expect(created.status).toBe(403);
    const planted = voiceSessions().open({
      tenant,
      threadId,
      mode: "hands_free",
      locale: "en",
      model: "fake-talker",
      talker,
      transcriber,
      transcriberModel: TRANSCRIBER_MODEL,
    });
    expect(planted.ok).toBe(true);
    if (!planted.ok) return;
    expect(await refused(`/api/v1/voice/sessions/${planted.session.id}/stream`)).toBe(403);
    const missing = await endSession("not-a-session");
    expect(missing.status).toBe(404);
    expect(outboundBacklogTooHigh(VOICE_OUTBOUND_BACKLOG_BYTES + 1)).toBe(true);
    expect(outboundBacklogTooHigh(0)).toBe(false);
  });

  it("joins a session only on the desk it was opened on, selected by the workspace cookie (off the hosted server)", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    const { db, createLocalWorkspace } = await import("@agentforge/db");
    const second = await createLocalWorkspace(db, tenant.organizationId, "Second desk", undefined, undefined, tenant.userId);
    const onSecond = await getTenant(second.id);
    expect(onSecond.workspaceId).toBe(second.id);
    expect(onSecond.workspaceId).not.toBe(tenant.workspaceId);
    const chat = await agentService.ensureDefaultChat(onSecond);
    const thread = await createThread(onSecond, chat.agent.id, "Voice on the second desk");
    if (!thread) throw new Error("thread was not created");

    // H1 as the adapter would call it with the desk cookie: `request.workspaceId` is the cookie's desk.
    const created = (await postSession({ threadId: thread.id }, second.id)) as HostJsonResult;
    expect(created.status).toBe(201);
    const path = (created.body as { streamPath: string }).streamPath;

    // No cookie falls back to the machine's selected desk, which is the first one: not this session's.
    expect(await refused(path)).toBe(404);
    // Another desk's cookie, and a cookie naming no desk at all.
    expect(await refused(path, { cookie: `${WORKSPACE_COOKIE}=${tenant.workspaceId}` })).toBe(404);
    expect(await refused(path, { cookie: `other=1; ${WORKSPACE_COOKIE}=not-a-desk-of-anyone` })).toBe(404);
    // The cookie H1 was called with.
    const ws = connect(path, { cookie: `theme=dark; ${WORKSPACE_COOKIE}=${second.id}` });
    const box = collect(ws);
    await until(() => box.frames.some((frame) => frame.type === "ready"), "ready on the cookie-selected desk");
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");
  });

  it("joins a session only on the desk it was opened on, selected by the workspace cookie (hosted server)", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    hostedLikeNoMachineDesk();
    const { db, ensurePortalOwner, createLocalWorkspace, resolvePortalTenant } = await import("@agentforge/db");
    const identity = { tenantId: "voice-cookie-tenant", orgId: "voice-cookie-org", userId: "voice-cookie-user" };
    await ensurePortalOwner(db, { ...identity, role: "owner" });
    const home = await resolvePortalTenant(db, identity);
    if (!home.ok) throw new Error(`hosted person did not resolve: ${home.code}`);
    const second = await createLocalWorkspace(db, home.tenant.organizationId, "Hosted second desk", undefined, undefined, identity.userId);
    const onSecond = await resolvePortalTenant(db, identity, second.id);
    if (!onSecond.ok) throw new Error(`hosted second desk did not resolve: ${onSecond.code}`);

    const at = clock.now();
    const sessions = createMemorySessionStore();
    const signedIn = createSession({ ...identity, now: at });
    await sessions.create(signedIn);
    upgradeOptions.serverMode = true;
    upgradeOptions.sessionStore = sessions;
    upgradeOptions.portalCheck = portalCheck;
    upgradeOptions.now = () => at;
    process.env.AGENTFORGE_TRUSTED_ORIGINS = "https://desk.example";
    const signIn = `${sessionCookieName({ secure: true })}=${signedIn.id}`;
    const hosted = (cookie: string) => ({
      origin: "https://desk.example",
      host: "desk.example",
      "x-forwarded-proto": "https",
      cookie,
    });

    // What H1 would have opened for this person on the second desk.
    const opened = voiceSessions().open({
      tenant: onSecond.tenant,
      threadId: "hosted-voice-thread",
      mode: "hands_free",
      locale: "en",
      model: "fake-talker",
      talker,
      transcriber,
      transcriberModel: TRANSCRIBER_MODEL,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const path = `/api/v1/voice/sessions/${opened.session.id}/stream`;

    expect(await refused(path, hosted(signIn))).toBe(404);
    expect(await refused(path, hosted(`${signIn}; ${WORKSPACE_COOKIE}=${home.tenant.workspaceId}`))).toBe(404);
    // A desk of someone else's company is the router's own answer for it: the desk does not exist.
    expect(await refused(path, hosted(`${signIn}; ${WORKSPACE_COOKIE}=not-a-desk-of-anyone`))).toBe(404);
    const ws = connect(path, hosted(`${signIn}; ${WORKSPACE_COOKIE}=${second.id}`));
    const box = collect(ws);
    await until(() => box.frames.some((frame) => frame.type === "ready"), "ready on the cookie-selected desk");
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");
  });

  it("refuses an upgrade whose Host is not loopback, before it looks at anything else (off the hosted server)", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    const created = (await postSession()) as HostJsonResult;
    const path = (created.body as { streamPath: string }).streamPath;
    // A page on another name that resolves to this machine (DNS rebinding) sends its own name as Host.
    expect(await refused(path, { host: "evil.example" })).toBe(403);
    expect(await refused(path, { host: `evil.example:${port}` })).toBe(403);
    expect(await refused(path, { host: `127.0.0.1.evil.example:${port}` })).toBe(403);
    // The same request with the loopback Host is the one that connects.
    const ws = connect(path, { host: `localhost:${port}` });
    const box = collect(ws);
    await until(() => box.frames.some((frame) => frame.type === "ready"), "ready with a loopback Host");
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");
  });

  it("refuses an upgrade whose Host is not a trusted host, even with a good session, Origin and https (hosted server)", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    hostedLikeNoMachineDesk();
    const { db, ensurePortalOwner, resolvePortalTenant } = await import("@agentforge/db");
    const identity = { tenantId: "voice-host-tenant", orgId: "voice-host-org", userId: "voice-host-user" };
    await ensurePortalOwner(db, { ...identity, role: "owner" });
    const resolved = await resolvePortalTenant(db, identity);
    if (!resolved.ok) throw new Error(`hosted person did not resolve: ${resolved.code}`);
    const at = clock.now();
    const sessions = createMemorySessionStore();
    const signedIn = createSession({ ...identity, now: at });
    await sessions.create(signedIn);
    upgradeOptions.serverMode = true;
    upgradeOptions.sessionStore = sessions;
    upgradeOptions.portalCheck = portalCheck;
    upgradeOptions.now = () => at;
    process.env.AGENTFORGE_TRUSTED_ORIGINS = "https://desk.example";
    const opened = voiceSessions().open({
      tenant: resolved.tenant,
      threadId: "hosted-voice-thread",
      mode: "hands_free",
      locale: "en",
      model: "fake-talker",
      talker,
      transcriber,
      transcriberModel: TRANSCRIBER_MODEL,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const path = `/api/v1/voice/sessions/${opened.session.id}/stream`;
    const cookie = `${sessionCookieName({ secure: true })}=${signedIn.id}`;
    const good = { origin: "https://desk.example", "x-forwarded-proto": "https", cookie };

    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
    try {
      expect(await refused(path, { ...good, host: `127.0.0.1:${port}` })).toBe(403);
      expect(await refused(path, { ...good, host: "evil.example" })).toBe(403);
      expect(await refused(path, { ...good, host: "desk.example.evil.example" })).toBe(403);
    } finally {
      spy.mockRestore();
    }
    // The hosted server leaves the adapter's own line for it: a reason, a status, no path, no id.
    const filtered = lines.filter((line) => line.includes('"event":"request_filtered"'));
    expect(filtered).toHaveLength(3);
    expect(filtered.every((line) => line.includes('"status":403') && line.includes('"code":"origin_forbidden"'))).toBe(true);
    expect(lines.some((line) => line.includes(opened.session.id) || line.includes(signedIn.id))).toBe(false);

    // The same request with the trusted Host is the one that connects.
    const ws = connect(path, { ...good, host: "desk.example" });
    const box = collect(ws);
    await until(() => box.frames.some((frame) => frame.type === "ready"), "ready with the trusted Host");
    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");
  });

  it("meters hosted upgrades with the adapter's per-IP bucket and answers 429 past it", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    enableVoice();
    upgradeOptions.serverMode = true;
    upgradeOptions.sessionStore = createMemorySessionStore();
    upgradeOptions.portalCheck = portalCheck;
    process.env.AGENTFORGE_TRUSTED_ORIGINS = "https://desk.example";
    process.env.AGENTFORGE_RATE_IP_RPM = "3";
    resetRateLimiters();
    const path = `/api/v1/voice/sessions/${"a".repeat(22)}/stream`;
    const hosted = { origin: "https://desk.example", host: "desk.example", "x-forwarded-proto": "https" };
    const answers: number[] = [];
    for (let i = 0; i < 5; i += 1) answers.push(await refused(path, hosted));
    // The first three get as far as the session gate (no cookie: 401); the rest never reach it.
    expect(answers).toEqual([401, 401, 401, 429, 429]);
  });

  it("keeps the gateway key out of every log line, frame, response, saved row and ledger row", async () => {
    const SENTINEL = "voice-sentinel-key-6b1f0c9d2e47a83b";
    const seen: Array<{ url: string; authorization: string | null; body: string }> = [];
    const stub = { ask: false, fail: false };
    const chunk = (delta: unknown) => ({ choices: [{ delta }] });
    const sse = (...frames: unknown[]): Response =>
      new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const spoken = (pcm: Buffer, words: string): unknown => chunk({ audio: { data: pcm.toString("base64"), transcript: words } });
    const usage = { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } };
    const gateway = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), body });
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "what is on my desk" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(body) as {
        modalities?: string[];
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const messages = request.messages ?? [];
      if (messages.at(-1)?.content === ACK_SENTENCE.en) return sse(spoken(tone(120), ACK_SENTENCE.en), usage);
      if (request.modalities?.length === 1) return sse(chunk({ content: "iya" }), usage);
      if (messages.some((message) => message.role === "tool")) return sse(spoken(tone(300), "The desk is clear."), usage);
      if (stub.fail) {
        // A gateway that echoes the credential it was sent.
        return new Response(JSON.stringify({ error: { message: `bad credential ${SENTINEL}` } }), { status: 500 });
      }
      if (stub.ask) {
        return sse(
          chunk({
            tool_calls: [{ index: 0, id: "call-key", function: { name: ASK_NULTRON_NAME, arguments: '{"question":"What is on my desk?"}' } }],
          }),
          usage,
        );
      }
      return sse(spoken(tone(2000), "hello from the desk"), usage);
    }) as typeof fetch;

    // The real talker answers over several ticks, so the clock is moved a little at a time, with real
    // pauses between, until the turn is saved. (`playOut` moves it once and can move it too early.)
    const playThrough = async (box: Box): Promise<void> => {
      const savedBefore = box.frames.filter((frame) => frame.type === "saved").length;
      const startedAt = Date.now();
      while (box.frames.filter((frame) => frame.type === "saved").length <= savedBefore) {
        if (Date.now() - startedAt > 4000) throw new Error("timed out waiting for saved");
        await new Promise((resolve) => setTimeout(resolve, 10));
        clock.advance(200);
      }
    };

    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      }),
    );
    vi.stubGlobal("fetch", gateway);
    process.env.AGENTFORGE_RUNTIME = "ai";
    process.env.OPENAI_API_KEY = SENTINEL;
    resetTalkerCachesForTests();
    clock = manualClock(1_000_000);
    // No `modelsFor`: the production wiring opens the real talker and transcriber with the key.
    setVoiceWiringForTests({ clock, ask: async () => ({ kind: "answer", text: "The desk is clear.", toolCalls: [] }) });
    try {
      enableVoice();
      const created = (await postSession()) as HostJsonResult;
      expect(created.status).toBe(201);
      const path = (created.body as { streamPath: string }).streamPath;
      const raw: string[] = [];
      const ws = connect(path);
      const box = collect(ws);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) raw.push(data.toString());
      });
      await until(() => box.frames.some((frame) => frame.type === "ready"), "ready");
      await whenAcknowledgementSettled({ model: "qwen3.5-omni-flash", voice: VOICE_DEFAULT_VOICE, locale: "en" });

      // A plain turn, with a short "iya" over the reply that the host reads with `hearShort`.
      sendPcm(ws, pcm(tone(200), silence(800)));
      await until(() => states(box).includes("speaking"), "speaking");
      sendPcm(ws, pcm(tone(200), silence(300)));
      await until(() => box.frames.some((frame) => frame.type === "resume_audio"), "resume");
      await playThrough(box);

      // A turn the talker sends to the desk: acknowledgement first, then the answer.
      stub.ask = true;
      sendPcm(ws, pcm(tone(200), silence(800)));
      await playThrough(box);
      stub.ask = false;

      // A turn the gateway fails on, with the credential in its error body.
      stub.fail = true;
      const listening = states(box).filter((value) => value === "listening").length;
      sendPcm(ws, pcm(tone(200), silence(800)));
      await until(() => states(box).filter((value) => value === "listening").length > listening, "listening after the failure");
      stub.fail = false;

      ws.send(JSON.stringify({ type: "stop" }));
      await until(() => box.frames.some((frame) => frame.type === "ended"), "ended");

      // The key reached the gateway on the transcription and on the model calls, and only in the header.
      expect(seen.some((call) => call.url.endsWith("/audio/transcriptions") && call.authorization === `Bearer ${SENTINEL}`)).toBe(true);
      expect(seen.some((call) => call.url.endsWith("/chat/completions") && call.authorization === `Bearer ${SENTINEL}`)).toBe(true);
      expect(seen.every((call) => call.authorization === `Bearer ${SENTINEL}` && !call.body.includes(SENTINEL))).toBe(true);
      expect(seen.some((call) => call.body.includes('"modalities":["text"]'))).toBe(true);

      // And nowhere else.
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes("voice_reply_failed"))).toBe(true);
      expect(lines.filter((line) => line.includes(SENTINEL))).toEqual([]);
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.filter((text) => text.includes(SENTINEL))).toEqual([]);
      expect(box.bins.some((bin) => bin.includes(SENTINEL))).toBe(false);
      expect(JSON.stringify(created.body)).not.toContain(SENTINEL);
      expect(JSON.stringify(await listMessages(tenant, threadId))).not.toContain(SENTINEL);
      expect(JSON.stringify(listTenantUsage(tenant))).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllGlobals();
      for (const spy of spies) spy.mockRestore();
      delete process.env.OPENAI_API_KEY;
      resetTalkerCachesForTests();
    }
  });
});
