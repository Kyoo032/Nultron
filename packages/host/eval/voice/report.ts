/**
 * The shape of a result file, the table the runner prints, and the comparison with an earlier run.
 *
 * Statuses are the words of `eval/finance/runner/verdict.mjs`: PASS, FAIL, SKIPPED_UNAVAILABLE,
 * BLOCKED_NO_RUNTIME, ERROR_TRANSIENT, ERROR. A skipped or blocked case is never counted as passed.
 *
 * Nothing here holds a key, a cookie, audio or a transcript. Words come in already described (`text.ts`):
 * a length and a short hash unless `--show-text` was passed.
 */
import type { NoteValue } from "./cases";
import { type NumberSummary, formatSummary } from "./stats";

export const CASE_STATUS = {
  pass: "PASS",
  fail: "FAIL",
  skipped: "SKIPPED_UNAVAILABLE",
  blocked: "BLOCKED_NO_RUNTIME",
  transient: "ERROR_TRANSIENT",
  error: "ERROR",
} as const;

export type CaseStatus = (typeof CASE_STATUS)[keyof typeof CASE_STATUS];

/** A check, summed over the runs of its case. */
export type CheckSummary = {
  readonly name: string;
  readonly passed: number;
  readonly failed: number;
  /** The detail of the first failing run, or of the last run when none failed. */
  readonly detail: string | null;
};

export type CaseRow = {
  readonly id: string;
  readonly title: string;
  readonly status: CaseStatus;
  /** Why a case was skipped, blocked or errored. */
  readonly reason: string | null;
  readonly runs: number;
  readonly passedRuns: number;
  readonly checks: readonly CheckSummary[];
  readonly numbers: Readonly<Record<string, NumberSummary>>;
  /** One entry per run, in order. */
  readonly notes: Readonly<Record<string, readonly NoteValue[]>>;
  readonly wallMs: number;
};

export type RunSummary = {
  readonly cases: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly error: number;
  readonly wallMs: number;
};

export type VoiceRunFile = {
  readonly format: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly base: string;
  readonly locale: string;
  readonly repeat: number;
  readonly showText: boolean;
  readonly desk: { readonly model: string | null; readonly runtime: string | null; readonly locale: string | null };
  readonly rows: readonly CaseRow[];
  readonly cleanup: { readonly threads: number; readonly deleted: number; readonly failed: number } | null;
  readonly summary: RunSummary;
};

export function summarizeRows(rows: readonly CaseRow[]): RunSummary {
  const count = (...statuses: CaseStatus[]) => rows.filter((row) => statuses.includes(row.status)).length;
  return {
    cases: rows.length,
    pass: count(CASE_STATUS.pass),
    fail: count(CASE_STATUS.fail),
    skipped: count(CASE_STATUS.skipped),
    blocked: count(CASE_STATUS.blocked),
    error: count(CASE_STATUS.error, CASE_STATUS.transient),
    wallMs: rows.reduce((total, row) => total + row.wallMs, 0),
  };
}

/** 0 when no case failed. A skipped case does not fail a run, but it is never counted as passed either. */
export function exitCodeFor(rows: readonly CaseRow[]): 0 | 1 {
  return rows.every((row) => row.status === CASE_STATUS.pass || row.status === CASE_STATUS.skipped) ? 0 : 1;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}~`;
}

const whole = (value: number | null): string => (value === null ? "-" : String(Math.round(value)));

/** The numbers of a row in one cell: the client and host latency side by side first, then the rest. */
export function numbersCell(row: CaseRow): string {
  const parts: string[] = [];
  const client = row.numbers.clientFirstAudioMs;
  const host = row.numbers.hostFirstAudioMs;
  if (client) {
    parts.push(`client ${formatSummary(client)}`);
  }
  if (host) {
    parts.push(`host ${formatSummary(host)}`);
  }
  for (const [name, summary] of Object.entries(row.numbers)) {
    if (name === "clientFirstAudioMs" || name === "hostFirstAudioMs") {
      continue;
    }
    if (summary.n === 0) {
      continue;
    }
    parts.push(summary.n === 1 ? `${name} ${whole(summary.p50)}` : `${name} p50 ${whole(summary.p50)} / p90 ${whole(summary.p90)} (n=${summary.n})`);
  }
  return parts.length === 0 ? "-" : parts.join("; ");
}

/** One line per case, then what each unhappy case says, indented under the table. */
export function formatTable(rows: readonly CaseRow[]): string {
  const header = ["case", "status", "runs", "numbers"];
  const body = rows.map((row) => [row.id, row.status, `${row.passedRuns}/${row.runs}`, numbersCell(row)]);
  const widths = header.map((title, at) =>
    Math.max(title.length, ...body.map((line) => (at === header.length - 1 ? 0 : (line[at] ?? "").length))),
  );
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, at) => (at === cells.length - 1 ? cell : pad(cell, widths[at] ?? 0)))
      .join("  ")
      .trimEnd();
  const problems = rows.flatMap((row) => [
    ...(row.reason ? [`  ${row.id}: ${row.status.toLowerCase()}: ${clip(row.reason, 240)}`] : []),
    ...row.checks
      .filter((check) => check.failed > 0)
      .map(
        (check) =>
          `  ${row.id}: failed: ${check.name}${check.detail ? ` (${clip(check.detail, 200)})` : ""}${
            check.passed > 0 ? ` [${check.failed} of ${check.passed + check.failed} runs]` : ""
          }`,
      ),
  ]);
  return [render(header), ...body.map(render), ...(problems.length > 0 ? ["", ...problems] : [])].join("\n");
}

export type RowDifference = { readonly id: string; readonly field: string; readonly before: string; readonly after: string };

/**
 * What changed between two runs, case by case: the status, and the p50 and p90 of every number both runs
 * have. Notes and wording never count.
 */
export function compareRuns(before: VoiceRunFile, after: VoiceRunFile): RowDifference[] {
  const earlier = new Map(before.rows.map((row) => [row.id, row]));
  const later = new Map(after.rows.map((row) => [row.id, row]));
  const ids = [...new Set([...earlier.keys(), ...later.keys()])];
  return ids.flatMap((id) => {
    const a = earlier.get(id);
    const b = later.get(id);
    if (!a || !b) {
      return [{ id, field: "case", before: a ? "present" : "missing", after: b ? "present" : "missing" }];
    }
    const differences: RowDifference[] = [];
    if (a.status !== b.status) {
      differences.push({ id, field: "status", before: a.status, after: b.status });
    }
    for (const [name, summary] of Object.entries(b.numbers)) {
      const old = a.numbers[name];
      if (!old) {
        continue;
      }
      for (const key of ["p50", "p90"] as const) {
        const x = old[key];
        const y = summary[key];
        if (x !== null && y !== null && Math.round(x) !== Math.round(y)) {
          differences.push({ id, field: `${name} ${key}`, before: `${whole(x)} ms`, after: `${whole(y)} ms (${y - x >= 0 ? "+" : ""}${Math.round(y - x)})` });
        }
      }
    }
    return differences;
  });
}

export function formatDifferences(differences: readonly RowDifference[]): string {
  if (differences.length === 0) {
    return "No difference from the earlier run in status or in any number.";
  }
  return differences.map((d) => `${d.id}: ${d.field} ${d.before} -> ${d.after}`).join("\n");
}
