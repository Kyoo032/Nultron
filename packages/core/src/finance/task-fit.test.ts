import { describe, expect, it } from "vitest";
import {
  FINANCE_FIT_HIGH_LEAD,
  FINANCE_FIT_HIGH_SCORE,
  fitConfidence,
  readAppraisalRows,
  scoreFinanceTaskFit,
  type FinanceTaskFit,
} from "./task-fit";
import { FINANCE_TASKS, type FinanceTask } from "./task-ids";

/**
 * Synthetic shapes, written the way the spreadsheet importer writes a sheet (see `import-table/text.ts`),
 * so a fit rule is held to the text the route really receives. None of these comes from `eval/`.
 */
const BUDGET_SHEET = ["Sheet: Anggaran 2024", "Pendapatan: 100000", "Beban Gaji: 40000", "Beban Sewa: 10000"].join(
  "\n",
);
const ACTUAL_SHEET = ["Sheet: Realisasi 2024", "Pendapatan: 95000", "Beban Gaji: 42000", "Beban Sewa: 10000"].join(
  "\n",
);
const BUDGET_TWO_SHEETS = `${BUDGET_SHEET}\n${ACTUAL_SHEET}`;

const BUDGET_COLUMNS = [
  "Sheet: Sheet1",
  "Item | Q1 Budget | Q1 Actual",
  "Revenue | 100 | 90",
  "Marketing | 20 | 25",
  "Travel | 10 | 8",
].join("\n");

const CASH_BOOK = [
  "Sheet: Arus Kas",
  "Keterangan | Jan 2024 | Feb 2024 | Mar 2024",
  "Saldo awal | 50000000 |  | ",
  "Kas masuk | 20000000 | 22000000 | 25000000",
  "Kas keluar | 26000000 | 21000000 | 20000000",
].join("\n");

const CASH_SENTENCE = "Opening cash $90,000. Jan in $20,000, out $26,000. Feb in $22,000, out $24,000.";

const MONTHLY_PL = [
  "Sheet: PL",
  "Item | Jan 2024 | Feb 2024 | Mar 2024",
  "Revenue | 100 | 110 | 120",
  "COGS | 40 | 44 | 48",
  "Opex | 30 | 30 | 31",
].join("\n");

const ANNUAL_PL = [
  "Sheet: PL",
  "Item | 2022 | 2023 | 2024",
  "Revenue | 100 | 110 | 120",
  "COGS | 40 | 44 | 48",
  "Opex | 30 | 30 | 31",
].join("\n");

const STATEMENTS = [
  "Sheet: Laporan Keuangan",
  "Label | 2024 | 2023",
  "Kas dan setara kas | 500 | 400",
  "Piutang usaha | 300 | 250",
  "Persediaan | 200 | 180",
  "Utang usaha | 250 | 200",
  "Ekuitas | 700 | 600",
  "Pendapatan | 1000 | 900",
  "Beban pokok penjualan | 600 | 540",
  "Beban operasional | 250 | 230",
].join("\n");

const APPRAISAL_GRID = [
  "Sheet: Appraisal",
  "Item | Year 0 | Year 1 | Year 2 | Year 3",
  "Initial outlay | -200000 |  |  | ",
  "Net cash flow |  | 60000 | 75000 | 90000",
].join("\n");

const APPRAISAL_SENTENCE = "Outlay $200,000. Year 1 $60,000, year 2 $75,000, year 3 $90,000. Discount rate 12%.";

function fitOf(input: Parameters<typeof scoreFinanceTaskFit>[0]) {
  return scoreFinanceTaskFit(input);
}

function scoreOf(result: ReturnType<typeof scoreFinanceTaskFit>, task: FinanceTask): number {
  return result.ranked.find((entry) => entry.task === task)?.score ?? Number.NaN;
}

describe("scoreFinanceTaskFit: the shape of the answer", () => {
  it("ranks all five tasks, best first, each score in [0, 1]", () => {
    const result = fitOf({ figuresText: BUDGET_TWO_SHEETS });
    expect(result.ranked.map((entry) => entry.task).sort()).toEqual([...FINANCE_TASKS].sort());
    for (const entry of result.ranked) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
    const scores = result.ranked.map((entry) => entry.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
    expect(result.top).toBe(result.ranked[0]?.task);
  });

  it("is deterministic and does not touch its input", () => {
    const input = { figuresText: CASH_BOOK, proseText: "", sheetNames: ["Arus Kas"], prompt: "cash runway" };
    const before = JSON.stringify(input);
    expect(fitOf(input)).toEqual(fitOf(input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("names the evidence behind a score, so the screen and a reviewer can see why", () => {
    const result = fitOf({ figuresText: CASH_BOOK });
    const cashflow = result.ranked.find((entry) => entry.task === "cashflow");
    expect(cashflow?.signals).toEqual(expect.arrayContaining(["months", "in-out", "opening"]));
  });
});

describe("scoreFinanceTaskFit: budget", () => {
  it("fits a budget sheet and an actual sheet with the same lines, with high confidence", () => {
    const result = fitOf({ figuresText: BUDGET_TWO_SHEETS });
    expect(result.top).toBe("budget");
    expect(result.confidence).toBe("high");
  });

  it("fits budget and actual side by side in one table", () => {
    const result = fitOf({ figuresText: BUDGET_COLUMNS });
    expect(result.top).toBe("budget");
    expect(result.confidence).toBe("high");
  });

  it("fits the typed 'Budget: ... Actual: ...' sentence", () => {
    const result = fitOf({ figuresText: "Budget: Marketing $10,000. Actual: Marketing $14,000." });
    expect(result.top).toBe("budget");
  });

  it("gives one side alone only a weak score", () => {
    const result = fitOf({ figuresText: BUDGET_SHEET });
    expect(scoreOf(result, "budget")).toBeLessThan(0.4);
    expect(result.confidence).toBe("low");
  });

  it("reads the sheet names the import reported, even when the text holds one sheet", () => {
    const named = fitOf({ figuresText: BUDGET_SHEET, sheetNames: ["Anggaran 2024", "Realisasi 2024"] });
    const bare = fitOf({ figuresText: BUDGET_SHEET });
    expect(scoreOf(named, "budget")).toBeGreaterThan(scoreOf(bare, "budget"));
  });
});

describe("scoreFinanceTaskFit: cash flow", () => {
  it("fits a cash book: three months, cash in and cash out, an opening balance", () => {
    const result = fitOf({ figuresText: CASH_BOOK });
    expect(result.top).toBe("cashflow");
    expect(result.confidence).toBe("high");
  });

  it("fits the typed opening-cash sentence", () => {
    const result = fitOf({ figuresText: CASH_SENTENCE });
    expect(result.top).toBe("cashflow");
  });

  it("does not take a plain monthly P&L for a cash book on months alone", () => {
    const result = fitOf({ figuresText: MONTHLY_PL });
    expect(result.top).toBe("brief");
    expect(scoreOf(result, "cashflow")).toBeLessThan(scoreOf(result, "brief"));
  });

  it("reads month periods written as ISO days", () => {
    const ledger = [
      "Opening cash: 90000",
      "Cash in (2024-01-15): 20000",
      "Cash out (2024-01-20): -26000",
      "Cash in (2024-02-15): 22000",
      "Cash out (2024-02-20): -24000",
      "Cash in (2024-03-15): 23000",
      "Cash out (2024-03-20): -25000",
    ].join("\n");
    expect(fitOf({ figuresText: ledger }).top).toBe("cashflow");
  });
});

describe("scoreFinanceTaskFit: ratios", () => {
  it("fits a balance sheet and a P&L together", () => {
    const result = fitOf({ figuresText: STATEMENTS });
    expect(result.top).toBe("ratios");
    expect(result.confidence).toBe("high");
  });

  it("does not take a P&L with no balance sheet for ratios", () => {
    const result = fitOf({ figuresText: ANNUAL_PL });
    expect(scoreOf(result, "ratios")).toBeLessThan(scoreOf(result, "brief"));
  });

  it("gives a balance sheet alone a middling score", () => {
    const balanceOnly = STATEMENTS.split("\n")
      .filter((line) => !/Pendapatan|Beban/.test(line))
      .join("\n");
    const score = scoreOf(fitOf({ figuresText: balanceOnly }), "ratios");
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(FINANCE_FIT_HIGH_SCORE);
  });
});

describe("scoreFinanceTaskFit: appraisal", () => {
  it("fits a year-column grid with an outlay and a stated discount rate", () => {
    const result = fitOf({ figuresText: `${APPRAISAL_GRID}\nNote: discount rate 12%` });
    expect(result.top).toBe("appraisal");
    expect(result.confidence).toBe("high");
  });

  it("fits the typed outlay-and-years sentence", () => {
    const result = fitOf({ figuresText: APPRAISAL_SENTENCE });
    expect(result.top).toBe("appraisal");
    expect(result.confidence).toBe("high");
  });

  it("finds the rate in the document's prose as well", () => {
    const plain = scoreOf(fitOf({ figuresText: APPRAISAL_GRID }), "appraisal");
    const withProse = scoreOf(
      fitOf({ figuresText: APPRAISAL_GRID, proseText: "Use a discount rate of 12% per year." }),
      "appraisal",
    );
    expect(withProse).toBeGreaterThan(plain);
  });

  it("does not read calendar years as project years", () => {
    expect(fitOf({ figuresText: ANNUAL_PL }).top).toBe("brief");
  });
});

describe("scoreFinanceTaskFit: brief, the fallback", () => {
  it("takes a multi-year P&L, with low confidence", () => {
    const result = fitOf({ figuresText: ANNUAL_PL });
    expect(result.top).toBe("brief");
    expect(result.confidence).toBe("low");
  });

  it("takes prose with no table at all", () => {
    const result = fitOf({ figuresText: "Revenue was strong this year and costs were stable.", proseText: "" });
    expect(result.top).toBe("brief");
    expect(result.confidence).toBe("low");
  });

  it("takes an empty input", () => {
    const result = fitOf({ figuresText: "" });
    expect(result.top).toBe("brief");
    expect(result.confidence).toBe("low");
    expect(result.ranked.every((entry) => entry.score <= 0.3)).toBe(true);
  });
});

describe("scoreFinanceTaskFit: the prompt is one more signal", () => {
  const cases: ReadonlyArray<readonly [string, string, FinanceTask]> = [
    ["en cashflow", "How long does my cash last?", "cashflow"],
    ["id cashflow", "Berapa lama kas saya bertahan?", "cashflow"],
    ["en cashflow runway", "What is my runway and burn rate?", "cashflow"],
    ["en budget", "Am I over budget this quarter?", "budget"],
    ["id budget", "Apakah realisasi melebihi anggaran?", "budget"],
    ["en appraisal", "Is this investment worth it?", "appraisal"],
    ["id appraisal", "Apakah investasi ini layak, berapa balik modalnya?", "appraisal"],
    ["en appraisal npv", "What is the NPV and IRR?", "appraisal"],
    ["en ratios", "Check my liquidity and leverage ratios.", "ratios"],
    ["id ratios", "Bagaimana rasio likuiditas dan solvabilitas kami?", "ratios"],
    ["en brief", "Give me a summary of how we did.", "brief"],
    ["id brief", "Buat ringkasan kinerja keuangan.", "brief"],
  ];

  it.each(cases)("a %s prompt lifts its own task", (_label, prompt, task) => {
    const without = scoreOf(fitOf({ figuresText: MONTHLY_PL }), task);
    const withPrompt = scoreOf(fitOf({ figuresText: MONTHLY_PL, prompt }), task);
    expect(withPrompt).toBeGreaterThan(without);
    expect(fitOf({ figuresText: MONTHLY_PL, prompt }).ranked.find((entry) => entry.task === task)?.signals).toContain(
      `prompt:${task}`,
    );
  });

  it("tips a monthly sheet to cash flow when the question is about cash", () => {
    const result = fitOf({ figuresText: MONTHLY_PL, prompt: "How long does my cash last?" });
    expect(result.top).toBe("cashflow");
  });

  it("does not override strong evidence in the figures", () => {
    const result = fitOf({ figuresText: BUDGET_TWO_SHEETS, prompt: "Summarise how we did." });
    expect(result.top).toBe("budget");
  });

  it("ranks by the question alone when there are no figures, and says so with low confidence", () => {
    const result = fitOf({ figuresText: "", prompt: "Is this investment worth it?" });
    expect(result.top).toBe("appraisal");
    expect(result.confidence).toBe("low");
  });

  it("ignores a prompt that names nothing and a prompt of only whitespace", () => {
    const base = fitOf({ figuresText: CASH_BOOK });
    expect(fitOf({ figuresText: CASH_BOOK, prompt: "   " })).toEqual(base);
    expect(fitOf({ figuresText: CASH_BOOK, prompt: "hello there" })).toEqual(base);
  });
});

describe("fitConfidence", () => {
  const ranked = (top: number, second: number): FinanceTaskFit[] => [
    { task: "ratios", score: top, signals: [] },
    { task: "brief", score: second, signals: [] },
  ];

  it("is high when the top score reaches the bar and leads by the margin", () => {
    expect(fitConfidence(ranked(FINANCE_FIT_HIGH_SCORE, FINANCE_FIT_HIGH_SCORE - FINANCE_FIT_HIGH_LEAD - 0.001))).toBe(
      "high",
    );
    expect(fitConfidence(ranked(0.7, 0.5))).toBe("high");
  });

  it("is low below the bar, or with a lead under the margin", () => {
    expect(fitConfidence(ranked(0.69, 0.1))).toBe("low");
    expect(fitConfidence(ranked(0.8, 0.65))).toBe("low");
    expect(fitConfidence(ranked(0.9, 0.71))).toBe("low");
  });

  it("is low for an empty list", () => {
    expect(fitConfidence([])).toBe("low");
  });

  it("uses the numbers the plan names", () => {
    expect(FINANCE_FIT_HIGH_SCORE).toBe(0.7);
    expect(FINANCE_FIT_HIGH_LEAD).toBe(0.2);
  });
});

describe("scoreFinanceTaskFit: two sheets named budget and actual", () => {
  // Two sheets whose own names say budget and actual are strong evidence by themselves; a workbook
  // written by two hands does not reuse the same line labels, so no shared label is needed for it.
  it("fits sheets named Anggaran and Realisasi even when no line label is shared", () => {
    const text = [
      "Sheet: Anggaran 2024",
      "[Pendapatan] Donasi individu: 1850000000",
      "[Pendapatan] Hibah korporasi: 1200000000",
      "Sheet: Realisasi 2024",
      "[Penerimaan] Penerimaan donasi perorangan: 1642500000",
      "[Penerimaan] Dana hibah perusahaan: 1380000000",
    ].join("\n");
    const result = fitOf({ figuresText: text });
    expect(result.top).toBe("budget");
    expect(result.confidence).toBe("high");
  });
});

describe("readAppraisalRows", () => {
  it("reads a year grid, and the typed sentence, and nothing else", () => {
    expect(readAppraisalRows(APPRAISAL_GRID)?.kind).toBe("grid");
    expect(readAppraisalRows(APPRAISAL_SENTENCE)?.kind).toBe("sentence");
    expect(readAppraisalRows("Revenue was strong this year.")).toBeNull();
    expect(readAppraisalRows("")).toBeNull();
  });

  it("falls back to the prose when the figures hold nothing", () => {
    expect(readAppraisalRows("", APPRAISAL_SENTENCE)?.kind).toBe("sentence");
  });

  it("refuses a P&L of small round numbers, which the grid reader would take for years", () => {
    expect(readAppraisalRows(ANNUAL_PL)).toBeNull();
    expect(readAppraisalRows(MONTHLY_PL)).toBeNull();
  });
});
