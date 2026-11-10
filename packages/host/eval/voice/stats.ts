/**
 * Percentiles and spread for the numbers a run reports. Pure, no clock.
 *
 * A percentile is the nearest rank: the smallest value with at least p% of the runs at or below it. With
 * five runs, p50 is the third value and p90 is the largest, which is the honest reading of "90% of turns"
 * from so few runs: it never invents a value between two that were measured.
 */

export type NumberSummary = {
  /** Runs that produced the number. */
  readonly n: number;
  /** Runs that were asked for it and did not produce one (a missing frame). */
  readonly missing: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  /** Standard deviation of the runs (population), a plain spread figure next to min and max. */
  readonly stdev: number | null;
};

/** Nearest-rank percentile of `values`, or null when there are none. `p` is 0 to 100. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** `null` and non-finite entries count as missing runs. */
export function summarize(values: ReadonlyArray<number | null | undefined>): NumberSummary {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const missing = values.length - finite.length;
  if (finite.length === 0) {
    return { n: 0, missing, min: null, max: null, mean: null, p50: null, p90: null, stdev: null };
  }
  const mean = finite.reduce((total, value) => total + value, 0) / finite.length;
  const variance = finite.reduce((total, value) => total + (value - mean) ** 2, 0) / finite.length;
  return {
    n: finite.length,
    missing,
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean,
    p50: percentile(finite, 50),
    p90: percentile(finite, 90),
    stdev: Math.sqrt(variance),
  };
}

function whole(value: number | null): string {
  return value === null ? "-" : String(Math.round(value));
}

/** `p50 1180 / p90 1420 ms (n=5, 1010-1520)`, or `no data` when no run produced the number. */
export function formatSummary(summary: NumberSummary, unit = "ms"): string {
  if (summary.n === 0) {
    return summary.missing > 0 ? `no data (${summary.missing} run${summary.missing === 1 ? "" : "s"} missing)` : "no data";
  }
  const missing = summary.missing > 0 ? `, ${summary.missing} missing` : "";
  return `p50 ${whole(summary.p50)} / p90 ${whole(summary.p90)} ${unit} (n=${summary.n}, ${whole(summary.min)}-${whole(summary.max)}${missing})`;
}
