/**
 * A fake desk for the runner's own tests: a loopback `http` + `ws` server that speaks the voice protocol from a
 * script. It is not the relay and shares no code with it. What it does share is the host's voice detector
 * (`createVad`) and trim rule (`trimToHeard`), so it takes turns on the real audio the client streams:
 *
 * - A clip is recognised by the exact bytes of its first non-silent frame (the client sends fixture frames
 *   unchanged), so the fake knows what was "said" without a speech model.
 * - Hands-free: a turn is answered after 700 ms of silence, unless its last clip is `unfinished`.
 * - Speech over the agent for 700 ms is an interruption (`stop_audio`, the cut reply's final caption marked
 *   `interrupted` with the text trimmed to what was heard); a shorter one is a backchannel (`resume_audio`).
 * - A fact makes it think, say an acknowledgement, then answer; a task makes it think and send a card.
 *
 * Every wrong behaviour the cases must catch is one switch in `FakeBehavior`, off by default. All of its delays
 * go through the clock it is given, so a test can run a turn at several times real speed.
 */
import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  VOICE_STREAM_PATH_PATTERN,
  type VoiceBrowserFrame,
  type VoiceHostFrame,
  type VoiceMode,
  parseVoiceBrowserFrame,
  voiceStreamPath,
} from "@agentforge/core/voice";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { trimToHeard } from "../../src/voice/turns";
import { createVad } from "../../src/voice/vad";
import { FIXTURE_NAMES, FRAME_BYTES, FRAME_MS, type FixtureName, loadFixtures, splitFrames } from "./audio";
import type { Clock } from "./clock";

export type FakeBehavior = {
  /** Wrong: the first audio of every reply comes this much later. */
  extraReplyDelayMs: number;
  /** Wrong: answers the unfinished clip after only 300 ms of silence. */
  answersUnfinished: boolean;
  /** Wrong: never sends `stop_audio`. */
  ignoresBargeIn: boolean;
  /** Wrong: cuts the reply for a backchannel. */
  stopsOnBackchannel: boolean;
  /** Wrong: never sends `saved` and never writes the thread. */
  neverSaves: boolean;
  /** Wrong: accepts the upgrade with no Origin or a foreign one. */
  acceptsWithoutOrigin: boolean;
  /** Wrong: a second session does not end the first (H1 answers 429 instead). */
  neverReplaces: boolean;
  /** Wrong: the second H3 answers 404. */
  endsOnceOnly: boolean;
  /** Wrong: a fact is answered at once, with no thinking and no acknowledgement. */
  factWithoutAck: boolean;
  /** Wrong: a task is answered aloud and a write is saved to the thread. */
  taskAsSpeech: boolean;
  /** Wrong: push-to-talk replies on silence, without a commit. */
  pushToTalkAutoEnds: boolean;
  /** How late the person's own caption arrives after the turn ends. */
  userCaptionDelayMs: number;
  /** H1 answers this refusal instead of a session. */
  refuseH1: "gateway_blocked" | "voice_model_unavailable" | "voice_session_limit" | null;
  /** The settings route says voice is on. */
  voiceEnabled: boolean;
  /** The settings route says `runtime`. */
  runtime: string;
};

export const CORRECT_HOST: FakeBehavior = {
  extraReplyDelayMs: 0,
  answersUnfinished: false,
  ignoresBargeIn: false,
  stopsOnBackchannel: false,
  neverSaves: false,
  acceptsWithoutOrigin: false,
  neverReplaces: false,
  endsOnceOnly: false,
  factWithoutAck: false,
  taskAsSpeech: false,
  pushToTalkAutoEnds: false,
  userCaptionDelayMs: 400,
  refuseH1: null,
  voiceEnabled: true,
  runtime: "ai",
};

export type SeenRequest = { method: string; path: string; origin: string | null; csrfOk: boolean; hadCookie: boolean };
export type SeenUpgrade = { origin: string | null; accepted: boolean };

export type FakeHost = {
  readonly base: string;
  readonly behavior: FakeBehavior;
  readonly requests: SeenRequest[];
  readonly upgrades: SeenUpgrade[];
  /** The session cookie value the fake hands out, so a test can check it never leaks into output. */
  readonly sessionCookie: string;
  /** The words the fake speaks, so a test can check they never leak into output. */
  readonly spoken: readonly string[];
  close(): Promise<void>;
};

export const FAKE_SPEECH = {
  smalltalk: "Halo, kabar saya baik. Terima kasih sudah bertanya, ada yang bisa saya bantu hari ini?",
  long: "Baik, saya sudah cek laporannya. Bagian anggaran dan jadwal perlu direvisi, nanti saya rangkum perubahannya satu per satu.",
  ack: "Sebentar, saya cek dulu.",
  answer: "Total penjualan bulan lalu adalah seratus dua puluh juta rupiah, naik sedikit dari bulan sebelumnya.",
  card: "Sudah saya siapkan, silakan ketuk kartunya.",
  stop: "Baik, saya berhenti.",
  generic: "Baik, saya dengar.",
} as const;

type SpeechKind = keyof typeof FAKE_SPEECH;

/** How long each reply's audio is. */
const AUDIO_MS: Record<SpeechKind, number> = {
  smalltalk: 4_200,
  long: 3_000,
  ack: 1_400,
  answer: 2_500,
  card: 1_500,
  stop: 1_500,
  generic: 1_200,
};

const THINKER_MS = 1_500;
const ACK_DELAY_MS = 250;
const REPLY_DELAY_MS = 250;
const CHUNK_MS = 100;
const END_SILENCE_MS = 700;
const EARLY_END_SILENCE_MS = 300;
const MAX_SILENCE_MS = 2_500;
const INTERRUPT_MS = 700;
const PLAYED_WAIT_MS = 300;

/** What the speech model would have heard of each clip (it hears "Stop, tunggu dulu." as "Tunggu dulu."). */
const HEARD: Record<FixtureName, string> = {
  fact: "Berapa total penjualan saya bulan lalu?",
  smalltalk: "Halo, apa kabar hari ini?",
  task: "Tolong buatkan deck dari riset kemarin.",
  unfinished: "Saya mau pesan yang",
  backchannel: "E ya!",
  stop: "Tunggu dulu.",
  long: "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan jadwal.",
};

function fingerprints(): Map<string, FixtureName> {
  const found = new Map<string, FixtureName>();
  const fixtures = loadFixtures();
  for (const name of FIXTURE_NAMES) {
    const frame = splitFrames(fixtures[name].pcm).find((candidate) => candidate.some((byte) => byte !== 0));
    if (frame) {
      found.set(createHash("sha1").update(frame).digest("hex"), name);
    }
  }
  return found;
}

/** RMS of one frame of PCM16 samples, 0 to 1. */
function rmsOf(frame: Buffer): number {
  const samples = frame.length / 2;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

type Reply = {
  readonly id: string;
  readonly text: string;
  readonly totalMs: number;
  readonly userText: string;
  cancelled: boolean;
};

type Message = { role: "user" | "assistant"; text: string; extra?: Record<string, unknown>[] };

type FakeHostInternals = {
  readonly clock: Clock;
  readonly behavior: FakeBehavior;
  readonly prints: Map<string, FixtureName>;
  readonly threads: Map<string, Message[]>;
  readonly spokenWords: string[];
  sessionClosed(session: FakeSession): void;
};

class FakeSession {
  closed = false;
  mode: VoiceMode;
  private ws: WebSocket | null = null;
  private readonly vad = createVad();
  private readonly arrivals: number[] = [];
  private pendingClips: FixtureName[] = [];
  private busy = false;
  private reply: Reply | null = null;
  /** Speech over the agent: where it began and where its last loud frame ended (the detector's hangover is not speech). */
  private over: { startMs: number; lastLoudMs: number; decided: boolean } | null = null;
  private lastEndMs = 0;
  /** The detector has reported speech that no turn has taken yet. */
  private utteranceOpen = false;
  /** The frame just received carried speech-level sound. */
  private frameLoud = false;
  private playedMs = 0;
  private playedWaiter: (() => void) | null = null;
  private counter = 0;

  constructor(
    readonly id: string,
    readonly threadId: string,
    mode: VoiceMode,
    private readonly host: FakeHostInternals,
  ) {
    this.mode = mode;
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const buffer = toBuffer(data);
      if (isBinary) {
        this.onAudio(buffer);
        return;
      }
      const frame = parseVoiceBrowserFrame(buffer.toString("utf8"));
      if (frame) {
        this.onFrame(frame);
      }
    });
    ws.on("close", () => {
      this.closed = true;
      this.host.sessionClosed(this);
    });
    ws.on("error", () => undefined);
    this.send({ type: "ready", sessionId: this.id, threadId: this.threadId, endsAt: Date.now() + 900_000 });
    this.send({ type: "state", value: "listening" });
  }

  send(frame: VoiceHostFrame): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  end(reason: "user" | "replaced"): void {
    if (this.closed) {
      return;
    }
    this.send({ type: "ended", reason });
    this.closed = true;
    if (this.reply) {
      this.reply.cancelled = true;
    }
    this.ws?.close(1000, reason);
  }

  private onFrame(frame: VoiceBrowserFrame): void {
    switch (frame.type) {
      case "played":
        this.playedMs = frame.ms;
        this.playedWaiter?.();
        break;
      case "mode":
        this.mode = frame.value;
        break;
      case "commit":
        if (this.mode === "push_to_talk" && !this.busy && this.pendingClips.length > 0) {
          void this.takeTurn();
        }
        break;
      case "stop":
        this.end("user");
        break;
      default:
        break;
    }
  }

  private onAudio(frame: Buffer): void {
    if (frame.length !== FRAME_BYTES) {
      return;
    }
    this.arrivals.push(this.host.clock.now());
    this.frameLoud = rmsOf(frame) > 0.01;
    const clip = this.host.prints.get(createHash("sha1").update(frame).digest("hex"));
    if (clip) {
      this.pendingClips.push(clip);
    }
    for (const event of this.vad.push(frame)) {
      if (event.type === "speech_start") {
        this.onSpeechStart(event.atMs);
      } else {
        this.lastEndMs = event.atMs;
        this.onSpeechEnd();
      }
    }
    this.step();
  }

  private onSpeechStart(atMs: number): void {
    this.utteranceOpen = true;
    if (this.reply && !this.reply.cancelled) {
      this.over = { startMs: atMs, lastLoudMs: atMs, decided: false };
    } else if (!this.busy) {
      this.send({ type: "state", value: "hearing" });
    }
  }

  /** Speech over the agent ended under the interruption line: a backchannel. */
  private onSpeechEnd(): void {
    const over = this.over;
    if (!over || over.decided) {
      return;
    }
    over.decided = true;
    this.pendingClips = this.pendingClips.filter((clip) => clip !== "backchannel");
    this.utteranceOpen = false;
    if (this.host.behavior.stopsOnBackchannel) {
      void this.cutReply();
    } else {
      this.send({ type: "resume_audio" });
    }
  }

  /** Runs on every 40 ms of audio, after the detector has seen it. */
  private step(): void {
    const over = this.over;
    if (over && !over.decided && this.frameLoud) {
      over.lastLoudMs = this.vad.nowMs;
    }
    if (over && !over.decided && this.frameLoud && over.lastLoudMs - over.startMs >= INTERRUPT_MS) {
      over.decided = true;
      if (!this.host.behavior.ignoresBargeIn) {
        void this.cutReply();
      }
      return;
    }
    if (this.busy || this.vad.speaking || !this.utteranceOpen || this.pendingClips.length === 0) {
      return;
    }
    if (this.mode === "push_to_talk" && !this.host.behavior.pushToTalkAutoEnds) {
      return;
    }
    const last = this.pendingClips[this.pendingClips.length - 1];
    const silence = this.vad.silenceMs;
    if (last === "unfinished") {
      const needed = this.host.behavior.answersUnfinished ? EARLY_END_SILENCE_MS : MAX_SILENCE_MS;
      if (silence >= needed) {
        void this.takeTurn();
      }
      return;
    }
    if (silence >= END_SILENCE_MS) {
      void this.takeTurn();
    }
  }

  private arrivalOf(streamMs: number): number {
    const at = this.arrivals[Math.max(0, Math.ceil(streamMs / FRAME_MS) - 1)];
    return at ?? this.host.clock.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.host.clock.sleep(ms);
  }

  private async takeTurn(): Promise<void> {
    const clips = this.pendingClips;
    this.pendingClips = [];
    this.utteranceOpen = false;
    this.busy = true;
    const endAt = this.arrivalOf(this.lastEndMs);
    const last = clips[clips.length - 1] ?? "smalltalk";
    const userText = clips.map((clip) => HEARD[clip]).join(" ");
    const behavior = this.host.behavior;
    const first = { at: 0 };
    try {
      if (last === "fact" && !behavior.factWithoutAck) {
        this.send({ type: "state", value: "thinking" });
        void this.userCaption(userText);
        await this.sleep(ACK_DELAY_MS + behavior.extraReplyDelayMs);
        if (!(await this.stream("ack", userText, first))) {
          return;
        }
        this.send({ type: "state", value: "thinking" });
        await this.sleep(THINKER_MS);
        await this.finishTurn("answer", userText, endAt, first);
        return;
      }
      if (last === "task") {
        this.send({ type: "state", value: "thinking" });
        void this.userCaption(userText);
        await this.sleep(ACK_DELAY_MS + behavior.extraReplyDelayMs);
        if (!behavior.taskAsSpeech) {
          this.send({ type: "card", card: { prompt: HEARD.task, summary: "Buat deck dari riset kemarin" } });
        }
        await this.finishTurn("card", userText, endAt, first, {
          extra: behavior.taskAsSpeech ? [{ type: "tool_call", toolKey: "write_file", status: "completed" }] : [],
        });
        return;
      }
      void this.userCaption(userText);
      const kind: SpeechKind =
        last === "smalltalk" ? "smalltalk" : last === "long" ? "long" : last === "stop" ? "stop" : "generic";
      await this.sleep(REPLY_DELAY_MS + behavior.extraReplyDelayMs);
      await this.finishTurn(kind, userText, endAt, first);
    } finally {
      this.busy = false;
    }
  }

  private async userCaption(text: string): Promise<void> {
    await this.sleep(this.host.behavior.userCaptionDelayMs);
    this.send({ type: "caption", role: "user", id: `u${++this.counter}`, text, final: true });
  }

  /** Streams the closing reply of a turn, then saves the turn and sends metrics. */
  private async finishTurn(
    kind: SpeechKind,
    userText: string,
    endAt: number,
    first: { at: number },
    options: { extra?: Record<string, unknown>[] } = {},
  ): Promise<void> {
    if (!(await this.stream(kind, userText, first))) {
      return;
    }
    this.save(userText, FAKE_SPEECH[kind], options.extra);
    this.host.spokenWords.push(FAKE_SPEECH[kind]);
    this.announceSaved();
    this.send({
      type: "metrics",
      speechEndToFirstAudioMs: first.at > 0 ? Math.round(first.at - endAt) : null,
      talkerFirstAudioMs: Math.round(THINKER_MS / 3),
      transcribeMs: 120,
    });
    this.send({ type: "state", value: "listening" });
  }

  /** One reply's audio at real-time pace, with its captions. False when it was cut. */
  private async stream(kind: SpeechKind, userText: string, first: { at: number }): Promise<boolean> {
    const text = FAKE_SPEECH[kind];
    const reply: Reply = { id: `a${++this.counter}-${kind}`, text, totalMs: AUDIO_MS[kind], userText, cancelled: false };
    this.reply = reply;
    this.over = null;
    this.send({ type: "state", value: "speaking" });
    this.send({ type: "caption", role: "assistant", id: reply.id, text: text.slice(0, Math.ceil(text.length / 2)), final: false });
    const chunk = Buffer.alloc(CHUNK_MS * 48, 1);
    const startedAt = this.host.clock.now();
    let sent = 0;
    while (sent < reply.totalMs && !reply.cancelled && !this.closed) {
      if (first.at === 0) {
        first.at = this.host.clock.now();
      }
      if (this.ws?.readyState === 1) {
        this.ws.send(chunk, { binary: true });
      }
      sent += CHUNK_MS;
      if (sent === CHUNK_MS * 5) {
        this.send({ type: "caption", role: "assistant", id: reply.id, text, final: false });
      }
      // Drift-free: a coarse timer must not slow the reply below real time.
      await this.sleep(startedAt + sent - this.host.clock.now());
    }
    if (reply.cancelled || this.closed) {
      return false;
    }
    this.send({ type: "caption", role: "assistant", id: reply.id, text, final: true });
    this.reply = null;
    return true;
  }

  /** `stop_audio`, then the cut reply's final caption with only what was heard, then the save. */
  private async cutReply(): Promise<void> {
    const reply = this.reply;
    if (!reply || reply.cancelled) {
      return;
    }
    reply.cancelled = true;
    this.send({ type: "stop_audio" });
    await new Promise<void>((resolve) => {
      this.playedWaiter = resolve;
      void this.sleep(PLAYED_WAIT_MS).then(resolve);
    });
    this.playedWaiter = null;
    const heard = trimToHeard({ text: reply.text, playedMs: this.playedMs, totalMs: reply.totalMs });
    this.send({
      type: "caption",
      role: "assistant",
      id: reply.id,
      text: heard.text,
      final: true,
      interrupted: heard.interrupted,
    });
    this.save(reply.userText, heard.text);
    this.announceSaved();
    this.send({ type: "state", value: "listening" });
    this.reply = null;
  }

  private announceSaved(): void {
    if (!this.host.behavior.neverSaves) {
      this.send({ type: "saved" });
    }
  }

  private save(userText: string, assistantText: string, extra: Record<string, unknown>[] = []): void {
    if (this.host.behavior.neverSaves) {
      return;
    }
    this.host.threads
      .get(this.threadId)
      ?.push({ role: "user", text: userText }, { role: "assistant", text: assistantText, extra });
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

type Headers = Record<string, string | string[]>;

function json(res: ServerResponse, status: number, body: unknown, headers: Headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function cookiesOf(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  return jar;
}

export async function startFakeHost(options: { clock: Clock; behavior?: Partial<FakeBehavior> }): Promise<FakeHost> {
  const behavior: FakeBehavior = { ...CORRECT_HOST, ...options.behavior };
  const threads = new Map<string, Message[]>();
  const sessions = new Map<string, FakeSession>();
  const requests: SeenRequest[] = [];
  const upgrades: SeenUpgrade[] = [];
  const spokenWords: string[] = [];
  const csrfToken = randomBytes(12).toString("hex");
  const sessionCookie = `s-${randomBytes(12).toString("hex")}`;
  const ended = new Set<string>();
  let owner: FakeSession | null = null;
  let origin = "";

  const internals: FakeHostInternals = {
    clock: options.clock,
    behavior,
    prints: fingerprints(),
    threads,
    spokenWords,
    sessionClosed(session) {
      if (owner === session) {
        owner = null;
      }
    },
  };

  const wss = new WebSocketServer({ noServer: true });

  function openSession(res: ServerResponse, body: Record<string, unknown>, headers: Headers): void {
    if (behavior.refuseH1 === "gateway_blocked") {
      json(res, 403, { error: "gateway_blocked", status: "needs_key", message: "No gateway key is saved." }, headers);
      return;
    }
    if (behavior.refuseH1 === "voice_model_unavailable") {
      json(res, 503, { error: { code: "voice_model_unavailable", message: "No talker model." } }, headers);
      return;
    }
    if (behavior.refuseH1 === "voice_session_limit") {
      json(res, 429, { error: { code: "voice_session_limit", message: "Too many sessions." } }, headers);
      return;
    }
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threads.has(threadId)) {
      json(res, 404, { error: { code: "not_found", message: "Thread not found" } }, headers);
      return;
    }
    if (owner && !owner.closed) {
      if (behavior.neverReplaces) {
        json(res, 429, { error: { code: "voice_session_limit", message: "One session per person." } }, headers);
        return;
      }
      owner.end("replaced");
    }
    const sessionId = `vs_${randomBytes(9).toString("hex")}`;
    const mode: VoiceMode = body.mode === "push_to_talk" ? "push_to_talk" : "hands_free";
    const session = new FakeSession(sessionId, threadId, mode, internals);
    sessions.set(sessionId, session);
    owner = session;
    json(
      res,
      201,
      { sessionId, threadId, model: "fake-talker", streamPath: voiceStreamPath(sessionId), endsAt: Date.now() + 900_000 },
      headers,
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const jar = cookiesOf(req);
    const csrfOk =
      method === "GET" || (jar.get("agentforge_csrf") === csrfToken && req.headers["x-agentforge-csrf"] === csrfToken);
    requests.push({
      method,
      path: url.pathname,
      origin: (req.headers.origin as string | undefined) ?? null,
      csrfOk,
      hadCookie: jar.has("agentforge_session"),
    });
    const cookies: string[] = [];
    if (!jar.has("agentforge_csrf")) {
      cookies.push(`agentforge_csrf=${csrfToken}; Path=/; SameSite=Strict`);
    }
    if (!jar.has("agentforge_session")) {
      cookies.push(`agentforge_session=${sessionCookie}; Path=/; HttpOnly`);
    }
    const headers: Headers = cookies.length > 0 ? { "set-cookie": cookies } : {};

    if (method !== "GET") {
      if (req.headers.origin !== origin) {
        json(res, 403, { error: { code: "origin_forbidden", message: "Origin is not allowed" } }, headers);
        return;
      }
      if (!csrfOk) {
        json(res, 403, { error: { code: "csrf_missing", message: "Missing CSRF token" } }, headers);
        return;
      }
    }
    const body = method === "GET" ? {} : await readBody(req);

    if (method === "GET" && url.pathname === "/api/v1/ping") {
      json(res, 200, { ok: true }, headers);
    } else if (method === "GET" && url.pathname === "/api/v1/settings") {
      json(
        res,
        200,
        { voice: { enabled: behavior.voiceEnabled, model: "fake-talker" }, runtime: behavior.runtime, locale: "id" },
        headers,
      );
    } else if (method === "GET" && url.pathname === "/api/v1/chat") {
      json(res, 200, { agent: { id: "agent-1" }, defaultModel: "fake" }, headers);
    } else if (method === "POST" && url.pathname === "/api/v1/threads") {
      const id = `th-${randomBytes(6).toString("hex")}`;
      threads.set(id, []);
      json(res, 201, { thread: { id } }, headers);
    } else if (url.pathname.startsWith("/api/v1/threads/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/v1/threads/".length));
      const thread = threads.get(id);
      if (!thread) {
        json(res, 404, { error: { code: "not_found", message: "Thread not found" } }, headers);
      } else if (method === "DELETE") {
        threads.delete(id);
        json(res, 200, { ok: true }, headers);
      } else {
        json(
          res,
          200,
          {
            thread: { id },
            messages: thread.map((message, index) => ({
              id: `m${index}`,
              role: message.role,
              content: [{ type: "text", text: message.text }, ...(message.extra ?? [])],
            })),
          },
          headers,
        );
      }
    } else if (method === "POST" && url.pathname === "/api/v1/voice/sessions") {
      openSession(res, body, headers);
    } else if (method === "POST" && /^\/api\/v1\/voice\/sessions\/[^/]+\/end$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      const session = sessions.get(id);
      if (!session) {
        json(res, 404, { error: { code: "not_found", message: "No such session" } }, headers);
      } else if (ended.has(id) && behavior.endsOnceOnly) {
        json(res, 404, { error: { code: "not_found", message: "Already ended" } }, headers);
      } else {
        ended.add(id);
        session.end("user");
        json(res, 200, { minutes: 0.02 }, headers);
      }
    } else {
      json(res, 404, { error: { code: "not_found", message: `no fake for ${method} ${url.pathname}` } }, headers);
    }
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) {
        json(res, 500, { error: { code: "internal_error", message: "fake failed" } });
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const requestOrigin = (req.headers.origin as string | undefined) ?? null;
    const match = VOICE_STREAM_PATH_PATTERN.exec(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const session = match?.[1] ? sessions.get(match[1]) : undefined;
    const originOk = behavior.acceptsWithoutOrigin || requestOrigin === origin;
    const cookieOk = cookiesOf(req).get("agentforge_session") === sessionCookie;
    if (!session || !originOk || !cookieOk) {
      upgrades.push({ origin: requestOrigin, accepted: false });
      socket.write(`HTTP/1.1 ${!session ? 404 : !originOk ? 403 : 401} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    upgrades.push({ origin: requestOrigin, accepted: true });
    wss.handleUpgrade(req, socket, head, (ws) => session.attach(ws));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base: origin,
    behavior,
    requests,
    upgrades,
    sessionCookie,
    spoken: spokenWords,
    async close() {
      for (const session of sessions.values()) {
        session.end("user");
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
