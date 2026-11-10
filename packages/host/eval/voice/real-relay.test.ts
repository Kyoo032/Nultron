/**
 * The eval's own runner against the host's real routes and the real relay, with a scripted talker.
 *
 * `runner.test.ts` and `cases.*.test.ts` run the cases against `fake-host.ts`, a stand-in written beside the
 * runner. `src/voice/relay.test.ts` runs the relay against its own test client. This file makes the two meet
 * before any real gateway call is paid for: a real `http.Server` on loopback port 0 with the host's own
 * request adapter (`handleNodeRequest`, every route and every guard) and `attachVoiceUpgrade`, exactly as
 * `apps/web/server.ts` mounts them, and the runner's own cases, with the runner's own fixtures, driven over
 * the real protocol.
 *
 * Only the two models are scripted (`ScriptedTalker`, `ScriptedTranscriber`) and the desk's `askNultron` is
 * a stub, so nothing reaches a gateway: `test-setup.ts` makes a `fetch` to anywhere but loopback throw, and
 * the gateway key below is a placeholder that is never sent anywhere. The host's own clock is the runner's
 * clock, scaled the same way (`TEST_SCALE`), so a turn takes a quarter of its real time and every duration
 * still agrees.
 *
 * The scripted talker cannot understand speech. It recognises which fixture it was given by a short stretch
 * from the middle of the clip: the relay hands the talker the person's audio unchanged, so that stretch is in
 * it byte for byte. Everything else it does is what the real talker's contract says (`talker.ts`): speak,
 * `wait` on a sentence that stopped on a word that needs more, `ask` for a fact or a task.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BYTES_PER_MS, FIXTURE_NAMES, FIXTURE_TEXT, type FixtureName, loadFixtures } from "./audio";
import { createVoiceClient } from "./client";
import { type Clock, scaledClock } from "./clock";
import { type CaseRow, formatTable } from "./report";
import { runCases } from "./runner";
import { TEST_PACE_LAG_MS, TEST_SCALE, failedChecks } from "./test-helpers";
import type { AskInput, AskResult } from "../../src/voice/ask";
import type { VoiceClock } from "../../src/voice/clock";
import type { Talker, TalkerEvent, TalkerSession, Transcriber } from "../../src/voice/talker";

// The host reads its desk from the environment when it is first imported, so the desk is made, and the
// operator's own is kept out of reach, before any host module is loaded below.
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-voice-real-relay-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
mkdirSync(process.env.MEDIA_ROOT, { recursive: true });
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_VOICE_OWNERS;
delete process.env.AGENTFORGE_VOICE_MODEL;
delete process.env.AGENTFORGE_GATEWAY_URL;
/**
 * `runtime: "ai"` is what makes the runner run the cases that need the thinker. The key is a placeholder:
 * nothing here ever sends it, and the gate's verdict for it is written below so no check is ever made.
 */
const PLACEHOLDER_KEY = "eval-placeholder-key-not-sent-anywhere-4d7e1b";
process.env.AGENTFORGE_RUNTIME = "ai";
process.env.OPENAI_API_KEY = PLACEHOLDER_KEY;
process.env.AGENTFORGE_VOICE = "on";

const { handleNodeRequest } = await import("../../src/http-adapter");
const { attachVoiceUpgrade } = await import("../../src/voice/upgrade");
const { resetVoiceSessionsForTests } = await import("../../src/voice/sessions");
const { setVoiceWiringForTests } = await import("../../src/voice/wiring");
const { saveGateState } = await import("../../src/gateway-gate");
const { getTenant } = await import("../../src/tenant");
const { keyFingerprintOrNull } = await import("@agentforge/core");

// ---------------------------------------------------------------------------------------------------------
// The scripted models

const fixtures = loadFixtures();

/** 80 ms from the middle of each clip's speech: enough to know the clip, and inside any slice of it that matters. */
function signatureOf(name: FixtureName): Buffer {
  const { marks, pcm } = fixtures[name];
  const middle = Math.round((marks.startMs + marks.endMs) / 2);
  const from = (middle - 40) * BYTES_PER_MS;
  return pcm.subarray(from, from + 80 * BYTES_PER_MS);
}

const SIGNATURES: ReadonlyArray<readonly [FixtureName, Buffer]> = FIXTURE_NAMES.map((name) => [name, signatureOf(name)]);

/** Which fixtures are in this audio. */
function heardIn(pcm: Buffer): FixtureName[] {
  return SIGNATURES.filter(([, signature]) => pcm.includes(signature)).map(([name]) => name);
}

function tone(ms: number): Buffer {
  const samples = Math.round((ms * 24_000) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(0.2 * Math.sin((2 * Math.PI * 330 * i) / 24_000) * 32767), i * 2);
  }
  return buffer;
}

const USAGE = { inputTokens: 40, outputTokens: 60, inputAudioTokens: 30, outputAudioTokens: 50 } as const;

/** Long enough that a person has time to talk over it: the cases cut in 400 ms after its first audio. */
const SMALLTALK_REPLY =
  "Halo, saya baik-baik saja hari ini, terima kasih sudah bertanya. Ada yang bisa saya bantu pagi ini, silakan sampaikan saja kepada saya.";
const ANSWER = "Total penjualan bulan lalu adalah dua puluh juta rupiah, naik sedikit dari bulan sebelumnya.";
const CARD_SENTENCE = "Saya bisa membuatkannya begitu Anda menekan tombolnya.";
const GO_ON = "Silakan, saya mendengarkan.";

async function* speak(words: string, ms: number, signal: AbortSignal): AsyncGenerator<TalkerEvent> {
  await Promise.resolve();
  if (signal.aborted) return;
  yield { type: "text", delta: words };
  yield { type: "audio", pcm: tone(ms) };
  yield { type: "usage", usage: USAGE };
  yield { type: "done" };
}

class ScriptedSession implements TalkerSession {
  reply(utterance: Buffer, options: { signal: AbortSignal; mustAnswer?: boolean }): AsyncIterable<TalkerEvent> {
    return this.replyTo(utterance, options.signal, options.mustAnswer === true);
  }

  private async *replyTo(utterance: Buffer, signal: AbortSignal, mustAnswer: boolean): AsyncGenerator<TalkerEvent> {
    await Promise.resolve();
    if (signal.aborted) return;
    const heard = heardIn(utterance);
    if (heard.includes("fact") || heard.includes("task")) {
      yield { type: "ask", callId: "call-desk", question: heard.includes("task") ? FIXTURE_TEXT.task : FIXTURE_TEXT.fact };
      yield { type: "done" };
      return;
    }
    // A sentence that stopped on a word that needs more, or only the first part of one, is not answered yet.
    if (!mustAnswer && (heard.length === 0 || (heard.length === 1 && heard[0] === "unfinished"))) {
      yield { type: "wait" };
      yield { type: "done" };
      return;
    }
    if (heard.includes("smalltalk")) {
      yield* speak(SMALLTALK_REPLY, 4_500, signal);
    } else if (heard.includes("unfinished") && !heard.includes("stop")) {
      yield* speak(GO_ON, 1_500, signal);
    } else {
      yield* speak(`Baik. ${GO_ON}`, 2_000, signal);
    }
  }

  answer(_callId: string, text: string, options: { signal: AbortSignal }): AsyncIterable<TalkerEvent> {
    return speak(text, 2_500, options.signal);
  }

  remember(): void {}

  async hearShort(speech: Buffer): Promise<string | null> {
    const heard = heardIn(speech);
    if (heard.includes("backchannel")) return "iya";
    if (heard.includes("stop")) return "stop tunggu dulu";
    return null;
  }

  acknowledgement(): { pcm: Buffer; text: string } {
    return { pcm: tone(900), text: "Sebentar, saya cek dulu." };
  }

  close(): void {}
}

const talker: Talker = { model: "scripted-talker", open: () => new ScriptedSession() };

/** Says what the person said, by the fixture it recognises. */
const transcriber: Transcriber = {
  async transcribe(utterance) {
    const heard = heardIn(utterance);
    const words = FIXTURE_NAMES.filter((name) => heard.includes(name))
      .map((name) => FIXTURE_TEXT[name])
      .join(" ");
    return words ? { text: words, seconds: utterance.length / (BYTES_PER_MS * 1000) } : null;
  },
};

/** The desk: a fact is answered, a task needs a tap. No model is called. */
async function ask(input: AskInput): Promise<AskResult> {
  if (input.question === FIXTURE_TEXT.task) {
    return {
      kind: "needs_tap",
      text: CARD_SENTENCE,
      card: { prompt: input.question, summary: "Buat deck dari riset kemarin" },
    };
  }
  return { kind: "answer", text: ANSWER };
}

// ---------------------------------------------------------------------------------------------------------
// The host

let server: Server;
let base = "";
let clock: Clock;

/** The runner's clock as the relay's: one scaled clock, so the two agree on every duration. */
function hostClockOver(shared: Clock): VoiceClock {
  return {
    now: () => 1_000_000 + Math.round(shared.now()),
    after(ms, fn) {
      const timer = shared.after(ms, fn);
      return () => timer.cancel();
    },
  };
}

beforeAll(async () => {
  clock = scaledClock(TEST_SCALE);
  setVoiceWiringForTests({
    clock: hostClockOver(clock),
    modelsFor: () => ({ talker, transcriber, transcriberModel: "scripted-transcriber" }),
    ask,
  });
  // The gate's verdict for the placeholder key, so the settings read never asks a gateway about it.
  const tenant = await getTenant();
  const now = new Date().toISOString();
  saveGateState(tenant.tenantId, {
    version: 1,
    fingerprint: keyFingerprintOrNull(PLACEHOLDER_KEY),
    status: "ok",
    checkedAt: now,
    lastOkAt: now,
  });
  server = createServer((req, res) => {
    void handleNodeRequest(req, res).then(
      (handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      },
      () => {
        res.statusCode = 500;
        res.end();
      },
    );
  });
  attachVoiceUpgrade(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  resetVoiceSessionsForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    const { sql } = await import("@agentforge/db");
    sql.close();
  } catch {
    // The desk's database was never opened.
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows holds the database open until the worker exits; the temp folder is cleaned later.
  }
});

async function runOnTheRealHost(
  caseIds: readonly string[],
  options: { repeat?: number } = {},
): Promise<{ rows: CaseRow[]; cleanup: Awaited<ReturnType<typeof runCases>>["cleanup"] }> {
  const client = createVoiceClient({ base, clock, locale: "id" });
  const settings = await client.settings();
  expect(settings.voice).toEqual({ enabled: true, model: "qwen3.5-omni-flash" });
  expect(settings.runtime).toBe("ai");
  const run = await runCases({
    client,
    clock,
    fixtures,
    settings,
    caseIds,
    repeat: options.repeat ?? 1,
    policy: { showText: false },
    cleanup: true,
    paceLagMs: TEST_PACE_LAG_MS,
  });
  // The runner's own table, for a person reading the numbers: VOICE_REAL_RELAY_TABLE=1 npx vitest run --root eval/voice real-relay
  if (process.env.VOICE_REAL_RELAY_TABLE) process.stdout.write(`
${formatTable(run.rows)}
`);
  return run;
}

function expectPass(row: CaseRow | undefined): void {
  expect(failedChecks(row)).toEqual([]);
  expect(row?.reason).toBeNull();
  expect(row?.status).toBe("PASS");
  expect(row?.passedRuns).toBe(row?.runs);
}

describe("the eval runner against the real relay", () => {
  for (const id of [
    "fact-routes-to-desk",
    "task-becomes-card",
    "unfinished-waits",
    "pause-mid-sentence",
    "barge-in-stops",
    "backchannel-resumes",
    "push-to-talk",
    "turns-saved",
    "second-session-replaces",
    "upgrade-needs-origin",
    "end-is-idempotent",
  ]) {
    it(id, async () => {
      const { rows, cleanup } = await runOnTheRealHost([id]);
      expectPass(rows[0]);
      // The runner leaves no thread behind.
      expect(cleanup?.failed).toBe(0);
      expect(cleanup?.deleted).toBe(cleanup?.threads);
    });
  }

  for (const id of ["latency-smalltalk", "latency-fact", "latency-long"]) {
    it(id, async () => {
      const { rows } = await runOnTheRealHost([id], { repeat: 3 });
      const row = rows[0];
      expectPass(row);
      expect(row?.runs).toBe(3);
      // The client's number and the host's own are two clocks on one turn: they must agree.
      const client = row?.numbers.clientFirstAudioMs;
      const host = row?.numbers.hostFirstAudioMs;
      expect(client?.n).toBe(3);
      expect(host?.n).toBe(3);
      expect(Math.abs((client?.p50 ?? 0) - (host?.p50 ?? 0))).toBeLessThan(300);
    });
  }
});
