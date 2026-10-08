/**
 * Which Finance task a file's figures fit, scored in code.
 *
 * "Add the sheet, get the answer" needs a first guess at what the sheet is. This is that guess, and
 * it is only a guess: it is made from the shape of the text — the periods, the row labels, the words a
 * sheet is named with — and from the person's own question, never by a model, and it produces no
 * amount. The host tries the tasks in the order this ranks them and keeps the first whose confirmed
 * input is complete enough to compute, so a wrong guess costs one more try and never a wrong figure.
 *
 * Scores are 0 to 1 and each one carries the evidence behind it (`signals`), so the screen can say why
 * and a test can hold a rule to it. The brief is the fallback: it always has a small floor, and it
 * only wins when no other task has real evidence.
 *
 * Confidence is high only when the top score reaches {@link FINANCE_FIT_HIGH_SCORE} and leads the
 * runner-up by {@link FINANCE_FIT_HIGH_LEAD}.
 */
import {
  appraisalFlowsFromItems,
  appraisalGridFromText,
  discountRateFromText,
  outlayOf,
  type AppraisalGrid,
} from "./appraisal";
import { readBudgetScenario, type BudgetScenario } from "./budget";
import { readFiguresText, type FigureRow } from "./figures-text";
import { parsePeriod } from "./fiscal-periods";
import { appraisalItemsFromSentence, budgetSheetsFromSentence, cashflowLedgerFromSentence } from "./plain-sentences";
import { RATIO_BUCKET_STATEMENT } from "./ratios/buckets";
import { classifyRatioRows } from "./ratios/classify";
import { readRatioRows } from "./ratios/read-figures";
import { FINANCE_TASKS, type FinanceTask } from "./task-ids";
import type { LineItem } from "./types";

/** The top score must reach this for the fit to be called high. */
export const FINANCE_FIT_HIGH_SCORE = 0.7;
/** …and must lead the second place by at least this much. */
export const FINANCE_FIT_HIGH_LEAD = 0.2;

/** What the prompt box adds for a task whose own words it uses. One more signal, never the whole case. */
const PROMPT_WEIGHT = 0.35;
/** The brief's floor when the text reads as rows at all, and when it reads as nothing. */
const BRIEF_ROWS_FLOOR = 0.3;
const BRIEF_EMPTY_FLOOR = 0.1;
/** A prompt is a sentence or two; the cap only keeps a pasted document from reaching the patterns. */
const PROMPT_READ_MAX = 2000;

export type FinanceTaskFitInput = {
  /** The figures text the import (or the paste box) holds. */
  readonly figuresText: string;
  /** The document's prose around its tables, when there was any. */
  readonly proseText?: string;
  /** Every sheet name the import listed, including the sheets that were not read. */
  readonly sheetNames?: readonly string[];
  /** What the person asked, in their own words. English or Indonesian. */
  readonly prompt?: string;
};

export type FinanceTaskFit = {
  readonly task: FinanceTask;
  readonly score: number;
  /** Short codes for the evidence behind the score, in the order they were found. */
  readonly signals: readonly string[];
};

export type FinanceFitConfidence = "high" | "low";

export type FinanceTaskFitResult = {
  /** The best fit. The brief when nothing else has evidence. */
  readonly top: FinanceTask;
  readonly confidence: FinanceFitConfidence;
  /** All five tasks, best first. Ties keep the specific tasks ahead of the brief. */
  readonly ranked: readonly FinanceTaskFit[];
};

type Scored = { readonly score: number; readonly signals: readonly string[] };
type Part = readonly [signal: string, weight: number, met: boolean];

/** Sum the parts that hold, capped at 1 and rounded so a comparison never rides on float noise. */
function scored(parts: readonly Part[]): Scored {
  const met = parts.filter(([, , holds]) => holds);
  const total = met.reduce((sum, [, weight]) => sum + weight, 0);
  return { score: Math.round(Math.min(1, total) * 1000) / 1000, signals: met.map(([signal]) => signal) };
}

/** High confidence: the top score reaches the bar and leads the runner-up by the margin. */
export function fitConfidence(ranked: readonly FinanceTaskFit[]): FinanceFitConfidence {
  const top = ranked[0]?.score;
  if (top === undefined) {
    return "low";
  }
  const second = ranked[1]?.score ?? 0;
  const lead = Math.round((top - second) * 1000) / 1000;
  return top >= FINANCE_FIT_HIGH_SCORE && lead >= FINANCE_FIT_HIGH_LEAD ? "high" : "low";
}

// -- what the text holds ----------------------------------------------------------------------------

const SHEET_LINE = /^\s*Sheet:\s*(.*)$/;

type Sheet = { readonly name: string; readonly rows: readonly FigureRow[] };

/** The figures text cut back into the sheets it was joined from, each read as rows. */
function sheetsOf(text: string): Sheet[] {
  const blocks: Array<{ name: string; lines: string[] }> = [{ name: "", lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const named = SHEET_LINE.exec(line);
    if (named) {
      blocks.push({ name: (named[1] ?? "").trim(), lines: [] });
      continue;
    }
    blocks[blocks.length - 1]?.lines.push(line);
  }
  return blocks
    .filter((block) => block.lines.some((line) => line.trim() !== ""))
    .map((block) => ({ name: block.name, rows: readFiguresText(block.lines.join("\n")).rows }));
}

type Evidence = {
  readonly figures: string;
  readonly prose: string;
  /** The text the rows were read from: the figures, or the prose when the figures held none. */
  readonly source: string;
  readonly sheets: readonly Sheet[];
  readonly rows: readonly FigureRow[];
  readonly sheetNames: readonly string[];
  readonly prompt: string;
};

function evidenceOf(input: FinanceTaskFitInput): Evidence {
  const figures = input.figuresText ?? "";
  const prose = input.proseText ?? "";
  const fromFigures = sheetsOf(figures);
  const useProse = fromFigures.every((sheet) => sheet.rows.length === 0) && prose.trim() !== "";
  const sheets = useProse ? sheetsOf(prose) : fromFigures;
  return {
    figures,
    prose,
    source: useProse ? prose : figures,
    sheets,
    rows: sheets.flatMap((sheet) => sheet.rows),
    sheetNames: [...(input.sheetNames ?? []), ...sheets.map((sheet) => sheet.name)].filter((name) => name !== ""),
    prompt: (input.prompt ?? "").trim().slice(0, PROMPT_READ_MAX),
  };
}

function normalLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// -- the prompt -------------------------------------------------------------------------------------

/** Words a question uses when it is about one task, in English and Indonesian. Both always apply. */
const PROMPT_WORDS: Readonly<Record<FinanceTask, RegExp>> = Object.freeze({
  cashflow:
    /\bcash\s*-?\s*flow\b|\brunway\b|\bburn(?:\s*rate)?\b|\bcash\b[^.?!]{0,30}\b(?:last|lasts|run\s*out|runs\s*out|position|left)\b|\bhow\s+long\b[^.?!]{0,30}\bcash\b|\barus\s+kas\b|\bkas\b[^.?!]{0,30}\b(?:bertahan|habis|cukup|tersisa)\b|\bberapa\s+lama\b[^.?!]{0,30}\bkas\b|\bsisa\s+kas\b|\bsaldo\s+kas\b/i,
  budget:
    /\bbudget(?:s|ed)?\b|\bvariances?\b|\bover\s*-?\s*spen[dt]|\bunder\s*-?\s*spen[dt]|\bvs\.?\s+actual|\bversus\b[^.?!]{0,20}\bactual|\banggaran\b|\brealisasi\b|\bselisih\b|\bmelebihi\b|\bmelampaui\b/i,
  appraisal:
    /\bworth\s+it\b|\binvest(?:ment|ing|ments)?\b|\bnpv\b|\birr\b|\bpayback\b|\bdiscount\s*rate\b|\bappraisal\b|\bfeasib|\breturn\s+on\b|\broi\b|\bhurdle\b|\bkelayakan\b|\blayak\b|\binvestasi\b|\bbalik\s+modal\b|\bdiskonto\b|\bpengembalian\s+modal\b/i,
  ratios:
    /\bratios?\b|\bliquidity\b|\bleverage\b|\bsolven(?:cy|t)\b|\bdscr\b|\bdebt\s*-?\s*to\s*-?\s*equity\b|\bbalance\s+sheet\b|\brasio\b|\blikuiditas\b|\bsolvabilitas\b|\bkesehatan\s+keuangan\b|\bneraca\b/i,
  brief:
    /\bsummary\b|\bsummari[sz]e\b|\bbrief\b|\boverview\b|\bhow\s+did\s+we\s+do\b|\bperformance\b|\bprofit(?:s|ability)?\b|\bmargins?\b|\bringkasan\b|\bringkas\b|\bkinerja\b|\blaba\b|\blaporan\b/i,
});

function promptNamesTask(prompt: string, task: FinanceTask): boolean {
  return prompt !== "" && PROMPT_WORDS[task].test(prompt);
}

// -- one scorer per task ----------------------------------------------------------------------------

const BUDGET_SIDES: readonly BudgetScenario[] = ["budget", "actual"];

function budgetSheetsOf(ev: Evidence): readonly Sheet[] {
  if (ev.rows.length > 0) {
    return ev.sheets;
  }
  // "Budget: Marketing $10,000. Actual: Marketing $14,000." reads as two sheets the budget reader pairs.
  const rewritten = budgetSheetsFromSentence(ev.source);
  return rewritten ? sheetsOf(rewritten) : [];
}

function scoreBudget(ev: Evidence): Scored {
  const labels = new Map<BudgetScenario, Set<string>>(BUDGET_SIDES.map((side) => [side, new Set<string>()]));
  for (const sheet of budgetSheetsOf(ev)) {
    const bySheet = readBudgetScenario(sheet.name)?.scenario;
    if (bySheet) {
      labels.get(bySheet)?.add("");
    }
    for (const row of sheet.rows) {
      const side = readBudgetScenario(row.period)?.scenario ?? bySheet;
      if (side && !row.derived) {
        labels.get(side)?.add(normalLabel(row.label));
      }
    }
  }
  const has = (side: BudgetScenario) => (labels.get(side)?.size ?? 0) > 0;
  const named = new Set(ev.sheetNames.flatMap((name) => readBudgetScenario(name)?.scenario ?? []));
  const both = BUDGET_SIDES.every(has);
  const one = !both && BUDGET_SIDES.some(has);
  const paired = [...(labels.get("budget") ?? [])].filter((label) => label !== "" && labels.get("actual")?.has(label));
  return scored([
    ["sides", 0.7, both],
    ["one-side", 0.15, one],
    ["pairs", 0.25, both && paired.length >= 1],
    ["pairs-3", 0.1, both && paired.length >= 3],
    ["sheet-names", 0.3, !both && named.size === BUDGET_SIDES.length],
  ]);
}

/** A period that names one month, as a key two periods of the same month share. Null when it names none. */
function monthKey(period: string): string | null {
  const day = /^\s*((?:19|20)\d{2})-(\d{1,2})(?:-\d{1,2})?\s*$/.exec(period);
  if (day) {
    return `${day[1]}-${Number(day[2])}`;
  }
  const parts = parsePeriod(period);
  return parts.month === null ? null : `${parts.year ?? ""}-${parts.month}`;
}

const IN_LABEL = /\bcash\s*in(?:flows?)?\b|\bkas\s+masuk\b|\binflows?\b|\bpemasukan\b|\bpenerimaan\b|\breceipts\b/i;
const OUT_LABEL = /\bcash\s*out(?:flows?)?\b|\bkas\s+keluar\b|\boutflows?\b|\bpengeluaran\b|\bdisbursements?\b/i;
const OPENING_LABEL = /saldo\s*awal|kas\s*awal|opening\s*(?:cash|balance)|beginning\s*(?:cash|balance)/i;
const CASHFLOW_SHEET = /arus\s*kas|cash\s*-?\s*flow|laporan\s*kas|buku\s*kas|cash\s*book/i;

function cashflowRowsOf(ev: Evidence): readonly FigureRow[] {
  if (ev.rows.length > 0) {
    return ev.rows;
  }
  // "Opening cash $90,000. Jan in $20,000, out $26,000." is the ledger a cash book would have been.
  const ledger = cashflowLedgerFromSentence(ev.source);
  return ledger ? readFiguresText(ledger).rows : [];
}

function scoreCashflow(ev: Evidence): Scored {
  const rows = cashflowRowsOf(ev);
  const months = new Set(rows.flatMap((row) => monthKey(row.period) ?? []));
  const words = rows.map((row) => `${row.label} ${row.section}`);
  const hasIn = words.some((text) => IN_LABEL.test(text));
  const hasOut = words.some((text) => OUT_LABEL.test(text));
  const opening = words.some((text) => OPENING_LABEL.test(text));
  const signed = rows.some((row) => row.amount < 0) && rows.some((row) => row.amount > 0);
  return scored([
    ["months", 0.25, months.size >= 3],
    ["months", 0.15, months.size === 2],
    ["in-out", 0.45, hasIn && hasOut],
    ["in-out", 0.25, hasIn !== hasOut],
    ["opening", 0.25, opening],
    ["signed", 0.1, signed && months.size >= 3],
    ["sheet-name", 0.1, ev.sheetNames.some((name) => CASHFLOW_SHEET.test(name))],
  ]);
}

const RATIO_SHEET =
  /neraca|balance\s*sheet|laba\s*rugi|income\s*statement|laporan\s*keuangan|financial\s*statements?|posisi\s*keuangan/i;

function scoreRatios(ev: Evidence): Scored {
  // A rule placed the row (a label word or a section heading); a row only the brief's category could
  // place is not evidence of a statement.
  const placed = classifyRatioRows(readRatioRows(ev.source).rows).filter(
    (row) => !row.derived && (row.source === "label" || row.source === "section"),
  );
  const statementOf = (statement: string) =>
    new Set(
      placed.filter((row) => RATIO_BUCKET_STATEMENT[row.bucket] === statement).map((row) => normalLabel(row.label)),
    );
  const balance = statementOf("balance-sheet").size;
  const income = statementOf("income-statement").size;
  const both = balance >= 1 && income >= 1;
  const base = both
    ? 0.3 + 0.35 * (Math.min(balance, 4) / 4) + 0.35 * (Math.min(income, 3) / 3)
    : balance >= 2
      ? 0.25 + 0.2 * (Math.min(balance, 4) / 4)
      : 0;
  return scored([
    [both ? "balance-and-income" : "balance-only", base, base > 0],
    ["sheet-name", 0.1, base > 0 && ev.sheetNames.some((name) => RATIO_SHEET.test(name))],
  ]);
}

const OUTLAY_WORDS = /\boutlay\b|\bcapex\b|\binvestasi\s+awal\b|\bmodal\s+awal\b|\binitial\s+investment\b/i;
const APPRAISAL_SHEET = /apprais|penilaian|kelayakan|investasi|investment|capex|\bnpv\b|\birr\b/i;

/**
 * A year-column grid the appraisal reader found, kept only when its header says "year": a word in the
 * label ("Year 1", "Tahun ke-2") or a year 0. The reader also takes a row of bare small numbers for a
 * header (`40 | 44 | 48` reads as years 40, 44 and 48), which is a P&L in thousands, not a project.
 */
function yearGridOf(figures: string): AppraisalGrid | null {
  const grid = appraisalGridFromText(figures);
  const names = (grid?.periods ?? []).some((period) => /\D/.test(period.trim()) || Number(period) === 0);
  return grid && names ? grid : null;
}

export type AppraisalRead = {
  /** The component rows, one per year and line, as the appraisal task takes them. */
  readonly items: readonly LineItem[];
  readonly kind: "grid" | "sentence";
};

/**
 * The appraisal rows a code-only read finds: a year-column grid, or the typed "Outlay $200,000. Year 1
 * $60,000…" sentence. Null when the text is neither, which is the honest answer: free prose would need
 * the model, and a model is never asked from here. One reader for the fit score and for `/finance/auto`,
 * so what is scored as an appraisal is exactly what is read as one.
 */
export function readAppraisalRows(figuresText: string, proseText = ""): AppraisalRead | null {
  const grid = yearGridOf(figuresText);
  if (grid) {
    return { items: grid.items, kind: "grid" };
  }
  const sentence = appraisalItemsFromSentence(figuresText.trim() === "" ? proseText : figuresText);
  return sentence ? { items: sentence, kind: "sentence" } : null;
}

function scoreAppraisal(ev: Evidence): Scored {
  const found = readAppraisalRows(ev.figures, ev.prose);
  const items = found?.items ?? [];
  const flows = appraisalFlowsFromItems(items);
  const outlay = outlayOf(flows);
  const rate = discountRateFromText(`${ev.prompt}\n${ev.figures}\n${ev.prose}`) !== null;
  const read = items.length > 0;
  return scored([
    ["grid", 0.5, found?.kind === "grid"],
    ["sentence", 0.5, found?.kind === "sentence"],
    ["outlay", 0.2, read && outlay !== null && outlay < 0],
    ["flows", 0.1, read && flows.filter((flow) => flow.year >= 1).length >= 2],
    ["rate", 0.25, read && rate],
    ["rate", 0.2, !read && rate],
    ["outlay-words", 0.1, !read && OUTLAY_WORDS.test(`${ev.figures}\n${ev.prose}`)],
    ["sheet-name", 0.1, ev.sheetNames.some((name) => APPRAISAL_SHEET.test(name))],
  ]);
}

const REVENUE_LABEL = /revenue|pendapatan|penjualan|sales|omzet|omset|income|turnover/i;

function scoreBrief(ev: Evidence): Scored {
  const reads = ev.rows.length > 0;
  return scored([
    ["rows", BRIEF_ROWS_FLOOR, reads],
    ["fallback", BRIEF_EMPTY_FLOOR, !reads],
    ["revenue", 0.1, reads && ev.rows.some((row) => REVENUE_LABEL.test(row.label))],
  ]);
}

const SCORERS: Readonly<Record<FinanceTask, (ev: Evidence) => Scored>> = Object.freeze({
  cashflow: scoreCashflow,
  budget: scoreBudget,
  appraisal: scoreAppraisal,
  ratios: scoreRatios,
  brief: scoreBrief,
});

/** Ties go to the specific task: the brief is the fallback, so it is last. */
const TIE_ORDER: readonly FinanceTask[] = ["cashflow", "budget", "appraisal", "ratios", "brief"];

function withPrompt(task: FinanceTask, base: Scored, ev: Evidence): FinanceTaskFit {
  if (!promptNamesTask(ev.prompt, task)) {
    return { task, ...base };
  }
  return {
    task,
    score: Math.round(Math.min(1, base.score + PROMPT_WEIGHT) * 1000) / 1000,
    signals: [...base.signals, `prompt:${task}`],
  };
}

/**
 * Score the five tasks against one file's figures (and the person's question). Pure: no model, no
 * clock, no I/O, and the input is not changed.
 */
export function scoreFinanceTaskFit(input: FinanceTaskFitInput): FinanceTaskFitResult {
  const ev = evidenceOf(input);
  const ranked = FINANCE_TASKS.map((task) => withPrompt(task, SCORERS[task](ev), ev)).sort(
    (left, right) => right.score - left.score || TIE_ORDER.indexOf(left.task) - TIE_ORDER.indexOf(right.task),
  );
  return { top: ranked[0]?.task ?? "brief", confidence: fitConfidence(ranked), ranked };
}
