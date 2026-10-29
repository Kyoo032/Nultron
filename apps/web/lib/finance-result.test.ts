import { describe, expect, it } from "vitest";
import { FINANCE_TASK_TOOL_KEY, readFinanceResult } from "@/components/tool-rows/finance-result";
import { financeOpenView } from "@/lib/finance-open-view";

const INPUT = { request: "How healthy are these ratios?" };

const OUTPUT = {
  ok: true,
  artifact: { id: "fin-1", kind: "finance", title: "Ratio health check" },
  task: "ratios",
  headline: [
    { label: "Current ratio", value: "1.8", unit: "x" },
    { label: "Debt to equity", value: "0.6", unit: "x" },
    { label: "Net margin", value: "12.4", unit: "%" },
    { label: "Quick ratio", value: "1.1", unit: "x" },
  ],
  summary: "Liquidity is sound; margins are thin.",
  facts: "current_ratio=1.8",
  checks: { passed: true, flagged: 0, removed: 0 },
  notes: [],
};

const REPORT = {
  task: "ratios",
  title: "Ratio health check",
  locale: "en",
  summary: [{ label: "Current ratio", value: 1.8, unit: "x", flag: "good" }],
  tables: [],
  charts: [],
  flags: [],
  notes: [{ heading: "What it means", body: "Liquidity is sound." }],
};

const BRIEF = {
  title: "Quarterly brief",
  sections: [{ heading: "Overview", body: "Revenue grew." }],
};

describe("reading a finance_task call", () => {
  it("uses the tool key the host registers", () => {
    expect(FINANCE_TASK_TOOL_KEY).toBe("finance_task");
  });

  it("takes the artifact, task, title, headline, summary, checks and notes from a full answer", () => {
    expect(readFinanceResult(INPUT, OUTPUT)).toEqual({
      artifactId: "fin-1",
      title: "Ratio health check",
      task: "ratios",
      headline: [
        { label: "Current ratio", value: "1.8", unit: "x" },
        { label: "Debt to equity", value: "0.6", unit: "x" },
        { label: "Net margin", value: "12.4", unit: "%" },
        { label: "Quick ratio", value: "1.1", unit: "x" },
      ],
      summary: "Liquidity is sound; margins are thin.",
      checksPassed: true,
      flagged: 0,
      removed: 0,
      notes: [],
    });
  });

  it("reads an answer stored as JSON text", () => {
    expect(readFinanceResult(undefined, JSON.stringify(OUTPUT))?.artifactId).toBe("fin-1");
  });

  it("makes no card from a refusal, a question back, or a malformed answer", () => {
    expect(readFinanceResult(INPUT, { ok: false, reason: "failed", code: "x", message: "no" })).toBeNull();
    expect(readFinanceResult(INPUT, { ok: false, reason: "cancelled", code: "x", message: "stopped" })).toBeNull();
    expect(
      readFinanceResult(INPUT, {
        ok: false,
        reason: "needs_input",
        ask: { field: "discountRate", question: "Which discount rate?" },
      }),
    ).toBeNull();
    expect(readFinanceResult(INPUT, { ...OUTPUT, artifact: null })).toBeNull();
    expect(readFinanceResult(INPUT, { ...OUTPUT, artifact: { id: "a", title: 3 } })).toBeNull();
    expect(readFinanceResult(INPUT, undefined)).toBeNull();
  });

  it("makes no card for a task it does not know", () => {
    expect(readFinanceResult(INPUT, { ...OUTPUT, task: "forecast" })).toBeNull();
    expect(readFinanceResult(INPUT, { ...OUTPUT, task: undefined })).toBeNull();
  });

  it("keeps at most four headline figures, and only string ones", () => {
    const headline = [
      { label: "A", value: "1" },
      { label: "B", value: 2 },
      { label: "C", value: "3", unit: 5 },
      "junk",
      { label: "D", value: "4" },
      { label: "E", value: "5" },
      { label: "F", value: "6" },
    ];
    const read = readFinanceResult(INPUT, { ...OUTPUT, headline });
    expect(read?.headline).toEqual([
      { label: "A", value: "1" },
      { label: "C", value: "3" },
      { label: "D", value: "4" },
      { label: "E", value: "5" },
    ]);
  });

  it("does not call the figures checked when the answer says nothing about the checks", () => {
    const { checks: _checks, ...bare } = OUTPUT;
    expect(readFinanceResult(INPUT, bare)).toMatchObject({ checksPassed: false, flagged: 0, removed: 0 });
    expect(readFinanceResult(INPUT, { ...OUTPUT, checks: 3 })).toMatchObject({ checksPassed: false });
  });

  it("counts flagged and removed figures and keeps the notes", () => {
    const read = readFinanceResult(INPUT, {
      ...OUTPUT,
      checks: { passed: false, flagged: 2, removed: 1 },
      notes: [{ code: "unplaced_rows", message: "Two rows were not placed." }, { code: 4 }, "x"],
    });
    expect(read).toMatchObject({
      checksPassed: false,
      flagged: 2,
      removed: 1,
      notes: [{ code: "unplaced_rows", message: "Two rows were not placed." }],
    });
  });

  it("keeps a card with no artifact id when the result was not saved", () => {
    const read = readFinanceResult(INPUT, { ...OUTPUT, artifact: { id: null, kind: "finance", title: "Unsaved" } });
    expect(read).toMatchObject({ artifactId: null, title: "Unsaved" });
  });

  it("never throws on garbage", () => {
    for (const garbage of ["not json", 42, null, [], { ok: true }, { ok: true, artifact: "x" }, "{bad"]) {
      expect(() => readFinanceResult(garbage, garbage)).not.toThrow();
      expect(readFinanceResult(garbage, garbage)).toBeNull();
    }
    const odd = readFinanceResult(INPUT, { ...OUTPUT, headline: "many", notes: 3, checks: { flagged: -2 } });
    expect(odd).toMatchObject({ headline: [], notes: [], flagged: 0, checksPassed: false });
  });
});

describe("what Open shows for a saved finance artifact", () => {
  const record = (meta: Record<string, unknown> | undefined, body = "# Ratio health check\n\nPlain text.") => ({
    id: "fin-1",
    title: "Ratio health check",
    body,
    meta,
  });

  it("shows the stored task report", () => {
    const view = financeOpenView(
      record({ task: "ratios", report: REPORT, guard: { flagged: [], total: 0, removed: 1 } }),
    );
    expect(view.kind).toBe("report");
    if (view.kind !== "report") {
      throw new Error("not a report");
    }
    expect(view.result.report?.title).toBe("Ratio health check");
    expect(view.result.artifactId).toBe("fin-1");
    expect(view.result.markdown).toContain("Plain text.");
    expect(view.result.guard).toEqual({ flagged: [], total: 0 });
  });

  it("shows the stored brief with its guard", () => {
    const guard = { flagged: [{ section: 0, text: "12%" }], total: 1 };
    const view = financeOpenView(record({ task: "brief", brief: BRIEF, guard }));
    expect(view.kind).toBe("brief");
    if (view.kind !== "brief") {
      throw new Error("not a brief");
    }
    expect(view.result.brief.title).toBe("Quarterly brief");
    expect(view.result.brief.sections[0]?.tables).toEqual([]);
    expect(view.result.guard).toEqual(guard);
    expect(view.result.report).toBeUndefined();
  });

  it("reads a malformed guard as nothing flagged", () => {
    const view = financeOpenView(record({ brief: BRIEF, guard: { flagged: "x", total: "y" } }));
    expect(view.kind === "brief" ? view.result.guard : null).toEqual({ flagged: [], total: 0 });
  });

  it("falls back to the markdown when nothing structured was stored", () => {
    expect(financeOpenView(record({ task: "ratios" }))).toEqual({
      kind: "markdown",
      markdown: "# Ratio health check\n\nPlain text.",
    });
    expect(financeOpenView(record(undefined)).kind).toBe("markdown");
    expect(financeOpenView(record({ report: "junk", brief: { title: "" } })).kind).toBe("markdown");
    expect(financeOpenView(record({ report: { title: "" } })).kind).toBe("markdown");
  });
});
