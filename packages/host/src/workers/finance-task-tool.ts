import { z } from "zod";
import { ApiError, defineTool, type AppLocale, type TenantContext } from "@agentforge/core";
import {
  CHAT_DOCUMENT_DESK_DIR,
  chatFinanceFiguresSchema,
  type ChatFinanceFigures,
} from "@agentforge/core/chat-documents";
import {
  FINANCE_TASKS,
  discountRateFromText,
  financeReportFromBrief,
  type FinanceReport,
  type FinanceTask,
} from "@agentforge/core/finance";
import { FileRootError, isFileRefusal, parseDeskPath, type DeskPath } from "@agentforge/core/tools/files";
import { FIGURES_SUFFIX } from "../chat-documents/desk-copy";
import { privateFolderFor } from "../desk-files/private-uploads";
import { deskFileStore } from "../desk-files/store";
import { generateFinanceBrief } from "../finance-generate";
import { runFinanceAuto, type FinanceAutoResult } from "../finance-tasks/auto";
import { localeForRun } from "../run-context";
import { factsOf, headlineOf, type FinanceHeadline } from "./finance-task-facts";
import {
  appliedAnswer,
  askFor,
  decide,
  typedNumberMatches,
  typedSegments,
  warningSettledBy,
  type FinanceAnswers,
  type FinanceAsk,
} from "./finance-task-asks";
import { currentWorkerChannel, runWithWorkerProgress } from "./worker-channel";

export const FINANCE_TASK_TOOL_KEY = "finance_task";

const SUMMARY_MAX = 1200;
const FILE_PATH_MAX = 512;
const PRIVATE_PATH_SEGMENTS = 3;

const schema = z.object({
  request: z
    .string()
    .trim()
    .min(8)
    .max(2000)
    .describe("The owner's question about their figures, in their words and the conversation's language."),
  file: z
    .string()
    .trim()
    .min(1)
    .max(FILE_PATH_MAX)
    .describe("The figures file's path, exactly as the host note [Figures kept: ...] gives it."),
  task: z
    .enum(FINANCE_TASKS)
    .optional()
    .describe("Only when the owner named or picked one: brief, ratios, budget, cashflow or appraisal."),
  answers: z
    .object({
      discountRatePercent: z.number().finite().optional(),
      openingCash: z.number().finite().optional(),
    })
    .strict()
    .optional()
    .describe("Only values the owner typed in this message, in answer to this tool's question."),
});

export type FinanceTaskWorkerArgs = z.infer<typeof schema>;

export type FinanceTaskNote = { readonly code: string; readonly message: string };

export type FinanceTaskWorkerResult =
  | {
      readonly ok: true;
      readonly artifact: { readonly id: string | null; readonly kind: "finance"; readonly title: string };
      readonly task: FinanceTask;
      readonly headline: readonly FinanceHeadline[];
      readonly summary: string;
      readonly facts: string;
      readonly checks: { readonly passed: boolean; readonly flagged: number; readonly removed: number };
      readonly notes: readonly FinanceTaskNote[];
    }
  | { readonly ok: false; readonly reason: "needs_input"; readonly ask: FinanceAsk }
  | { readonly ok: false; readonly reason: "failed" | "cancelled"; readonly code: string; readonly message: string };

const CANCELLED: FinanceTaskWorkerResult = {
  ok: false,
  reason: "cancelled",
  code: "cancelled",
  message: "The run was stopped before the figures were reviewed.",
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function needsInput(ask: FinanceAsk): FinanceTaskWorkerResult {
  return { ok: false, reason: "needs_input", ask };
}

function ownFolderPath(tenant: TenantContext, file: string): DeskPath | null {
  const parsed = parseDeskPath(file);
  if (isFileRefusal(parsed)) {
    return null;
  }
  const folder = `${CHAT_DOCUMENT_DESK_DIR}/${privateFolderFor(tenant.userId)}/`;
  const inside =
    parsed.startsWith(folder) && parsed.endsWith(FIGURES_SUFFIX) && parsed.split("/").length === PRIVATE_PATH_SEGMENTS;
  return inside ? parsed : null;
}

async function readOwnFigures(tenant: TenantContext, file: string): Promise<ChatFinanceFigures | null> {
  const path = ownFolderPath(tenant, file);
  if (path === null) {
    return null;
  }
  const store = deskFileStore();
  try {
    const newest = (await store.listVersions(tenant, path)).at(-1);
    if (newest?.authorKind !== "user" || newest.authorId !== tenant.userId) {
      return null;
    }
    const read = await store.readVersion(tenant, path, newest.version);
    const parsed = chatFinanceFiguresSchema.safeParse(JSON.parse(read.text));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof FileRootError || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function rateUntrusted(auto: FinanceAutoResult, figures: ChatFinanceFigures, typed: string): boolean {
  if (auto.task !== "appraisal" || auto.input === null) {
    return false;
  }
  const params = (auto.input.params ?? {}) as { discountRatePercent?: unknown };
  const used = params.discountRatePercent;
  if (typeof used !== "number" || auto.warnings.some((entry) => entry.code === "default_discount_rate")) {
    return false;
  }
  const fromFile = discountRateFromText(`${figures.figuresText}\n${figures.proseText}`);
  return fromFile !== used && !typedNumberMatches(used, typed);
}

function withAnswer(input: Record<string, unknown>, task: FinanceTask, answers: FinanceAnswers) {
  const applied = appliedAnswer(task, answers);
  if (!applied) {
    return { input, settled: null };
  }
  const params = (input.params ?? {}) as Record<string, unknown>;
  return {
    input: { ...input, params: { ...params, [applied.field]: applied.value } },
    settled: warningSettledBy(applied.field),
  };
}

function reportOf(
  result: Awaited<ReturnType<typeof generateFinanceBrief>>,
  locale: AppLocale,
): { report: FinanceReport; task: FinanceTask; warnings: readonly string[] } {
  if ("report" in result) {
    return { report: result.report, task: result.task, warnings: result.warnings ?? [] };
  }
  return {
    report: financeReportFromBrief(result.brief, { task: "brief", locale, guard: result.guard }),
    task: "brief",
    warnings: [],
  };
}

async function reviewFigures(
  args: FinanceTaskWorkerArgs,
  tenant: TenantContext,
  figures: ChatFinanceFigures,
  locale: AppLocale,
  typed: string,
): Promise<FinanceTaskWorkerResult> {
  const named = args.task ?? null;
  const answers: FinanceAnswers = args.answers ?? {};
  const auto = await runFinanceAuto(tenant, {
    figuresText: figures.figuresText,
    proseText: figures.proseText,
    sheetNames: figures.sheetNames,
    prompt: args.request,
    locale,
    ...(named ? { task: named } : {}),
  });
  const decision = decide({
    locale,
    namedTask: named,
    task: auto.task,
    confidence: auto.fits.confidence,
    ranked: auto.fits.ranked.map((entry) => entry.task),
    warningCodes: auto.warnings.map((entry) => entry.code),
    answers,
    typed,
    rateFromRequestOnly: rateUntrusted(auto, figures, typed),
    inputRead: auto.input !== null,
    readMessage: auto.warnings.map((entry) => entry.message).join(" ") || "The figures could not be read.",
  });
  if (decision?.kind === "ask") {
    return needsInput(decision.ask);
  }
  if (decision?.kind === "fail" || auto.input === null) {
    return {
      ok: false,
      reason: "failed",
      code: decision?.kind === "fail" ? decision.code : "figures_not_read",
      message: decision?.kind === "fail" ? decision.message : "The figures could not be read.",
    };
  }
  const { input, settled } = withAnswer(auto.input, auto.task, answers);
  const result = await runWithWorkerProgress(FINANCE_TASK_TOOL_KEY, (emit, signal) =>
    generateFinanceBrief(tenant, { ...input, task: auto.task, prompt: args.request, locale }, emit, signal),
  );
  const { report, task, warnings } = reportOf(result, locale);
  const flagged = result.guard.total;
  const removed = result.guard.removed ?? 0;
  return {
    ok: true,
    artifact: { id: result.artifactId, kind: "finance", title: report.title },
    task,
    headline: headlineOf(report),
    summary: clip(report.notes[0]?.body ?? "", SUMMARY_MAX),
    facts: factsOf(report),
    checks: { passed: flagged === 0 && removed === 0, flagged, removed },
    notes: [
      ...auto.warnings
        .filter((entry) => entry.code !== settled)
        .map((entry) => ({ code: entry.code, message: entry.message })),
      ...warnings.map((message) => ({ code: "run_warning", message })),
    ],
  };
}

export async function runFinanceTaskWorker(
  args: FinanceTaskWorkerArgs,
  tenant: TenantContext,
): Promise<FinanceTaskWorkerResult> {
  const channel = currentWorkerChannel();
  if (channel?.signal?.aborted) {
    return CANCELLED;
  }
  const locale = localeForRun();
  try {
    const figures = await readOwnFigures(tenant, args.file);
    if (!figures) {
      return needsInput(askFor("file", locale));
    }
    return await reviewFigures(args, tenant, figures, locale, typedSegments(channel?.userText));
  } catch (error) {
    if (channel?.signal?.aborted) {
      return CANCELLED;
    }
    const code = error instanceof ApiError ? error.code : "internal_error";
    const message = error instanceof Error ? error.message : "The figures could not be reviewed.";
    return { ok: false, reason: "failed", code, message };
  }
}

const DESCRIPTION = [
  "Review figures the owner attached: it reads the figures file, picks the finance task (brief, ratios, budget, cash flow or appraisal), computes every figure in code, writes a checked report and saves it.",
  "Call it when the host note [Figures kept: ...] names a file and the owner asks about those figures. Pass the owner's question as request and that path as file.",
  "It may answer needs_input with one question: put that question to the owner and do not answer it yourself. Pass task or answers only from what the owner said.",
  "The result is shown to the owner as a card. It returns a headline, a short summary, the computed facts and any check that failed; quote figures only from those.",
].join(" ");

export const financeTaskTool = defineTool({
  key: FINANCE_TASK_TOOL_KEY,
  name: "Finance task",
  description: DESCRIPTION,
  schema,
  trust: "user_content",
  execute: (args, tenant) => runFinanceTaskWorker(args, tenant),
});
