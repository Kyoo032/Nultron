/**
 * The host voice relay, driven with a scripted talker, a clock the test moves, and a real socket
 * on 127.0.0.1 port 0. No gateway call.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import {
  VOICE_LIMITS,
  VOICE_MAX_AUDIO_FRAME_BYTES,
  VOICE_STREAM_PATH_PATTERN,
  parseVoiceHostFrame,
  type VoiceHostFrame,
  type VoiceMode,
} from "@agentforge/core/voice";
import { WebSocket } from "ws";
import { createMemorySessionStore } from "../auth/session-store";
import type { PortalSessionCheck } from "../auth/portal-check";
import type { HostJsonResult, HostResult } from "../types";
import { dispatch } from "../router";
import { agentService, getTenant } from "../tenant";
import { createThread, listMessages } from "../threads";
import { listTenantUsage } from "../tenant-usage";
import { manualClock, type ManualClock } from "./clock";
import { outboundBacklogTooHigh, pcmDurationMs, VOICE_OUTBOUND_BACKLOG_BYTES } from "./pcm";
import { resetVoiceSessionsForTests, voiceSessions } from "./sessions";
import { TalkerError, type Talker, type TalkerEvent, type TalkerSession, type TalkerUsage, type Transcriber } from "./talker";
import { attachVoiceUpgrade, type VoiceUpgradeOptions } from "./upgrade";
import { setVoiceWiringForTests, type VoiceWiring } from "./wiring";
import type { AskResult } from "./ask";

const USAGE: TalkerUsage = { inputTokens: 3, outputTokens: 5, inputAudioTokens: 1, outputAudioTokens: 4 };
const ANSWER = "alpha bravo charlie delta echo foxtrot";

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
    modelsFor: () => ({ talker, transcriber }),
    ...(ask ? { ask } : {}),
  });
}

async function postSession(body: { threadId: string; mode?: VoiceMode } = { threadId }): Promise<HostResult> {
  return dispatch({
    method: "POST",
    path: "/api/v1/voice/sessions",
    query: {},
    params: {},
    headers: {},
    body,
  });
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
    process.env.AGENTFORGE_RUNTIME = "stub";
    upgradeOptions.serverMode = undefined;
    upgradeOptions.sessionStore = undefined;
    upgradeOptions.portalCheck = undefined;
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
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(await refused(`/api/v1/voice/sessions/${foreign.session.id}/stream`)).toBe(404);

    delete process.env.AGENTFORGE_VOICE;
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
    expect(await refused(securePath, { origin: "https://desk.example" })).toBe(403);
    expect(
      await refused(securePath, { origin: "https://desk.example", "x-forwarded-proto": "https" }),
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
    const answer: AskResult = { kind: "answer", text: "The desk is clear." };
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
    sendPcm(ws, silence(800));
    await until(() => (talker.sessions[0]?.calls.length ?? 0) >= 2, "next utterance");
    expect(talker.sessions[0]?.calls[1]?.pcm.length).toBeGreaterThanOrEqual(tone(700).length);
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
    await until(() => failing.box.frames.some((frame) => frame.type === "ended" && frame.reason === "error"), "error");
  });

  it("refuses every voice route and the upgrade when the flag is unset", async () => {
    talker = new FakeTalker();
    transcriber = transcribeOk();
    armWiring();
    delete process.env.AGENTFORGE_VOICE;
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
    });
    expect(planted.ok).toBe(true);
    if (!planted.ok) return;
    expect(await refused(`/api/v1/voice/sessions/${planted.session.id}/stream`)).toBe(403);
    const missing = await endSession("not-a-session");
    expect(missing.status).toBe(404);
    expect(outboundBacklogTooHigh(VOICE_OUTBOUND_BACKLOG_BYTES + 1)).toBe(true);
    expect(outboundBacklogTooHigh(0)).toBe(false);
  });
});
