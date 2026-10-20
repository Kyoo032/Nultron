/**
 * The renderer's half of `POST /api/v1/finance/auto`: what is sent, how the answer is read, and the
 * small pure rules the prompt-first Finance screen runs on (docs/internal/doc-flow-plan.md section 3,
 * with the owner's answers in 7a).
 *
 * The route is free and code-only. It reads a file's figures into the task they fit and answers a
 * preview (the report with its prose left empty). The paid write-up is the existing `/finance/stream`,
 * and it only ever runs on the person's own press, so nothing here sends it.
 *
 * Never trust the wire. `parseFinanceAuto` returns `null` for an answer that is not the shape, and it
 * drops a single chart, table or flag that is malformed rather than letting one bad cell take the whole
 * preview down. The network calls live in `finance-auto-io.ts` so this file stays testable without one.
 */
import {
  FINANCE_FIGURES_TEXT_MAX,
  FINANCE_TASKS,
  defaultFinancePrompt,
  fitFiguresToCap,
  isFinanceTask,
  isReportChartKind,
  isReportFlagLevel,
  type FinanceFitConfidence,
  type FinanceReport,
  type FinanceTask,
  type ReportCell,
  type ReportChart,
  type ReportFlag,
  type ReportKpi,
  type ReportLocale,
  type ReportNote,
  type ReportTable,
} from "@agentforge/core/finance";
import { saveFinanceDraft, type FinanceDraft } from "./finance-drafts";
import { parseFinancePii, type FinancePiiSummary } from "./finance-import-warnings";
import { t } from "./i18n";

export const FINANCE_AUTO_PATH = "/api/v1/finance/auto";
/** The host's own caps, restated only by name: one text, one prompt, one list of sheet names. */
export const FINANCE_AUTO_TEXT_MAX = FINANCE_FIGURES_TEXT_MAX;
export const FINANCE_AUTO_PROMPT_MAX = 2000;
export const FINANCE_AUTO_SHEET_NAMES_MAX = 100;
/** A prompt on its own (no file) has to be a word or two before it is worth a read. */
export const FINANCE_AUTO_MIN_PROMPT_CHARS = 3;

// -- the answer -----------------------------------------------------------------------------------

export type FinanceAutoFit = {
  readonly task: FinanceTask;
  readonly score: number;
  /** Short codes for the evidence. Kept for a bug report; never shown. */
  readonly signals: readonly string[];
};

export type FinanceAutoWarning = {
  readonly code: string;
  /** The host's own sentence, in the language the request named. Shown only for a code with no copy here. */
  readonly message: string;
  readonly detail: readonly string[];
};

export type FinanceAutoAnswer = {
  readonly fits: {
    readonly top: FinanceTask;
    readonly confidence: FinanceFitConfidence;
    readonly ranked: readonly FinanceAutoFit[];
  };
  /** The task the preview is for. */
  readonly task: FinanceTask;
  /** The confirmed input that task takes. Spread into the write-up; never edited here. */
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly preview: FinanceReport | null;
  readonly rowsUsed: number;
  readonly unplaced: readonly { readonly label: string; readonly period: string }[];
  readonly warnings: readonly FinanceAutoWarning[];
  readonly pii: FinancePiiSummary;
  readonly prompt: string;
  readonly promptSource: "user" | "default";
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).map((entry) => String(entry ?? ""));
}

// -- the preview report, defensively --------------------------------------------------------------

function cellOf(value: unknown): ReportCell {
  return typeof value === "string" || typeof value === "boolean" || finite(value) !== null ? (value as ReportCell) : null;
}

function kpiOf(value: unknown): ReportKpi[] {
  const row = record(value);
  const label = text(row?.label);
  if (!row || label === null) {
    return [];
  }
  const raw = row.value;
  const shown = typeof raw === "string" ? raw : finite(raw);
  return [
    {
      label,
      value: shown,
      ...(typeof row.unit === "string" ? { unit: row.unit } : {}),
      ...(isReportFlagLevel(row.flag) ? { flag: row.flag } : {}),
    },
  ];
}

function tableOf(value: unknown): ReportTable[] {
  const row = record(value);
  if (!row || text(row.id) === null || !Array.isArray(row.columns) || !Array.isArray(row.rows)) {
    return [];
  }
  return [
    {
      id: String(row.id),
      title: text(row.title) ?? "",
      columns: strings(row.columns),
      rows: row.rows.map((entry) => list(entry).map(cellOf)),
    },
  ];
}

function chartOf(value: unknown): ReportChart[] {
  const row = record(value);
  if (!row || text(row.id) === null || !isReportChartKind(row.kind) || !Array.isArray(row.categories)) {
    return [];
  }
  if (!Array.isArray(row.series)) {
    return [];
  }
  const series = row.series.flatMap((entry) => {
    const one = record(entry);
    return one && Array.isArray(one.values)
      ? [{ name: text(one.name) ?? "", values: one.values.map((point) => finite(point)) }]
      : [];
  });
  return [
    {
      id: String(row.id),
      title: text(row.title) ?? "",
      kind: row.kind,
      categories: strings(row.categories),
      series,
      ...(typeof row.note === "string" ? { note: row.note } : {}),
    },
  ];
}

function flagOf(value: unknown): ReportFlag[] {
  const row = record(value);
  return row && isReportFlagLevel(row.level) && text(row.text) !== null
    ? [{ level: row.level, text: String(row.text) }]
    : [];
}

function noteOf(value: unknown): ReportNote[] {
  const row = record(value);
  return row && text(row.heading) !== null && text(row.body) !== null
    ? [{ heading: String(row.heading), body: String(row.body) }]
    : [];
}

function reportLocale(value: unknown): ReportLocale {
  return value === "id" ? "id" : "en";
}

function previewOf(value: unknown, task: FinanceTask): FinanceReport | null {
  const row = record(value);
  if (!row) {
    return null;
  }
  return {
    task: text(row.task) ?? task,
    title: text(row.title) ?? "",
    ...(typeof row.subtitle === "string" ? { subtitle: row.subtitle } : {}),
    locale: reportLocale(row.locale),
    ...(typeof row.currency === "string" ? { currency: row.currency } : {}),
    summary: list(row.summary).flatMap(kpiOf),
    tables: list(row.tables).flatMap(tableOf),
    charts: list(row.charts).flatMap(chartOf),
    flags: list(row.flags).flatMap(flagOf),
    notes: list(row.notes).flatMap(noteOf),
  };
}

// -- the answer, defensively ----------------------------------------------------------------------

function fitsOf(value: unknown): FinanceAutoAnswer["fits"] | null {
  const row = record(value);
  if (!row || !isFinanceTask(row.top) || (row.confidence !== "high" && row.confidence !== "low")) {
    return null;
  }
  if (!Array.isArray(row.ranked)) {
    return null;
  }
  const ranked = row.ranked.flatMap((entry): FinanceAutoFit[] => {
    const one = record(entry);
    return one && isFinanceTask(one.task)
      ? [{ task: one.task, score: finite(one.score) ?? 0, signals: strings(one.signals) }]
      : [];
  });
  return { top: row.top, confidence: row.confidence, ranked };
}

function warningsOf(value: unknown): FinanceAutoWarning[] {
  return list(value).flatMap((entry): FinanceAutoWarning[] => {
    const one = record(entry);
    const code = text(one?.code);
    return one && code !== null && code.trim() !== ""
      ? [{ code, message: text(one.message) ?? "", detail: strings(one.detail) }]
      : [];
  });
}

/** The host's answer, or `null` for anything that is not it. */
export function parseFinanceAuto(payload: unknown): FinanceAutoAnswer | null {
  const row = record(payload);
  const fits = fitsOf(row?.fits);
  if (!row || !fits || !isFinanceTask(row.task)) {
    return null;
  }
  const input = record(row.input);
  return {
    fits,
    task: row.task,
    input,
    preview: previewOf(row.preview, row.task),
    rowsUsed: finite(row.rowsUsed) ?? 0,
    unplaced: list(row.unplaced).flatMap((entry) => {
      const one = record(entry);
      return one && text(one.label) !== null ? [{ label: String(one.label), period: text(one.period) ?? "" }] : [];
    }),
    warnings: warningsOf(row.warnings),
    pii: parseFinancePii(row.pii),
    prompt: text(row.prompt) ?? "",
    promptSource: row.promptSource === "user" ? "user" : "default",
  };
}

/** There is something to write up only when the figures were read into an input and a preview was drawn. */
export function canWriteUp(answer: FinanceAutoAnswer): boolean {
  return answer.input !== null && answer.preview !== null;
}

// -- holding text to the host's caps --------------------------------------------------------------

/** The file's figures and anything pasted beside them, as one text held to the host's cap. */
export function joinFigures(...parts: readonly string[]): string {
  const present = parts.map((part) => part.trim()).filter((part) => part !== "");
  return fitFiguresToCap(present.join("\n"), FINANCE_AUTO_TEXT_MAX);
}

// -- what is sent ---------------------------------------------------------------------------------

export type FinanceAutoInput = {
  /** The file's figures, and anything pasted beside them. */
  readonly figures?: string;
  readonly proseText?: string;
  readonly sheetNames?: readonly string[];
  readonly prompt?: string;
  readonly locale: "en" | "id";
};

/**
 * The body of the free read, or `null` when there is nothing worth sending yet (no figures, and a
 * prompt too short to mean anything). Empty fields are left out; text is held to the host's caps here
 * so the host's own 400 is never what the person meets.
 */
export function financeAutoRequestBody(input: FinanceAutoInput): Record<string, unknown> | null {
  const figuresText = fitFiguresToCap((input.figures ?? "").trim(), FINANCE_AUTO_TEXT_MAX);
  const proseText = fitFiguresToCap((input.proseText ?? "").trim(), FINANCE_AUTO_TEXT_MAX);
  const prompt = (input.prompt ?? "").trim().slice(0, FINANCE_AUTO_PROMPT_MAX);
  const sheetNames = (input.sheetNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .slice(0, FINANCE_AUTO_SHEET_NAMES_MAX);
  if (figuresText === "" && proseText === "" && prompt.length < FINANCE_AUTO_MIN_PROMPT_CHARS) {
    return null;
  }
  return {
    ...(figuresText ? { figuresText } : {}),
    ...(proseText ? { proseText } : {}),
    ...(sheetNames.length > 0 ? { sheetNames } : {}),
    ...(prompt ? { prompt } : {}),
    locale: input.locale,
  };
}

export type FinanceAutoWriteOptions = {
  readonly prompt: string;
  readonly language: "en" | "id";
  readonly model?: string;
  /** True only when the person moved the picker, so a seeded default stays rescuable by the host's fallback. */
  readonly modelPinned?: boolean;
};

/**
 * The paid write-up request: the confirmed input the preview was computed from, plus the task, the
 * question and the language. The answer's own keys come last so an input can never rename the task
 * or swap the question. It runs only on the person's press.
 */
export function financeAutoStreamBody(
  answer: FinanceAutoAnswer,
  options: FinanceAutoWriteOptions,
): Record<string, unknown> {
  const question = options.prompt.trim() || defaultFinancePrompt(answer.task, options.language);
  return {
    ...(answer.input ?? {}),
    task: answer.task,
    prompt: question,
    locale: options.language,
    ...(options.model ? { model: options.model } : {}),
    ...(options.model && options.modelPinned ? { modelPinned: true } : {}),
  };
}

// -- the other tasks, and opening one ---------------------------------------------------------------

/**
 * The tasks the screen offers besides the one it previewed, best fit first. The host has no way to
 * read the same figures as a task of the person's choosing, so these open that task's own page.
 */
export function financeAutoSwitchTasks(answer: FinanceAutoAnswer): FinanceTask[] {
  const ranked = answer.fits.ranked.map((entry) => entry.task);
  const everyTask = [...ranked, ...FINANCE_TASKS.filter((task) => !ranked.includes(task))];
  return everyTask.filter((task, at) => task !== answer.task && everyTask.indexOf(task) === at);
}

/**
 * Put the figures and the question in a task's own draft, so that task's page opens with them in its
 * box. Nothing is read or computed by this; the task page asks for its own press.
 */
export function openTaskWithDraft(workspaceId: string | null, task: FinanceTask, draft: FinanceDraft): void {
  saveFinanceDraft(workspaceId, task, draft);
}

// -- what a warning says ----------------------------------------------------------------------------

const WARNING_KEYS: Readonly<Record<string, string>> = {
  no_figures: "finance.auto.warnings.noFigures",
  prose_no_table: "finance.auto.warnings.proseNoTable",
  not_enough_rows: "finance.auto.warnings.notEnoughRows",
  input_rejected: "finance.auto.warnings.inputRejected",
  fell_back: "finance.auto.warnings.fellBack",
  unplaced_rows: "finance.auto.warnings.unplacedRows",
  default_discount_rate: "finance.auto.warnings.defaultDiscountRate",
  unpaired_lines: "finance.auto.warnings.unpairedLines",
};

/**
 * The sentence for one warning. A known code is written here from its details, so it reads the same in
 * both languages; a reader note is the reader's own sentence; any other code falls back to the host's.
 */
export function financeAutoWarningText(warning: FinanceAutoWarning): string {
  if (warning.code === "reader_note") {
    return warning.detail[0] ?? warning.message;
  }
  const key = WARNING_KEYS[warning.code];
  if (!key) {
    return warning.message;
  }
  const [first = "", second = ""] = warning.detail;
  return t(key, { n: first, task: first, from: first, to: second, rate: first });
}
