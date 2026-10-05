import { describe, expect, it } from "vitest";
import {
  compareRuns,
  failedRow,
  formatDifferences,
  formatTable,
  shapeRow,
  summarize,
  type CaseOutcome,
  type RunFile,
} from "./rows";

const OUTCOME: CaseOutcome = {
  completed: true,
  error: null,
  model: "gpt-x",
  toolCalls: ["run_sql", "run_sql"],
  toolCallSource: "job.step",
  checkFailures: [],
  expectFailures: [],
  artifactId: "0123456789abcdef",
  detail: { sqlQueries: 2 },
};

describe("shapeRow", () => {
  it("adds the id, the mode, a null step count and the rounded wall time", () => {
    expect(shapeRow({ id: "data", mode: "data", wallMs: 1234.56, outcome: OUTCOME })).toEqual({
      id: "data",
      mode: "data",
      modelSteps: null,
      wallMs: 1235,
      ...OUTCOME,
    });
  });

  it("turns a throw into a row that did not complete and says why", () => {
    expect(failedRow({ id: "research", mode: "research", wallMs: 12.4, error: "timed out after 600000 ms" })).toEqual({
      id: "research",
      mode: "research",
      modelSteps: null,
      wallMs: 12,
      completed: false,
      error: "timed out after 600000 ms",
      model: null,
      toolCalls: [],
      toolCallSource: "none",
      checkFailures: [],
      expectFailures: [],
      artifactId: null,
      detail: {},
    });
  });
});

describe("summarize and formatTable", () => {
  const rows = [
    shapeRow({
      id: "chat-plain",
      mode: "chat",
      wallMs: 3000,
      outcome: { ...OUTCOME, toolCalls: [], toolCallSource: "none", artifactId: null },
    }),
    shapeRow({
      id: "data",
      mode: "data",
      wallMs: 20000,
      outcome: {
        ...OUTCOME,
        checkFailures: ["run_sql failed: no such column"],
        expectFailures: ["the analysis states the top total"],
      },
    }),
    failedRow({ id: "research", mode: "research", wallMs: 500, error: "HTTP 503 tool_failed: no key" }),
  ];

  it("counts completions, unmet expectations, API check failures and total wall time", () => {
    expect(summarize(rows)).toEqual({ cases: 3, completed: 2, expectFailures: 1, checkFailures: 1, wallMs: 23500 });
  });

  it("prints one line per case and the problems under the table", () => {
    expect(formatTable(rows)).toBe(
      [
        "case        mode      done  tools      steps  checks  expect  ms     artifact",
        "chat-plain  chat      yes   -          n/a    0       ok      3000   -",
        "data        data      yes   run_sqlx2  n/a    1       1 miss  20000  01234567",
        "research    research  NO    -          n/a    0       ok      500    -",
        "",
        "  data: check: run_sql failed: no such column",
        "  data: expected: the analysis states the top total",
        "  research: error: HTTP 503 tool_failed: no key",
      ].join("\n"),
    );
  });
});

describe("compareRuns", () => {
  const base = (rows: RunFile["rows"]): RunFile => ({
    runId: "r",
    name: "n",
    startedAt: "",
    finishedAt: "",
    base: "http://127.0.0.1:3000",
    desk: { workspaceId: null, agentId: null, defaultModel: null },
    rows,
    cleanup: null,
    summary: summarize(rows),
  });
  const chat = shapeRow({
    id: "chat-tool",
    mode: "chat",
    wallMs: 1,
    outcome: { ...OUTCOME, toolCalls: ["calculator"], toolCallSource: "tool.started" },
  });

  it("sees no difference when only the wall time and the wording moved", () => {
    const later = { ...chat, wallMs: 99999, model: "other" };
    expect(compareRuns(base([chat]), base([later]))).toEqual([]);
    expect(formatDifferences([])).toBe(
      "No difference from the baseline in completion, tools called, or failure counts.",
    );
  });

  it("names a case that stopped completing, lost a tool, or went missing", () => {
    const worse = { ...chat, completed: false, toolCalls: [], expectFailures: ["the calculator tool was called"] };
    const differences = compareRuns(
      base([chat, shapeRow({ id: "data", mode: "data", wallMs: 1, outcome: OUTCOME })]),
      base([worse]),
    );
    expect(differences).toEqual([
      { id: "chat-tool", field: "completed", before: "true", after: "false" },
      { id: "chat-tool", field: "tools", before: "calculator", after: "-" },
      { id: "chat-tool", field: "expectFailures", before: "0", after: "1" },
      { id: "data", field: "case", before: "present", after: "missing" },
    ]);
    expect(formatDifferences(differences).split("\n")[0]).toBe("chat-tool: completed true -> false");
  });
});
