/**
 * The runner around the cases: what each kind of trouble is called, that a skip is never a pass, that every
 * session is ended, that percentiles judge the latency cases, and that words and cookies stay out of the output.
 */
import { describe, expect, it } from "vitest";
import { loadFixtures } from "./audio";
import { CASES, CASE_IDS, type RunOutcome, SkipCase, type VoiceCase } from "./cases";
import { createVoiceClient } from "./client";
import { scaledClock } from "./clock";
import { FAKE_SPEECH, startFakeHost } from "./fake-host";
import { CASE_STATUS, exitCodeFor, formatTable, summarizeRows } from "./report";
import { runCases } from "./runner";
import { TEST_SCALE, failedChecks, runAgainst } from "./test-helpers";

const latencyCase = CASES.find((item) => item.id === "latency-smalltalk");

function outcome(clientMs: number | null): RunOutcome {
  return { checks: [], numbers: { clientFirstAudioMs: clientMs }, notes: {} };
}

describe("the latency verdict over runs", () => {
  const judge = (values: Array<number | null>) => latencyCase?.judge?.(values.map(outcome)) ?? [];

  it("passes at p50 1.5 s and p90 2.5 s", () => {
    const checks = judge([900, 1_000, 1_100, 1_200, 2_400]);
    expect(checks.map((check) => check.ok)).toEqual([true, true]);
    expect(checks.map((check) => check.name)).toEqual(["p50 first audio <= 1500 ms", "p90 first audio <= 2500 ms"]);
  });

  it("fails on p50 alone", () => {
    const checks = judge([800, 900, 1_600, 1_700, 1_800]);
    expect(checks.map((check) => check.ok)).toEqual([false, true]);
    expect(checks[0]?.detail).toContain("p50 1600 ms over 5 runs");
  });

  it("fails on p90 alone: with five runs, one slow turn is the p90", () => {
    const checks = judge([900, 1_000, 1_100, 1_200, 2_600]);
    expect(checks.map((check) => check.ok)).toEqual([true, false]);
  });

  it("passes at exactly the limits and fails just past them", () => {
    expect(judge([1_500, 1_500, 2_500]).every((check) => check.ok)).toBe(true);
    expect(judge([1_501, 1_501, 1_501]).some((check) => !check.ok)).toBe(true);
  });

  it("fails when no run produced a number, and ignores a missing run's number", () => {
    expect(judge([null, null])[0]).toMatchObject({ ok: false, detail: "no run produced a number" });
    expect(judge([1_000, null, 1_100]).every((check) => check.ok)).toBe(true);
  });

  it("is applied to the runs of the case, whatever --repeat is", async () => {
    const { rows } = await runAgainst({}, ["latency-smalltalk"], { repeat: 3 });
    const names = rows[0]?.checks.map((check) => check.name) ?? [];
    expect(names).toContain("p50 first audio <= 1500 ms");
    expect(rows[0]?.runs).toBe(3);
    expect(rows[0]?.numbers.clientFirstAudioMs?.n).toBe(3);
  });
});

describe("a microphone that fell behind real time", () => {
  it("fails a latency run: a stream that bursts makes the host's silence timer run short", async () => {
    const { rows } = await runAgainst({}, ["latency-smalltalk"], { paceLagMs: 0.001 });
    expect(rows[0]?.status).toBe(CASE_STATUS.fail);
    expect(failedChecks(rows[0]).join("\n")).toContain("the microphone stream kept within 0.001 ms of real time");
    // The number is still reported, next to the lag that makes it untrustworthy.
    expect(rows[0]?.numbers.clientFirstAudioMs?.n).toBe(1);
    expect(rows[0]?.numbers.micMaxLagMs?.n).toBe(1);
  });

  it("passes it when the stream kept time", async () => {
    const { rows } = await runAgainst({}, ["latency-smalltalk"], { paceLagMs: 1_500 });
    expect(rows[0]?.status).toBe(CASE_STATUS.pass);
  });
});

describe("what each kind of trouble is called", () => {
  it("skips the cases that need the thinker on a desk with no gateway key, and says why", async () => {
    const { rows } = await runAgainst({ runtime: "stub" }, ["latency-fact", "fact-routes-to-desk", "task-becomes-card", "pause-mid-sentence", "end-is-idempotent"]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    for (const id of ["latency-fact", "fact-routes-to-desk", "task-becomes-card", "pause-mid-sentence"]) {
      expect(byId[id]?.status, id).toBe(CASE_STATUS.skipped);
      expect(byId[id]?.reason).toContain("stub runtime");
      expect(byId[id]?.runs).toBe(0);
      expect(byId[id]?.passedRuns).toBe(0);
    }
    // The case that does not need the thinker still runs.
    expect(byId["end-is-idempotent"]?.status).toBe(CASE_STATUS.pass);
  });

  it("never reports a skipped case as passed", async () => {
    const { rows } = await runAgainst({ runtime: "stub" }, ["latency-fact", "end-is-idempotent"]);
    const summary = summarizeRows(rows);
    expect(summary).toMatchObject({ cases: 2, pass: 1, skipped: 1 });
    expect(formatTable(rows)).toMatch(/latency-fact\s+SKIPPED_UNAVAILABLE/);
    expect(formatTable(rows)).not.toMatch(/latency-fact\s+PASS/);
    expect(exitCodeFor(rows)).toBe(0);
  });

  it("blocks every case when the gateway gate is closed, with the host's own words", async () => {
    const { rows } = await runAgainst({ refuseH1: "gateway_blocked" }, ["turns-saved", "end-is-idempotent", "push-to-talk"]);
    expect(rows.map((row) => row.status)).toEqual([CASE_STATUS.blocked, CASE_STATUS.blocked, CASE_STATUS.blocked]);
    expect(rows[0]?.reason).toContain("403 gateway_blocked");
    expect(rows[0]?.reason).toContain("No gateway key is saved");
    // The rest are not run at all, and say so.
    expect(rows[1]?.reason).toContain("not run:");
    expect(rows[1]?.runs).toBe(0);
    expect(exitCodeFor(rows)).toBe(1);
  });

  it("calls a missing talker model blocked too", async () => {
    const { rows } = await runAgainst({ refuseH1: "voice_model_unavailable" }, ["end-is-idempotent"]);
    expect(rows[0]?.status).toBe(CASE_STATUS.blocked);
    expect(rows[0]?.reason).toContain("voice_model_unavailable");
  });

  it("calls a full session cap a transient error", async () => {
    const { rows } = await runAgainst({ refuseH1: "voice_session_limit" }, ["end-is-idempotent", "turns-saved"]);
    expect(rows.map((row) => row.status)).toEqual([CASE_STATUS.transient, CASE_STATUS.transient]);
    expect(rows[0]?.reason).toContain("429 voice_session_limit");
  });

  it("calls an expected frame that never comes a failure, not an error", async () => {
    const { rows } = await runAgainst({ neverSaves: true }, ["turns-saved"]);
    expect(rows[0]?.status).toBe(CASE_STATUS.fail);
    expect(rows[0]?.reason).toBeNull();
  });
});

describe("a run that goes wrong", () => {
  async function runCustom(cases: VoiceCase[], options: { runMs?: number } = {}) {
    const clock = scaledClock(TEST_SCALE);
    const host = await startFakeHost({ clock });
    try {
      const client = createVoiceClient({ base: host.base, clock });
      const settings = await client.settings();
      const result = await runCases({
        client,
        clock,
        fixtures: loadFixtures(),
        settings,
        caseIds: cases.map((item) => item.id),
        repeat: 1,
        policy: { showText: false },
        cleanup: true,
        cases,
        ...(options.runMs ? { runMs: options.runMs } : {}),
      });
      return { ...result, host };
    } finally {
      await host.close();
    }
  }

  const base = { title: "t", repeatable: false, needsThinker: false } as const;

  it("ends every session it opened even when the case throws", async () => {
    const { rows, host } = await runCustom([
      {
        ...base,
        id: "throws",
        async run(context) {
          await context.open();
          throw new Error("boom");
        },
      },
    ]);
    expect(rows[0]).toMatchObject({ status: CASE_STATUS.error, reason: "boom" });
    expect(host.requests.some((request) => request.method === "POST" && request.path.endsWith("/end"))).toBe(true);
  });

  it("calls a case that never finishes an error, after its backstop", async () => {
    const { rows } = await runCustom(
      [
        {
          ...base,
          id: "hangs",
          async run(context) {
            await context.open();
            await new Promise<never>(() => undefined);
          },
        },
      ],
      { runMs: 1_500 },
    );
    expect(rows[0]?.status).toBe(CASE_STATUS.error);
    expect(rows[0]?.reason).toContain("did not finish");
  });

  it("reports a skip the case raises itself, with its reason, and keeps what it had checked", async () => {
    const { rows } = await runCustom([
      {
        ...base,
        id: "skips",
        async run(_context, recorder) {
          recorder.check("something before", true);
          throw new SkipCase("nothing to cut");
        },
      },
    ]);
    expect(rows[0]).toMatchObject({ status: CASE_STATUS.skipped, reason: "nothing to cut" });
    expect(rows[0]?.checks[0]?.name).toBe("something before");
  });

  it("keeps the checks a case recorded before an expected frame failed to arrive", async () => {
    const { rows } = await runCustom([
      {
        ...base,
        id: "times-out",
        async run(context, recorder) {
          const session = await context.open();
          recorder.check("opened", true);
          await session.waitFor((rec) => rec.kind === "frame" && rec.frame.type === "card", { timeoutMs: 300, label: "a card" });
        },
      },
    ]);
    expect(rows[0]?.status).toBe(CASE_STATUS.fail);
    expect(rows[0]?.checks.map((check) => `${check.name}:${check.failed}`)).toEqual(["opened:0", "no a card within 300 ms:1"]);
  });

  it("deletes the threads it made and verifies each is gone", async () => {
    const { cleanup, host } = await runCustom([CASES.find((item) => item.id === "end-is-idempotent") as VoiceCase]);
    expect(cleanup).toEqual({ threads: 1, deleted: 1, failed: 0 });
    expect(host.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("keeps the threads with cleanup off", async () => {
    const clock = scaledClock(TEST_SCALE);
    const host = await startFakeHost({ clock });
    try {
      const client = createVoiceClient({ base: host.base, clock });
      const result = await runCases({
        client,
        clock,
        fixtures: loadFixtures(),
        settings: await client.settings(),
        caseIds: ["end-is-idempotent"],
        repeat: 1,
        policy: { showText: false },
        cleanup: false,
      });
      expect(result.cleanup).toBeNull();
      expect(host.requests.some((request) => request.method === "DELETE")).toBe(false);
    } finally {
      await host.close();
    }
  });
});

describe("what the output holds", () => {
  const words = [
    FAKE_SPEECH.smalltalk,
    FAKE_SPEECH.answer,
    "Berapa total penjualan saya bulan lalu",
    "Halo, apa kabar hari ini",
    "Terima kasih sudah bertanya",
    "seratus dua puluh juta rupiah",
  ];

  it("hides every caption and saved message by default: only lengths and hashes", async () => {
    const { file, rows, host } = await runAgainst({}, ["fact-routes-to-desk", "turns-saved", "task-becomes-card", "barge-in-stops"]);
    expect(rows.map((row) => row.status)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    const printed = `${JSON.stringify(file)}\n${formatTable(rows)}`;
    for (const text of [...words, ...host.spoken]) {
      expect(printed, text).not.toContain(text);
    }
    expect(printed).not.toContain("Sebentar, saya cek dulu");
    expect(printed).not.toContain("Tolong buatkan deck");
    expect(printed).toMatch(/\d+ chars #[0-9a-f]{8}/);
  });

  it("shows the words only with --show-text", async () => {
    const { file } = await runAgainst({}, ["turns-saved"], { policy: { showText: true } });
    const printed = JSON.stringify(file);
    expect(printed).toContain("Halo, apa kabar hari ini");
    expect(printed).toContain("Terima kasih sudah bertanya");
  });

  it("never holds a cookie, a key or audio", async () => {
    const { file, rows, host } = await runAgainst({}, ["latency-smalltalk", "turns-saved"], { policy: { showText: true } });
    const printed = `${JSON.stringify(file)}\n${formatTable(rows)}`;
    expect(host.sessionCookie.length).toBeGreaterThan(10);
    expect(printed).not.toContain(host.sessionCookie);
    expect(printed).not.toMatch(/agentforge_session|agentforge_csrf|set-cookie|authorization|api[_-]?key/i);
    // No audio: nothing in the file is longer than a sentence of text.
    expect(Math.max(...[...printed.matchAll(/"[^"]{200,}"/g)].map((match) => match[0].length), 0)).toBe(0);
  });
});

describe("the case table", () => {
  it("is the fourteen cases, each with a title, in a fixed order", () => {
    expect(CASES.map((item) => item.id)).toEqual([...CASE_IDS]);
    expect(CASES.every((item) => item.title.length > 10)).toBe(true);
    expect(CASES.filter((item) => item.repeatable).map((item) => item.id)).toEqual([
      "latency-smalltalk",
      "latency-fact",
      "latency-long",
      "barge-in-stops",
    ]);
  });

  it("reports failed checks readably", async () => {
    const { rows } = await runAgainst({ endsOnceOnly: true }, ["end-is-idempotent"]);
    expect(failedChecks(rows[0])).toEqual(["the second end answers 200 (HTTP 404)", "both answers carry minutes ()"]);
  });
});
