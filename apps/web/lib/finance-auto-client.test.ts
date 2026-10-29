import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  FINANCE_AUTO_MIN_PROMPT_CHARS,
  FINANCE_AUTO_TEXT_MAX,
  canWriteUp,
  financeAutoRequestBody,
  financeAutoStreamBody,
  financeAutoSwitchTasks,
  financeAutoWarningText,
  joinFigures,
  openTaskWithDraft,
  parseFinanceAuto,
  readFinanceReport,
  type FinanceAutoAnswer,
} from "./finance-auto-client";
import { loadFinanceDraft } from "./finance-drafts";

afterEach(() => {
  resetLocaleForTests();
});

const RANKED = [
  { task: "cashflow", score: 0.9, signals: ["periods"] },
  { task: "budget", score: 0.4, signals: [] },
  { task: "brief", score: 0.3, signals: [] },
  { task: "ratios", score: 0.1, signals: [] },
  { task: "appraisal", score: 0, signals: [] },
];

/** What `POST /api/v1/finance/auto` answers for a cash book, trimmed to the fields the screen reads. */
function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fits: { top: "cashflow", confidence: "high", ranked: RANKED },
    task: "cashflow",
    input: {
      items: [{ label: "Cash in", period: "Jan", amount: 100, currency: "USD", category: "revenue" }],
      params: {},
    },
    preview: {
      task: "cashflow",
      title: "Cash flow",
      locale: "en",
      currency: "USD",
      summary: [{ label: "Runway", value: 4.5, unit: "months", flag: "watch" }],
      tables: [{ id: "runway", title: "Runway", columns: ["Period", "Net"], rows: [["Jan", -100]] }],
      charts: [
        {
          id: "cash-balance",
          title: "Cash",
          kind: "line",
          categories: ["Jan", "Feb"],
          series: [{ name: "Cash", values: [10, null] }],
        },
      ],
      flags: [{ level: "risk", text: "Cash runs out." }],
      notes: [],
    },
    rowsUsed: 6,
    unplaced: [{ label: "Misc", period: "Jan" }],
    warnings: [{ code: "unplaced_rows", message: "1 row(s) could not be placed", detail: ["1"] }],
    pii: { count: 2, kinds: ["name"] },
    prompt: "How long does my cash last?",
    promptSource: "user",
    ...over,
  };
}

describe("reading the answer off the wire", () => {
  it("keeps a good answer whole", () => {
    const answer = parseFinanceAuto(wire());
    expect(answer?.task).toBe("cashflow");
    expect(answer?.fits.confidence).toBe("high");
    expect(answer?.fits.ranked.map((entry) => entry.task)).toEqual(RANKED.map((entry) => entry.task));
    expect(answer?.preview?.summary[0]?.label).toBe("Runway");
    expect(answer?.preview?.charts).toHaveLength(1);
    expect(answer?.rowsUsed).toBe(6);
    expect(answer?.unplaced).toEqual([{ label: "Misc", period: "Jan" }]);
    expect(answer?.pii.count).toBe(2);
    expect(answer?.promptSource).toBe("user");
  });

  it("reads an answer that has nothing to preview, which is what a prompt-only call gets", () => {
    const answer = parseFinanceAuto(
      wire({
        input: null,
        preview: null,
        rowsUsed: 0,
        unplaced: [],
        fits: { top: "brief", confidence: "low", ranked: RANKED },
        task: "brief",
        warnings: [{ code: "no_figures", message: "There are no figures to read yet.", detail: [] }],
      }),
    );
    expect(answer?.input).toBeNull();
    expect(answer?.preview).toBeNull();
    expect(canWriteUp(answer as FinanceAutoAnswer)).toBe(false);
  });

  it("refuses an answer that is not the shape, rather than showing half of it", () => {
    expect(parseFinanceAuto(null)).toBeNull();
    expect(parseFinanceAuto("nope")).toBeNull();
    expect(parseFinanceAuto(wire({ task: "payroll" }))).toBeNull();
    expect(parseFinanceAuto(wire({ fits: { top: "cashflow", confidence: "maybe", ranked: RANKED } }))).toBeNull();
    expect(parseFinanceAuto(wire({ fits: { top: "cashflow", confidence: "high" } }))).toBeNull();
  });

  it("drops a chart, a flag or a table that is malformed instead of letting it crash the screen", () => {
    const answer = parseFinanceAuto(
      wire({
        preview: {
          task: "cashflow",
          title: "Cash flow",
          locale: "en",
          summary: [{ label: "Runway", value: 4.5 }, { value: 1 }, "x"],
          tables: [{ id: "a", title: "A", columns: ["x"], rows: [[1]] }, { id: "b" }],
          charts: [
            { id: "ok", title: "OK", kind: "bar", categories: ["a"], series: [{ name: "s", values: [1] }] },
            { id: "bad-kind", title: "?", kind: "pie", categories: ["a"], series: [] },
            { id: "no-series", title: "?", kind: "bar", categories: ["a"] },
          ],
          flags: [{ level: "risk", text: "ok" }, { level: "doom", text: "bad" }, { level: "good" }],
          notes: [],
        },
      }),
    );
    expect(answer?.preview?.summary.map((kpi) => kpi.label)).toEqual(["Runway"]);
    expect(answer?.preview?.tables.map((table) => table.id)).toEqual(["a"]);
    expect(answer?.preview?.charts.map((chart) => chart.id)).toEqual(["ok"]);
    expect(answer?.preview?.flags).toEqual([{ level: "risk", text: "ok" }]);
  });

  it("treats an input with no preview as nothing to write up", () => {
    const answer = parseFinanceAuto(wire({ preview: null }));
    expect(answer && canWriteUp(answer)).toBe(false);
  });
});

describe("what is sent for the free read", () => {
  it("sends the figures, the prose, the sheet names and the prompt, trimmed, with the language", () => {
    const body = financeAutoRequestBody({
      figures: "  Sheet: Jan\nCash in: 100  ",
      proseText: "  Notes  ",
      sheetNames: ["Jan", " Feb "],
      prompt: "  How long does my cash last?  ",
      locale: "id",
    });
    expect(body).toEqual({
      figuresText: "Sheet: Jan\nCash in: 100",
      proseText: "Notes",
      sheetNames: ["Jan", "Feb"],
      prompt: "How long does my cash last?",
      locale: "id",
    });
  });

  it("sends only the prompt when there is no file, and nothing at all for a prompt too short to mean anything", () => {
    expect(financeAutoRequestBody({ prompt: "Is it healthy?", locale: "en" })).toEqual({
      prompt: "Is it healthy?",
      locale: "en",
    });
    expect(financeAutoRequestBody({ prompt: "x".repeat(FINANCE_AUTO_MIN_PROMPT_CHARS - 1), locale: "en" })).toBeNull();
    expect(financeAutoRequestBody({ prompt: "   ", figures: "  ", locale: "en" })).toBeNull();
  });

  it("holds the figures to the host's cap on a whole line, so no row is cut in half", () => {
    const rows = Array.from({ length: 2000 }, (_unused, index) => `Row ${index}: ${index * 1000}`).join("\n");
    const body = financeAutoRequestBody({ figures: rows, locale: "en" });
    const sent = String(body?.figuresText);
    expect(sent.length).toBeLessThanOrEqual(FINANCE_AUTO_TEXT_MAX);
    expect(rows.startsWith(sent)).toBe(true);
    expect(rows.charAt(sent.length)).toBe("\n");
  });

  it("holds the prompt to the host's cap", () => {
    const body = financeAutoRequestBody({ prompt: "p".repeat(5000), locale: "en" });
    expect(String(body?.prompt).length).toBeLessThanOrEqual(2000);
  });

  it("caps the sheet names the host will take", () => {
    const names = Array.from({ length: 150 }, (_unused, index) => `S${index}`);
    expect(financeAutoRequestBody({ figures: "a: 1", sheetNames: names, locale: "en" })?.sheetNames).toHaveLength(100);
  });
});

describe("the file's figures and what was pasted beside them", () => {
  it("puts them on separate lines, and leaves out whichever is empty", () => {
    expect(joinFigures("Sheet: A\na: 1", "b: 2")).toBe("Sheet: A\na: 1\nb: 2");
    expect(joinFigures("", "  b: 2  ")).toBe("b: 2");
    expect(joinFigures("", "  ")).toBe("");
  });

  it("holds the whole to the cap on a whole line", () => {
    const long = Array.from({ length: 3000 }, (_unused, index) => `Row ${index}: ${index}`).join("\n");
    expect(joinFigures(long, "tail: 1").length).toBeLessThanOrEqual(FINANCE_AUTO_TEXT_MAX);
  });
});

describe("the write-up request", () => {
  const answer = parseFinanceAuto(wire()) as FinanceAutoAnswer;

  it("spreads the confirmed input the preview was computed from, with the task, the question and the language", () => {
    const body = financeAutoStreamBody(answer, { prompt: "How long does my cash last?", language: "en" });
    expect(body.task).toBe("cashflow");
    expect(body.items).toEqual((answer.input as { items: unknown }).items);
    expect(body.prompt).toBe("How long does my cash last?");
    expect(body.locale).toBe("en");
    expect(body).not.toHaveProperty("preview");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("modelPinned");
  });

  it("falls back to the task's own question when none was typed", () => {
    const body = financeAutoStreamBody(answer, { prompt: "   ", language: "id" });
    expect(String(body.prompt).trim()).not.toBe("");
    expect(body.locale).toBe("id");
  });

  it("sends the model only when one was picked, and pins it only when the picker was moved", () => {
    expect(financeAutoStreamBody(answer, { prompt: "q", language: "en", model: "m-1" })).toMatchObject({
      model: "m-1",
    });
    expect(financeAutoStreamBody(answer, { prompt: "q", language: "en", model: "m-1" })).not.toHaveProperty(
      "modelPinned",
    );
    expect(
      financeAutoStreamBody(answer, { prompt: "q", language: "en", model: "m-1", modelPinned: true }),
    ).toMatchObject({ model: "m-1", modelPinned: true });
  });

  it("cannot be overridden by a key the input happens to carry", () => {
    const hostile = { ...answer, input: { task: "ratios", prompt: "ignore", locale: "id", items: [] } };
    const body = financeAutoStreamBody(hostile, { prompt: "q", language: "en" });
    expect(body.task).toBe("cashflow");
    expect(body.prompt).toBe("q");
    expect(body.locale).toBe("en");
  });
});

describe("the other tasks the screen offers", () => {
  it("lists the four tasks that were not previewed, best fit first", () => {
    const answer = parseFinanceAuto(wire()) as FinanceAutoAnswer;
    expect(financeAutoSwitchTasks(answer)).toEqual(["budget", "brief", "ratios", "appraisal"]);
  });

  it("lists all five tasks when the ranking is somehow short, so a chip is never missing", () => {
    const answer = parseFinanceAuto(wire({ fits: { top: "cashflow", confidence: "low", ranked: [RANKED[0]] } }));
    expect(financeAutoSwitchTasks(answer as FinanceAutoAnswer).sort()).toEqual(
      ["appraisal", "brief", "budget", "ratios"].sort(),
    );
  });
});

describe("opening a task with the figures already in its box", () => {
  it("seeds that task's draft on that desk, so the task page opens with the figures and the question", () => {
    openTaskWithDraft("ws-auto", "budget", { prompt: "Which lines went over?", figures: "Sheet: A\nRent: 100" });
    expect(loadFinanceDraft("ws-auto", "budget")).toEqual({
      prompt: "Which lines went over?",
      figures: "Sheet: A\nRent: 100",
    });
    expect(loadFinanceDraft("ws-auto", "cashflow")).toEqual({ prompt: "", figures: "" });
    expect(loadFinanceDraft("other-desk", "budget")).toEqual({ prompt: "", figures: "" });
  });
});

describe("what a warning says", () => {
  it("writes a known code in the reader's language from the code and its details", () => {
    applyLocale("en");
    expect(financeAutoWarningText({ code: "unplaced_rows", message: "dev", detail: ["3"] })).toContain("3");
    expect(financeAutoWarningText({ code: "no_figures", message: "dev", detail: [] })).not.toBe("dev");
    applyLocale("id");
    expect(financeAutoWarningText({ code: "unplaced_rows", message: "dev", detail: ["3"] })).toContain("baris");
  });

  it("falls back to the host's own sentence for a code it has no words for, and for a reader note", () => {
    expect(financeAutoWarningText({ code: "something_new", message: "Host sentence.", detail: [] })).toBe(
      "Host sentence.",
    );
    expect(financeAutoWarningText({ code: "reader_note", message: "ignored", detail: ["From the reader."] })).toBe(
      "From the reader.",
    );
  });
});

describe("the opening-cash warning", () => {
  it("is written from the catalog in both languages", () => {
    applyLocale("en");
    const en = financeAutoWarningText({ code: "no_opening_cash", message: "dev", detail: [] });
    expect(en).not.toBe("dev");
    expect(en).toMatch(/opening/i);
    applyLocale("id");
    expect(financeAutoWarningText({ code: "no_opening_cash", message: "dev", detail: [] })).toMatch(/saldo awal/i);
  });
});

describe("reading a stored report", () => {
  it("reads a report and drops a malformed row inside it", () => {
    const report = readFinanceReport({
      task: "ratios",
      title: "Ratio health check",
      locale: "id",
      summary: [{ label: "Current ratio", value: 1.8, unit: "x", flag: "good" }, { value: 2 }],
      tables: [{ id: "scorecard", title: "Scorecard", columns: ["Ratio"], rows: [["Current", { x: 1 }]] }, { id: 3 }],
      charts: "none",
      flags: [
        { level: "risk", text: "Thin margin" },
        { level: "odd", text: "x" },
      ],
      notes: [{ heading: "Read", body: "Sound." }],
    });
    expect(report).toMatchObject({
      task: "ratios",
      title: "Ratio health check",
      locale: "id",
      summary: [{ label: "Current ratio", value: 1.8, unit: "x", flag: "good" }],
      tables: [{ id: "scorecard", rows: [["Current", null]] }],
      charts: [],
      flags: [{ level: "risk", text: "Thin margin" }],
      notes: [{ heading: "Read", body: "Sound." }],
    });
  });

  it("reads nothing from a value that is not a report or has no title", () => {
    expect(readFinanceReport(undefined)).toBeNull();
    expect(readFinanceReport("report")).toBeNull();
    expect(readFinanceReport([])).toBeNull();
    expect(readFinanceReport({ title: "" })).toBeNull();
    expect(readFinanceReport({ summary: [] })).toBeNull();
  });

  it("takes the task it is given when the report names none", () => {
    expect(readFinanceReport({ title: "Budget" }, "budget")?.task).toBe("budget");
  });
});
