import { describe, expect, it } from "vitest";
import type { FinanceReport } from "@agentforge/core/finance";
import { FACTS_MAX, HEADLINE_MAX, factsOf, formatFigure, headlineOf } from "./finance-task-facts";

function report(overrides: Partial<FinanceReport> = {}): FinanceReport {
  return {
    task: "ratios",
    title: "Health check",
    locale: "en",
    summary: [
      { label: "Current ratio", value: 1.666666, unit: "x" },
      { label: "Revenue", value: 1000, unit: "IDR" },
      { label: "Missing", value: null },
      { label: "Band", value: "good" },
      { label: "Quick ratio", value: 1.2 },
      { label: "Debt to equity", value: 0.35 },
    ],
    tables: [],
    charts: [],
    flags: [],
    notes: [],
    ...overrides,
  };
}

function bigTable(id: string, rows: number) {
  return {
    id,
    title: `Table ${id}`,
    columns: ["Label", "2024", "2023"],
    rows: Array.from({ length: rows }, (_, index) => [`Row ${index} with a longer label`, 1234.5678 + index, null]),
  };
}

describe("formatFigure", () => {
  it("keeps at most two decimals and passes text through", () => {
    expect(formatFigure(1.666666)).toBe("1.67");
    expect(formatFigure(1000)).toBe("1000");
    expect(formatFigure("good")).toBe("good");
    expect(formatFigure(null)).toBe("");
  });
});

describe("headlineOf", () => {
  it("takes up to four KPIs with a value, formatted by code", () => {
    const headline = headlineOf(report());
    expect(headline).toHaveLength(HEADLINE_MAX);
    expect(headline[0]).toEqual({ label: "Current ratio", value: "1.67", unit: "x" });
    expect(headline.map((entry) => entry.label)).not.toContain("Missing");
  });
});

describe("factsOf", () => {
  it("writes the KPIs and the tables, skipping the calc sheet and keeping inputs last", () => {
    const facts = factsOf(
      report({
        tables: [bigTable("inputs", 2), bigTable("calc", 2), bigTable("scorecard", 2)],
      }),
    );
    expect(facts).toContain("Current ratio");
    expect(facts).toContain("1.67");
    expect(facts).not.toContain("Table calc");
    expect(facts.indexOf("Table scorecard")).toBeLessThan(facts.indexOf("Table inputs"));
    expect(facts).toContain("1234.57");
  });

  it("skips an empty table instead of stopping at it", () => {
    const facts = factsOf(report({ tables: [bigTable("empty", 0), bigTable("scorecard", 2)] }));
    expect(facts).not.toContain("Table empty");
    expect(facts).toContain("Table scorecard");
  });

  it("never passes the cap and cuts at a whole row", () => {
    const facts = factsOf(report({ tables: [bigTable("scorecard", 200), bigTable("inputs", 200)] }));
    expect(facts.length).toBeLessThanOrEqual(FACTS_MAX);
    expect(facts.length).toBeGreaterThan(FACTS_MAX - 200);
    const last = facts.split("\n").at(-1) ?? "";
    expect(last.startsWith("|")).toBe(true);
    expect(last.endsWith("|")).toBe(true);
    expect(last).not.toBe("| --- | --- | --- |");
  });

  it("drops a table whose header fits but none of whose rows do", () => {
    const facts = factsOf(report({ tables: [bigTable("scorecard", 200)] }));
    const lines = facts.split("\n");
    const tail = lines.slice(-2);
    expect(tail.some((line) => line === "| --- | --- | --- |")).toBe(false);
  });
});
