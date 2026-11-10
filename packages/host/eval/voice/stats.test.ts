import { describe, expect, it } from "vitest";
import { formatSummary, percentile, summarize } from "./stats";

describe("percentile (nearest rank)", () => {
  it("takes the third of five for p50 and the largest for p90", () => {
    const runs = [1_400, 900, 1_100, 2_400, 1_000];
    expect(percentile(runs, 50)).toBe(1_100);
    expect(percentile(runs, 90)).toBe(2_400);
  });

  it("never invents a value between two that were measured", () => {
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile([10, 20], 51)).toBe(20);
    expect(percentile([10, 20, 30, 40], 90)).toBe(40);
  });

  it("handles one value, none, and the ends of the range", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it("ignores values that are not finite", () => {
    expect(percentile([5, Number.NaN, Number.POSITIVE_INFINITY, 1], 50)).toBe(1);
  });

  it("does not reorder the caller's list", () => {
    const runs = [3, 1, 2];
    percentile(runs, 50);
    expect(runs).toEqual([3, 1, 2]);
  });
});

describe("summarize (spread)", () => {
  it("gives n, min, max, mean, p50, p90 and the standard deviation", () => {
    const summary = summarize([1_000, 1_200, 1_400, 1_000, 1_900]);
    expect(summary).toMatchObject({ n: 5, missing: 0, min: 1_000, max: 1_900, p50: 1_200, p90: 1_900 });
    expect(summary.mean).toBeCloseTo(1_300, 5);
    expect(summary.stdev).toBeCloseTo(Math.sqrt(((300 ** 2) * 2 + 100 ** 2 + 100 ** 2 + 600 ** 2) / 5), 5);
  });

  it("counts a run that produced no number as missing, never as zero", () => {
    const summary = summarize([1_000, null, undefined, 3_000]);
    expect(summary.n).toBe(2);
    expect(summary.missing).toBe(2);
    expect(summary.min).toBe(1_000);
    expect(summary.p50).toBe(1_000);
  });

  it("is all null when there are no numbers", () => {
    expect(summarize([])).toEqual({ n: 0, missing: 0, min: null, max: null, mean: null, p50: null, p90: null, stdev: null });
    expect(summarize([null]).missing).toBe(1);
  });

  it("has no spread for one run", () => {
    expect(summarize([1_234]).stdev).toBe(0);
  });
});

describe("formatSummary", () => {
  it("prints percentiles with the run count and the range", () => {
    expect(formatSummary(summarize([1_010, 1_180, 1_100, 1_300, 1_520]))).toBe("p50 1180 / p90 1520 ms (n=5, 1010-1520)");
  });

  it("says when runs are missing and when there is no data", () => {
    expect(formatSummary(summarize([1_000, null]))).toContain("1 missing");
    expect(formatSummary(summarize([]))).toBe("no data");
    expect(formatSummary(summarize([null, null]))).toBe("no data (2 runs missing)");
  });
});
