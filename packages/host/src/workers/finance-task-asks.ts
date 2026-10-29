import type { AppLocale } from "@agentforge/core";
import { splitUserFileBlocks } from "@agentforge/core/chat-documents";
import { extractNumbers, financeTaskMeta, type FinanceTask } from "@agentforge/core/finance";

export const ANSWER_FIELDS = ["discountRatePercent", "openingCash"] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];
export type AskField = "file" | "task" | AnswerField;

export type FinanceAsk = { readonly field: AskField; readonly question: string; readonly choices?: string[] };

export type FinanceAnswers = { readonly discountRatePercent?: number; readonly openingCash?: number };

const TASK_CHOICES_MAX = 3;
const MATCH_RELATIVE = 1e-9;

const QUESTIONS: Readonly<Record<AskField, Readonly<Record<AppLocale, (names: string) => string>>>> = Object.freeze({
  file: {
    en: () =>
      "I could not read the figures from that file. Please attach the spreadsheet again in this chat, then ask your question.",
    id: () =>
      "Saya tidak bisa membaca angka dari file itu. Silakan lampirkan lagi spreadsheet-nya di obrolan ini, lalu ajukan pertanyaan Anda.",
  },
  task: {
    en: (names) => `Which review do you want for these figures: ${names}?`,
    id: (names) => `Tinjauan mana yang Anda inginkan untuk angka ini: ${names}?`,
  },
  discountRatePercent: {
    en: () => "What discount rate should the appraisal use, as a percent a year?",
    id: () => "Berapa tingkat diskonto yang dipakai untuk penilaian investasi ini, dalam persen per tahun?",
  },
  openingCash: {
    en: () => "No opening cash balance was found. How much cash was there at the start of the first period?",
    id: () => "Saldo awal kas tidak ditemukan. Berapa kas yang ada di awal periode pertama?",
  },
});

const OR: Readonly<Record<AppLocale, string>> = Object.freeze({ en: "or", id: "atau" });

function joinNames(names: readonly string[], locale: AppLocale): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} ${OR[locale]} ${names.at(-1)}`;
}

export function askFor(field: AskField, locale: AppLocale, choices?: readonly FinanceTask[]): FinanceAsk {
  if (field === "task" && choices && choices.length > 0) {
    const picked = choices.slice(0, TASK_CHOICES_MAX);
    const names = picked.map((task) => `${financeTaskMeta(task).label[locale]} (${task})`);
    return { field, question: QUESTIONS.task[locale](joinNames(names, locale)), choices: [...picked] };
  }
  return { field, question: QUESTIONS[field][locale]("") };
}

export function typedSegments(userText: string | undefined): string {
  if (!userText) {
    return "";
  }
  return splitUserFileBlocks(userText)
    .flatMap((segment) => (segment.type === "text" ? [segment.text] : []))
    .join("\n");
}

function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  return Math.abs(a - b) <= scale * MATCH_RELATIVE;
}

export function typedNumberMatches(value: number, typed: string): boolean {
  return extractNumbers(typed).some(
    (token) => sameNumber(token.value, value) || (token.alternate !== undefined && sameNumber(token.alternate, value)),
  );
}

export type AskContext = {
  readonly locale: AppLocale;
  readonly namedTask: FinanceTask | null;
  readonly task: FinanceTask;
  readonly confidence: "high" | "low";
  readonly ranked: readonly FinanceTask[];
  readonly warningCodes: readonly string[];
  readonly answers: FinanceAnswers;
  readonly typed: string;
  readonly rateFromRequestOnly: boolean;
  readonly inputRead: boolean;
  readonly readMessage: string;
};

export type FinanceDecision =
  | { readonly kind: "ask"; readonly ask: FinanceAsk }
  | { readonly kind: "fail"; readonly code: string; readonly message: string };

type DecisionRule = (ctx: AskContext) => FinanceDecision | null;

function ask(value: FinanceAsk): FinanceDecision {
  return { kind: "ask", ask: value };
}

function answerFieldFor(task: FinanceTask): AnswerField | null {
  if (task === "appraisal") {
    return "discountRatePercent";
  }
  return task === "cashflow" ? "openingCash" : null;
}

const MISSING_WARNING: Readonly<Record<AnswerField, string>> = Object.freeze({
  discountRatePercent: "default_discount_rate",
  openingCash: "no_opening_cash",
});

export const DECISION_RULES: readonly DecisionRule[] = Object.freeze([
  (ctx) => (ctx.namedTask === null && ctx.confidence !== "high" ? ask(askFor("task", ctx.locale, ctx.ranked)) : null),
  (ctx) => (ctx.inputRead ? null : { kind: "fail", code: "figures_not_read", message: ctx.readMessage }),
  (ctx) => {
    const field = answerFieldFor(ctx.task);
    if (field === null || ctx.answers[field] !== undefined) {
      return null;
    }
    const missing = ctx.warningCodes.includes(MISSING_WARNING[field]);
    const smuggled = field === "discountRatePercent" && ctx.rateFromRequestOnly;
    return missing || smuggled ? ask(askFor(field, ctx.locale)) : null;
  },
  (ctx) => {
    const field = answerFieldFor(ctx.task);
    const value = field === null ? undefined : ctx.answers[field];
    return field !== null && value !== undefined && !typedNumberMatches(value, ctx.typed)
      ? ask(askFor(field, ctx.locale))
      : null;
  },
]);

export function decide(ctx: AskContext): FinanceDecision | null {
  for (const rule of DECISION_RULES) {
    const decision = rule(ctx);
    if (decision) {
      return decision;
    }
  }
  return null;
}

export function appliedAnswer(
  task: FinanceTask,
  answers: FinanceAnswers,
): { field: AnswerField; value: number } | null {
  const field = answerFieldFor(task);
  const value = field === null ? undefined : answers[field];
  return field !== null && value !== undefined ? { field, value } : null;
}

export function warningSettledBy(field: AnswerField): string {
  return MISSING_WARNING[field];
}
