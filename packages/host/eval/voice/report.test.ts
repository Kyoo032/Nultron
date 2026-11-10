import { describe, expect, it } from "vitest";
import { type CaseRow, CASE_STATUS, compareRuns, exitCodeFor, formatDifferences, formatTable, summarizeRows, type VoiceRunFile } from "./report";
import { summarize } from "./stats";

function row(fields: Partial<CaseRow> & { id: string }): CaseRow {
  return {
    title: fields.id,
    status: CASE_STATUS.pass,
    reason: null,
    runs: 1,
    passedRuns: 1,
    checks: [],
    numbers: {},
    notes: {},
    wallMs: 1_000,
    ...fields,
  };
}

const file = (rows: CaseRow[]): VoiceRunFile => ({
  format: 1,
  runId: "r",
  startedAt: "",
  finishedAt: "",
  base: "http://127.0.0.1:3300",
  locale: "id",
  repeat: 5,
  showText: false,
  desk: { model: null, runtime: null, locale: null },
  rows,
  cleanup: null,
  summary: summarizeRows(rows),
});

describe("the table", () => {
  const latency = row({
    id: "latency-smalltalk",
    runs: 5,
    passedRuns: 5,
    numbers: {
      clientFirstAudioMs: summarize([1_010, 1_180, 1_100, 1_300, 1_520]),
      hostFirstAudioMs: summarize([960, 1_100, 1_050, 1_200, 1_400]),
      micMaxLagMs: summarize([30, 40, 35, 31, 29]),
    },
  });

  it("puts the client and host numbers side by side, with run count and spread", () => {
    const table = formatTable([latency]);
    expect(table).toContain("latency-smalltalk");
    expect(table).toContain("5/5");
    expect(table).toContain("client p50 1180 / p90 1520 ms (n=5, 1010-1520)");
    expect(table).toContain("host p50 1100 / p90 1400 ms (n=5, 960-1400)");
  });

  it("lists why a case did not pass, under the table", () => {
    const table = formatTable([
      row({ id: "a", status: CASE_STATUS.skipped, reason: "the desk runs the stub runtime", passedRuns: 0 }),
      row({
        id: "b",
        status: CASE_STATUS.fail,
        passedRuns: 0,
        checks: [{ name: "stop_audio within 300 ms", passed: 0, failed: 1, detail: "no stop_audio" }],
      }),
    ]);
    expect(table).toContain("a: skipped_unavailable: the desk runs the stub runtime");
    expect(table).toContain("b: failed: stop_audio within 300 ms (no stop_audio)");
    expect(table).toMatch(/a\s+SKIPPED_UNAVAILABLE/);
  });

  it("says how many runs of a case failed when only some did", () => {
    const table = formatTable([
      row({ id: "c", status: CASE_STATUS.fail, runs: 5, passedRuns: 3, checks: [{ name: "x", passed: 3, failed: 2, detail: "bad" }] }),
    ]);
    expect(table).toContain("[2 of 5 runs]");
  });
});

describe("the verdict", () => {
  it("never counts a skipped or blocked case as passed", () => {
    const rows = [
      row({ id: "pass" }),
      row({ id: "skip", status: CASE_STATUS.skipped, reason: "r" }),
      row({ id: "block", status: CASE_STATUS.blocked, reason: "r" }),
      row({ id: "fail", status: CASE_STATUS.fail }),
      row({ id: "error", status: CASE_STATUS.error, reason: "r" }),
      row({ id: "transient", status: CASE_STATUS.transient, reason: "r" }),
    ];
    expect(summarizeRows(rows)).toMatchObject({ cases: 6, pass: 1, skipped: 1, blocked: 1, fail: 1, error: 2 });
  });

  it("exits 0 only when nothing failed, errored or was blocked", () => {
    expect(exitCodeFor([row({ id: "a" }), row({ id: "b", status: CASE_STATUS.skipped })])).toBe(0);
    expect(exitCodeFor([row({ id: "a" }), row({ id: "b", status: CASE_STATUS.fail })])).toBe(1);
    expect(exitCodeFor([row({ id: "a", status: CASE_STATUS.error })])).toBe(1);
    expect(exitCodeFor([row({ id: "a", status: CASE_STATUS.blocked })])).toBe(1);
    expect(exitCodeFor([row({ id: "a", status: CASE_STATUS.transient })])).toBe(1);
  });

  it("uses the words of the finance runner's verdicts", () => {
    expect(Object.values(CASE_STATUS)).toEqual(["PASS", "FAIL", "SKIPPED_UNAVAILABLE", "BLOCKED_NO_RUNTIME", "ERROR_TRANSIENT", "ERROR"]);
  });
});

describe("comparing two runs", () => {
  const before = file([
    row({ id: "latency-fact", numbers: { clientFirstAudioMs: summarize([1_000, 1_100, 1_200]) } }),
    row({ id: "push-to-talk" }),
    row({ id: "gone" }),
  ]);
  const after = file([
    row({ id: "latency-fact", numbers: { clientFirstAudioMs: summarize([900, 950, 1_000]) } }),
    row({ id: "push-to-talk", status: CASE_STATUS.fail }),
    row({ id: "new" }),
  ]);

  it("lists a status change and the change of every number both runs have", () => {
    const text = formatDifferences(compareRuns(before, after));
    expect(text).toContain("push-to-talk: status PASS -> FAIL");
    expect(text).toContain("latency-fact: clientFirstAudioMs p50 1100 ms -> 950 ms (-150)");
    expect(text).toContain("latency-fact: clientFirstAudioMs p90 1200 ms -> 1000 ms (-200)");
    expect(text).toContain("gone: case present -> missing");
    expect(text).toContain("new: case missing -> present");
  });

  it("says so when nothing differs", () => {
    expect(formatDifferences(compareRuns(before, before))).toContain("No difference");
  });
});
