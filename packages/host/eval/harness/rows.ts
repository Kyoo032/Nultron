/**
 * The shape of a result file, how a case becomes a row, the compact table, and the comparison the
 * later units (H1, H5) make against `results/baseline.json`.
 *
 * `modelSteps` is `null` on every row today: the agent loop caps a run at six steps
 * (`packages/core/src/runtime/ai-sdk-runtime.ts`, `maxSteps: 6`) and no event reports how many it used.
 * H1 is where a step count could start to exist; the column is here so the baseline row and the later
 * rows have the same keys.
 */
import type { ToolCallSource } from "./observe";

export type DetailValue = string | number | boolean | null;

/** What a case hands back, before the harness adds the wall time. */
export type CaseOutcome = {
  completed: boolean;
  error: string | null;
  /** The model that answered, when the API says (a run's usage, an artifact's `meta.model`). */
  model: string | null;
  toolCalls: readonly string[];
  toolCallSource: ToolCallSource;
  /** Failures the API itself reports. Empty is "none reported", not "checked and clean". */
  checkFailures: readonly string[];
  /** What the case expected and did not get. Separate from the API's checks on purpose. */
  expectFailures: readonly string[];
  artifactId: string | null;
  detail: Readonly<Record<string, DetailValue>>;
};

export type CaseRow = CaseOutcome & {
  id: string;
  mode: string;
  modelSteps: number | null;
  wallMs: number;
};

export type CleanupRecord = {
  threads: readonly string[];
  datasets: readonly string[];
  artifacts: readonly string[];
  failed: readonly string[];
  /** Every id above was asked for again afterwards and answered 404. */
  verifiedGone: boolean;
};

export type RunFile = {
  runId: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  base: string;
  desk: { workspaceId: string | null; agentId: string | null; defaultModel: string | null };
  rows: readonly CaseRow[];
  cleanup: CleanupRecord | null;
  summary: { cases: number; completed: number; expectFailures: number; checkFailures: number; wallMs: number };
};

export function shapeRow(input: { id: string; mode: string; wallMs: number; outcome: CaseOutcome }): CaseRow {
  return { id: input.id, mode: input.mode, modelSteps: null, wallMs: Math.round(input.wallMs), ...input.outcome };
}

/** A case that threw before it could say how it ended. The error is the whole row. */
export function failedRow(input: { id: string; mode: string; wallMs: number; error: string }): CaseRow {
  return shapeRow({
    id: input.id,
    mode: input.mode,
    wallMs: input.wallMs,
    outcome: {
      completed: false,
      error: input.error,
      model: null,
      toolCalls: [],
      toolCallSource: "none",
      checkFailures: [],
      expectFailures: [],
      artifactId: null,
      detail: {},
    },
  });
}

export function summarize(rows: readonly CaseRow[]): RunFile["summary"] {
  return {
    cases: rows.length,
    completed: rows.filter((row) => row.completed).length,
    expectFailures: rows.reduce((total, row) => total + row.expectFailures.length, 0),
    checkFailures: rows.reduce((total, row) => total + row.checkFailures.length, 0),
    wallMs: rows.reduce((total, row) => total + row.wallMs, 0),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}~`;
}

function toolsCell(row: CaseRow): string {
  if (row.toolCalls.length === 0) {
    return "-";
  }
  const counts = new Map<string, number>();
  for (const key of row.toolCalls) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => (count > 1 ? `${key}x${count}` : key)).join(",");
}

/** One line per case, then the problems each row has, indented under the table. */
export function formatTable(rows: readonly CaseRow[]): string {
  const header = ["case", "mode", "done", "tools", "steps", "checks", "expect", "ms", "artifact"];
  const body = rows.map((row) => [
    row.id,
    row.mode,
    row.completed ? "yes" : "NO",
    clip(toolsCell(row), 28),
    row.modelSteps === null ? "n/a" : String(row.modelSteps),
    String(row.checkFailures.length),
    row.expectFailures.length === 0 ? "ok" : `${row.expectFailures.length} miss`,
    String(row.wallMs),
    row.artifactId ? row.artifactId.slice(0, 8) : "-",
  ]);
  const widths = header.map((title, at) => Math.max(title.length, ...body.map((line) => (line[at] ?? "").length)));
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, at) => pad(cell, widths[at] ?? 0))
      .join("  ")
      .trimEnd();
  const problems = rows.flatMap((row) => [
    ...(row.error ? [`  ${row.id}: error: ${clip(row.error, 160)}`] : []),
    ...row.checkFailures.map((failure) => `  ${row.id}: check: ${clip(failure, 160)}`),
    ...row.expectFailures.map((failure) => `  ${row.id}: expected: ${failure}`),
  ]);
  return [render(header), ...body.map(render), ...(problems.length > 0 ? ["", ...problems] : [])].join("\n");
}

export type RowDifference = { id: string; field: string; before: string; after: string };

function sortedSet(values: readonly string[]): string {
  return [...new Set(values)].sort().join(",") || "-";
}

/**
 * What changed between two runs, case by case, in the fields a harness change must not disturb:
 * completion, the set of tools called, the counts of failures. Wall time and wording never count.
 */
export function compareRuns(before: RunFile, after: RunFile): RowDifference[] {
  const earlier = new Map(before.rows.map((row) => [row.id, row]));
  const later = new Map(after.rows.map((row) => [row.id, row]));
  const ids = [...new Set([...earlier.keys(), ...later.keys()])];
  return ids.flatMap((id) => {
    const a = earlier.get(id);
    const b = later.get(id);
    if (!a || !b) {
      return [{ id, field: "case", before: a ? "present" : "missing", after: b ? "present" : "missing" }];
    }
    const pairs: Array<[string, string, string]> = [
      ["completed", String(a.completed), String(b.completed)],
      ["tools", sortedSet(a.toolCalls), sortedSet(b.toolCalls)],
      ["checkFailures", String(a.checkFailures.length), String(b.checkFailures.length)],
      ["expectFailures", String(a.expectFailures.length), String(b.expectFailures.length)],
    ];
    return pairs.flatMap(([field, x, y]) => (x === y ? [] : [{ id, field, before: x, after: y }]));
  });
}

export function formatDifferences(differences: readonly RowDifference[]): string {
  if (differences.length === 0) {
    return "No difference from the baseline in completion, tools called, or failure counts.";
  }
  return differences.map((d) => `${d.id}: ${d.field} ${d.before} -> ${d.after}`).join("\n");
}
