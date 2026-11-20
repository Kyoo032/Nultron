/**
 * Every case, run over the real protocol against a fake host that behaves correctly: each one passes.
 * `cases.fail.test.ts` is the other half: each case against a host that gets it wrong.
 */
import { describe, expect, it } from "vitest";
import { CASE_IDS } from "./cases";
import { failedChecks, runAgainst } from "./test-helpers";

describe("every case passes on a correct host", () => {
  for (const id of CASE_IDS) {
    it(id, async () => {
      const { rows, cleanup } = await runAgainst({}, [id]);
      const row = rows[0];
      expect(failedChecks(row)).toEqual([]);
      expect(row?.reason).toBeNull();
      expect(row?.status).toBe("PASS");
      expect(row?.passedRuns).toBe(row?.runs);
      // The runner leaves no thread behind.
      expect(cleanup?.failed).toBe(0);
      expect(cleanup?.deleted).toBe(cleanup?.threads);
    });
  }

  it("reports the client and host latency side by side, and they agree", async () => {
    const { rows } = await runAgainst({}, ["latency-smalltalk"], { repeat: 3 });
    const row = rows[0];
    expect(row?.runs).toBe(3);
    const client = row?.numbers.clientFirstAudioMs;
    const host = row?.numbers.hostFirstAudioMs;
    expect(client?.n).toBe(3);
    expect(host?.n).toBe(3);
    // The fake answers 700 ms of silence plus 250 ms after the end of speech; both clocks must say so.
    expect(client?.p50).toBeGreaterThan(850);
    expect(client?.p50).toBeLessThan(1_300);
    expect(Math.abs((client?.p50 ?? 0) - (host?.p50 ?? 0))).toBeLessThan(150);
  });

  it("measures the 700 ms line and the stop within 300 ms of it", async () => {
    const { rows } = await runAgainst({}, ["barge-in-stops"]);
    const stop = rows[0]?.numbers.stopAfterLineMs;
    expect(stop?.n).toBe(1);
    expect(stop?.p50).toBeLessThanOrEqual(300);
  });

  it("copes with a person's caption that arrives seconds late", async () => {
    const { rows } = await runAgainst({ userCaptionDelayMs: 5_000 }, ["fact-routes-to-desk"]);
    expect(failedChecks(rows[0])).toEqual([]);
    expect(rows[0]?.status).toBe("PASS");
  });
});
