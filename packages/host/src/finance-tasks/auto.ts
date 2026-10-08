/**
 * Add a file, get a free preview: the code behind `POST /api/v1/finance/auto`
 * (docs/internal/doc-flow-plan.md section 3, with the owner's answers in 7a).
 *
 * The figures an import (or the paste box) holds are redacted, scored against the five Finance tasks,
 * read in fit order — with every model assist off — into the confirmed input that task takes, checked
 * for enough to work with, computed in core, and drawn as the report with its prose left empty: the
 * KPIs, the tables and the charts, and nothing a model wrote. The write-up stays the existing
 * `/finance/stream`, behind a button, because it uses the key.
 *
 * Nothing here can reach the gateway, and nothing may be added that does:
 *  - the brief is read by `readFiguresCodeOnly`, the ratios and budget parses run with `assists: false`,
 *    the cash-flow reader has no model in it, and the appraisal rows come from `readAppraisalRows`;
 *  - the route that calls this is not behind the gateway gate, so a closed gate cannot stop an owner
 *    seeing their own figures. If a model call ever creeps in, it needs the gate and a new owner answer.
 *
 * `compute` is the only producer of a figure. The preview is that figure drawn, never one a model made.
 */
import { ApiError, type AppLocale, type TenantContext } from "@agentforge/core";
import {
  DEFAULT_APPRAISAL_RATE_PERCENT,
  DEFAULT_BUDGET_THRESHOLDS,
  FINANCE_FIGURES_TEXT_MAX,
  RATIO_RATIO_METRICS,
  appraisalFlowsFromItems,
  defaultFinancePrompt,
  discountRateFromText,
  financeTaskMeta,
  getFinanceTaskModule,
  outlayOf,
  ratioValue,
  readAppraisalRows,
  scoreFinanceTaskFit,
  type AnyFinanceTaskModule,
  type FinanceFitConfidence,
  type FinanceReport,
  type FinanceTask,
  type FinanceTaskFit,
  type LineItem,
  type RatiosComputed,
} from "@agentforge/core/finance";
import { assertSafeSourceText } from "../job-source";
import { readFinanceLocale } from "../finance-locale";
import { readFiguresCodeOnly } from "../finance-parse-figures";
import { guardFinanceInput, mergeFinancePii, type FinancePiiSummary } from "../finance-privacy";
import { log } from "../log";
import { loadSettings } from "../settings-store";
import { parseBudgetFigures } from "./parse-budget";
import { parseCashflowInput } from "./parse-cashflow";
import { parseRatiosFigures } from "./parse-ratios";

// -- limits ---------------------------------------------------------------------------------------

/** A prompt is a sentence or two. The cap is the boundary check, not a product limit. */
export const FINANCE_AUTO_PROMPT_MAX = 2000;
/** Sheet names the import listed. A workbook with more than this many is not one a picker could show. */
export const FINANCE_AUTO_SHEET_NAMES_MAX = 100;
const SHEET_NAME_MAX = 200;
/** Unplaced rows reported back. The count is in the warning; the list is what a person can check. */
export const FINANCE_AUTO_UNPLACED_MAX = 50;
/** A task whose fit score is below this is not tried: it has no evidence worth a read. */
export const FINANCE_AUTO_TRY_MIN_SCORE = 0.2;

// -- the answer -----------------------------------------------------------------------------------

export type FinanceAutoWarningCode =
  | "no_figures"
  | "prose_no_table"
  | "not_enough_rows"
  | "input_rejected"
  | "fell_back"
  | "unplaced_rows"
  | "default_discount_rate"
  | "unpaired_lines"
  | "reader_note";

/** Same shape as an import warning, so the screen can map a code to its own copy and fall back to `message`. */
export type FinanceAutoWarning = {
  readonly code: FinanceAutoWarningCode;
  /** In the request's language. */
  readonly message: string;
  /** The numbers and names the message was written from, so a catalog can say it its own way. */
  readonly detail: readonly string[];
};

export type FinanceAutoUnplaced = { readonly label: string; readonly period: string };

export type FinanceAutoFits = {
  /** The task the figures fit best. */
  readonly top: FinanceTask;
  /**
   * `high` only when the task that was previewed IS the best fit and the fit is clear (top score at
   * least 0.7, leading by at least 0.2). A read that had to fall back to another task is `low`.
   */
  readonly confidence: FinanceFitConfidence;
  /** All five tasks, best first, each with the evidence behind its score. */
  readonly ranked: readonly FinanceTaskFit[];
};

export type FinanceAutoResult = {
  readonly fits: FinanceAutoFits;
  /** The task the preview is for. The best fit that had enough rows, or the best fit when none did. */
  readonly task: FinanceTask;
  /**
   * The confirmed input that task takes: spread it into `/finance/stream` with `{ task, prompt, locale }`
   * and that run computes exactly what `preview` shows. Null when nothing could be read without the model.
   */
  readonly input: Record<string, unknown> | null;
  /** The report with its prose empty: KPIs, tables and charts, every figure computed in code. Null with no input. */
  readonly preview: FinanceReport | null;
  /** Rows in `input`. */
  readonly rowsUsed: number;
  /** Rows no rule could place, which the owner may want to check. Capped at {@link FINANCE_AUTO_UNPLACED_MAX}. */
  readonly unplaced: readonly FinanceAutoUnplaced[];
  readonly warnings: readonly FinanceAutoWarning[];
  /** What the privacy guard hid before anything was read. Counts and kinds, never the values. */
  readonly pii: FinancePiiSummary;
  /** The question the write-up should answer: the person's own prompt, or the task's default one. */
  readonly prompt: string;
  readonly promptSource: "user" | "default";
};

// -- the request ----------------------------------------------------------------------------------

type AutoRequest = {
  readonly figuresText: string;
  readonly proseText: string;
  readonly sheetNames: readonly string[];
  readonly prompt: string;
};

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ApiError("invalid_request", `${field} must be a string`, 400);
  }
  if (value.length > max) {
    throw new ApiError("invalid_request", `${field} is over the ${max} character limit`, 400);
  }
  return value.trim();
}

/** Names from the import's `sheets` (strings, or `{ name }` objects as the import answered them). */
function sheetNamesFrom(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > FINANCE_AUTO_SHEET_NAMES_MAX) {
    throw new ApiError("invalid_request", "sheetNames must be a short list of names", 400);
  }
  return value.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string") {
      throw new ApiError("invalid_request", "sheetNames must be a list of names", 400);
    }
    return name.length > SHEET_NAME_MAX || name.trim() === "" ? [] : [name.trim()];
  });
}

/** Validate the body at the boundary. Never trusts the client: every field is checked, none is assumed. */
function readRequest(body: unknown, tenant: TenantContext): AutoRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  const record = body as Record<string, unknown>;
  const figuresText = text(record.figuresText, "figuresText", FINANCE_FIGURES_TEXT_MAX);
  const proseText = text(record.proseText, "proseText", FINANCE_FIGURES_TEXT_MAX);
  const prompt = text(record.prompt, "prompt", FINANCE_AUTO_PROMPT_MAX);
  const sheetNames = sheetNamesFrom(record.sheetNames ?? record.sheets);
  if (figuresText === "" && proseText === "" && prompt === "") {
    throw new ApiError("invalid_request", "Send figuresText, proseText or a prompt", 400);
  }
  // The prompt becomes the question the paid write-up answers, so it is held to the same injection
  // guard as any text that reaches a model, whether or not this route ever sends it to one.
  assertSafeSourceText(prompt, { injectionGuardBypass: loadSettings(tenant).injectionGuardBypass === true });
  return { figuresText, proseText, sheetNames, prompt };
}

// -- copy -----------------------------------------------------------------------------------------

const TASK_NAME = (task: FinanceTask, locale: AppLocale): string => financeTaskMeta(task).label[locale];

const COPY: Readonly<
  Record<FinanceAutoWarningCode, Readonly<Record<AppLocale, (detail: readonly string[]) => string>>>
> = Object.freeze({
  no_figures: {
    en: () => "There are no figures to read yet. Add a file or paste the figures.",
    id: () => "Belum ada angka untuk dibaca. Tambahkan file atau tempel angkanya.",
  },
  prose_no_table: {
    en: () =>
      "No table was found in this text, so there is nothing to preview without the model. The model can read it on request, and that uses your key.",
    id: () =>
      "Tidak ditemukan tabel di teks ini, jadi belum ada pratinjau tanpa model. Model bisa membacanya jika diminta, dan itu memakai kunci Anda.",
  },
  not_enough_rows: {
    en: () => "The figures were read, but there is too little to preview. Add more rows or check the figures.",
    id: () =>
      "Angka sudah dibaca, tetapi terlalu sedikit untuk dibuat pratinjau. Tambahkan baris atau periksa angkanya.",
  },
  input_rejected: {
    en: (detail) =>
      `The figures looked like ${detail[0]}, but they did not pass that task's checks, for example because there are too many rows. Open the task to see which.`,
    id: (detail) =>
      `Angka ini tampak seperti ${detail[0]}, tetapi tidak lolos pemeriksaan tugas itu, misalnya karena baris terlalu banyak. Buka tugasnya untuk melihat yang mana.`,
  },
  fell_back: {
    en: (detail) =>
      `It looked like ${detail[0]}, but that could not be built from this file, so it was read as ${detail[1]}.`,
    id: (detail) =>
      `Tampaknya ini ${detail[0]}, tetapi itu tidak bisa dibuat dari file ini, jadi dibaca sebagai ${detail[1]}.`,
  },
  unplaced_rows: {
    en: (detail) => `${detail[0]} row(s) could not be placed by the rules and were left as they are.`,
    id: (detail) => `${detail[0]} baris tidak bisa ditempatkan oleh aturan dan dibiarkan apa adanya.`,
  },
  default_discount_rate: {
    en: (detail) => `No discount rate was found, so ${detail[0]}% is shown. Change it in the appraisal.`,
    id: (detail) => `Tingkat diskonto tidak ditemukan, jadi ditampilkan ${detail[0]}%. Ubah di penilaian investasi.`,
  },
  unpaired_lines: {
    en: (detail) => `${detail[0]} line(s) have no partner on the other side yet.`,
    id: (detail) => `${detail[0]} baris belum punya pasangan di sisi lainnya.`,
  },
  reader_note: {
    en: (detail) => detail[0] ?? "",
    id: (detail) => detail[0] ?? "",
  },
});

function warning(code: FinanceAutoWarningCode, locale: AppLocale, detail: readonly string[] = []): FinanceAutoWarning {
  return { code, message: COPY[code][locale](detail), detail };
}

// -- reading one task -----------------------------------------------------------------------------

type Note = { readonly code: FinanceAutoWarningCode; readonly detail: readonly string[] };

/** What a code-only read of the text produced for one task, before it has been checked or computed. */
type TaskRead = {
  readonly input: Record<string, unknown>;
  readonly rows: number;
  readonly unplaced: readonly FinanceAutoUnplaced[];
  readonly notes: readonly Note[];
  /** The plan's "enough to work with" rule for this task, judged on what was read. */
  readonly enough: boolean;
};

type ReadContext = {
  readonly tenant: TenantContext;
  /** The redacted figures text, or the redacted prose when the figures held none. */
  readonly text: string;
  readonly figures: string;
  readonly prose: string;
  readonly prompt: string;
  readonly locale: AppLocale;
};

function uniqueUnplaced(rows: readonly FinanceAutoUnplaced[]): FinanceAutoUnplaced[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.label)) {
      return false;
    }
    seen.add(row.label);
    return true;
  });
}

/** A parse that finds nothing it can use answers a 422 `invalid_finance`: that is "no read", not a failure. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      return null;
    }
    throw error;
  }
}

async function readBrief(ctx: ReadContext): Promise<TaskRead | null> {
  const read = readFiguresCodeOnly(ctx.text, ctx.locale, { proseText: ctx.prose });
  if (!read) {
    return null;
  }
  const { items, proseFacts } = read.draft;
  const periodOf = (label: string) => items.find((item) => item.label === label)?.period ?? "";
  return {
    input: { items, params: {}, ...(proseFacts.length > 0 ? { statedFacts: proseFacts } : {}) },
    rows: items.length,
    unplaced: uniqueUnplaced(read.unclassified.map((entry) => ({ label: entry.label, period: periodOf(entry.label) }))),
    notes: [],
    enough: items.some((item) => item.category === "revenue"),
  };
}

async function readCashflow(ctx: ReadContext): Promise<TaskRead | null> {
  // The cash-flow reader is code from end to end: it has no model in it and takes no key.
  const parsed = await orNull(async () => parseCashflowInput(ctx.tenant, { figures: ctx.text }));
  const read = parsed as {
    items: unknown[];
    periods: readonly string[];
    currency: string;
    warnings: readonly string[];
  } | null;
  if (!read) {
    return null;
  }
  return {
    input: { items: read.items, params: read.currency ? { currency: read.currency } : {} },
    rows: read.items.length,
    unplaced: [],
    notes: read.warnings.map((message) => ({ code: "reader_note" as const, detail: [message] })),
    enough: read.periods.length >= 2,
  };
}

async function readBudget(ctx: ReadContext): Promise<TaskRead | null> {
  const parsed = await orNull(() => parseBudgetFigures(ctx.tenant, { figures: ctx.text }, { assists: false }));
  if (!parsed) {
    return null;
  }
  const matched = parsed.pairs.filter((pair) => pair.budgetLabel !== null && pair.actualLabel !== null).length;
  const loose = parsed.budgetOnly.length + parsed.actualOnly.length;
  // The owner's limits are not asked for up front. The screen shows the default (10%), and the preview
  // must flag the lines that screen would, so the default travels with the input.
  const params = {
    flagPct: DEFAULT_BUDGET_THRESHOLDS.pct,
    flagAbs: DEFAULT_BUDGET_THRESHOLDS.abs,
    flagMode: DEFAULT_BUDGET_THRESHOLDS.mode,
  };
  return {
    input: { items: parsed.items, params },
    rows: parsed.items.length,
    unplaced: uniqueUnplaced(
      parsed.excluded
        .filter((row) => row.reason === "unplaced")
        .map((row) => ({ label: row.label, period: row.period })),
    ),
    notes: loose > 0 ? [{ code: "unpaired_lines", detail: [String(loose)] }] : [],
    enough: matched >= 1,
  };
}

async function readAppraisal(ctx: ReadContext): Promise<TaskRead | null> {
  // Read here, in code, rather than through the appraisal parse hook: that hook falls through to the
  // brief's model read for free text, and this route must have no path to a model at all.
  const found = readAppraisalRows(ctx.figures, ctx.prose);
  if (!found) {
    return null;
  }
  const items: LineItem[] = guardFinanceInput({ lineItems: found.items }).lineItems;
  const flows = appraisalFlowsFromItems(items);
  const outlay = outlayOf(flows);
  const rate = discountRateFromText(`${ctx.prompt}\n${ctx.figures}\n${ctx.prose}`);
  const currency = items.find((item) => item.currency.trim() !== "")?.currency.trim() ?? "";
  const ratePercent = rate ?? DEFAULT_APPRAISAL_RATE_PERCENT;
  return {
    input: { items, params: { discountRatePercent: ratePercent, ...(currency ? { currency } : {}) } },
    rows: items.length,
    unplaced: [],
    notes: rate === null ? [{ code: "default_discount_rate", detail: [String(ratePercent)] }] : [],
    // An outlay (a negative year 0) and at least two later years: less is not an appraisal.
    enough: outlay !== null && outlay < 0 && flows.filter((flow) => flow.year >= 1).length >= 2,
  };
}

async function readRatios(ctx: ReadContext): Promise<TaskRead | null> {
  const parsed = await orNull(() =>
    parseRatiosFigures(ctx.tenant, { figures: ctx.text }, undefined, { assists: false }),
  );
  if (!parsed) {
    return null;
  }
  return {
    input: { items: parsed.items, params: { buckets: [], stated: parsed.stated }, locale: ctx.locale },
    rows: parsed.items.length,
    unplaced: uniqueUnplaced(
      parsed.buckets.filter((row) => row.source === "unknown").map((row) => ({ label: row.label, period: row.period })),
    ),
    notes: [],
    // Whether any ratio comes out is a fact about the computed figures; `enoughAfterCompute` checks it.
    enough: true,
  };
}

const READERS: Readonly<Record<FinanceTask, (ctx: ReadContext) => Promise<TaskRead | null>>> = Object.freeze({
  brief: readBrief,
  cashflow: readCashflow,
  budget: readBudget,
  appraisal: readAppraisal,
  ratios: readRatios,
});

/** "At least 1 ratio" for the ratios task: some ratio has a value in the period the scorecard reads. */
function hasARatio(computed: RatiosComputed): boolean {
  return RATIO_RATIO_METRICS.some((metric) => ratioValue(computed.ratios, metric.key, computed.period) !== null);
}

// -- the attempt ----------------------------------------------------------------------------------

/** Why a task gave no preview: nothing it could read, too little read, or a read its own schema refused. */
type Why = "no_read" | "not_enough" | "rejected";

type Attempt =
  | { readonly ok: true; readonly task: FinanceTask; readonly read: TaskRead; readonly preview: FinanceReport }
  | { readonly ok: false; readonly task: FinanceTask; readonly why: Why };

function previewOf(module: AnyFinanceTaskModule, read: TaskRead, locale: AppLocale): FinanceReport | Why {
  const parsed = module.inputSchema.safeParse(read.input);
  if (!parsed.success) {
    return "rejected";
  }
  try {
    const computed = module.compute(parsed.data);
    if (module.id === "ratios" && !hasARatio(computed as RatiosComputed)) {
      return "not_enough";
    }
    // The prose is empty on purpose: no model wrote anything, so the report carries the computed
    // figures and the task's name, and no sentence that could claim more than the figures say.
    const empty = { title: TASK_NAME(module.id, locale), sections: [], assumptions: [] };
    return module.buildReport(computed, empty, { locale });
  } catch (error) {
    // A task whose own arithmetic throws on this input is a bug to see, not a reason to fail the route.
    log.warn("finance_auto_compute_failed", {
      task: module.id,
      code: error instanceof ApiError ? error.code : "internal_error",
    });
    return "rejected";
  }
}

async function attempt(task: FinanceTask, ctx: ReadContext): Promise<Attempt> {
  const module = getFinanceTaskModule(task);
  const read = module ? await READERS[task](ctx) : null;
  if (!module || !read) {
    return { ok: false, task, why: "no_read" };
  }
  if (!read.enough) {
    return { ok: false, task, why: "not_enough" };
  }
  const preview = previewOf(module, read, ctx.locale);
  return typeof preview === "string" ? { ok: false, task, why: preview } : { ok: true, task, read, preview };
}

/** The tasks to try, in fit order: every task with evidence, then the brief as the last resort. */
function candidatesOf(ranked: readonly FinanceTaskFit[]): FinanceTask[] {
  const worthTrying = ranked.filter((entry) => entry.score >= FINANCE_AUTO_TRY_MIN_SCORE).map((entry) => entry.task);
  return worthTrying.includes("brief") ? worthTrying : [...worthTrying, "brief"];
}

// -- the route's body -----------------------------------------------------------------------------

/**
 * Read a file's figures into the task they fit, and preview it. Never calls a model, never needs a key.
 *
 * `body` is `{ figuresText, proseText?, sheetNames?, prompt?, locale? }`: the first two and the names are
 * what `POST /finance/import` answered. Throws an `ApiError` 400 for a body that is not that.
 */
export async function runFinanceAuto(tenant: TenantContext, body: unknown): Promise<FinanceAutoResult> {
  const request = readRequest(body, tenant);
  const locale = readFinanceLocale(body);
  // Redacted first, and the redacted copy is the only copy any reader below sees.
  const figures = guardFinanceInput({ figuresText: request.figuresText });
  const prose = guardFinanceInput({ figuresText: request.proseText });
  const pii = mergeFinancePii(figures.pii, prose.pii);
  const fit = scoreFinanceTaskFit({
    figuresText: figures.figuresText,
    proseText: prose.figuresText,
    sheetNames: request.sheetNames,
    prompt: request.prompt,
  });
  const ctx: ReadContext = {
    tenant,
    text: figures.figuresText || prose.figuresText,
    figures: figures.figuresText,
    prose: prose.figuresText,
    prompt: request.prompt,
    locale,
  };

  const hasText = ctx.text.trim() !== "";
  let won: Extract<Attempt, { ok: true }> | null = null;
  const failed: Attempt[] = [];
  for (const task of hasText ? candidatesOf(fit.ranked) : []) {
    const result = await attempt(task, ctx);
    if (result.ok) {
      won = result;
      break;
    }
    failed.push(result);
  }

  const task = won?.task ?? fit.top;
  const warnings: FinanceAutoWarning[] = [];
  if (!hasText) {
    warnings.push(warning("no_figures", locale));
  } else if (!won) {
    // Nothing could be read without the model. A task's own refusal is the most useful thing to say;
    // otherwise rows that were read but are too few; otherwise free prose, the usual reason.
    const rejected = failed.find((entry) => !entry.ok && entry.why === "rejected");
    const readAsTable = failed.some((entry) => !entry.ok && entry.why === "not_enough");
    warnings.push(
      rejected
        ? warning("input_rejected", locale, [TASK_NAME(rejected.task, locale)])
        : warning(readAsTable ? "not_enough_rows" : "prose_no_table", locale),
    );
  } else {
    if (won.task !== fit.top && failed.some((entry) => entry.task === fit.top)) {
      warnings.push(warning("fell_back", locale, [TASK_NAME(fit.top, locale), TASK_NAME(won.task, locale)]));
    }
    for (const note of won.read.notes) {
      warnings.push(warning(note.code, locale, note.detail));
    }
    if (won.read.unplaced.length > 0) {
      warnings.push(warning("unplaced_rows", locale, [String(won.read.unplaced.length)]));
    }
  }

  return {
    // A fit is only "clear" for the task that was actually previewed.
    fits: { top: fit.top, confidence: won && won.task === fit.top ? fit.confidence : "low", ranked: fit.ranked },
    task,
    input: won?.read.input ?? null,
    preview: won?.preview ?? null,
    rowsUsed: won?.read.rows ?? 0,
    unplaced: (won?.read.unplaced ?? []).slice(0, FINANCE_AUTO_UNPLACED_MAX),
    warnings,
    pii,
    prompt: request.prompt === "" ? defaultFinancePrompt(task, locale) : request.prompt,
    promptSource: request.prompt === "" ? "default" : "user",
  };
}
