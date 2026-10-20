import { isFinanceTask, type FinanceTask } from "@agentforge/core/finance";
import { asRecord, readList, readNumber, readString } from "./results";

export const FINANCE_TASK_TOOL_KEY = "finance_task";

const HEADLINE_MAX = 4;

export type FinanceHeadlineFigure = {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
};

export type FinanceCardNote = {
  readonly code: string;
  readonly message: string;
};

export type FinanceCardModel = {
  readonly artifactId: string | null;
  readonly title: string;
  readonly task: FinanceTask;
  readonly headline: readonly FinanceHeadlineFigure[];
  readonly summary: string;
  readonly checksPassed: boolean;
  readonly flagged: number;
  readonly removed: number;
  readonly notes: readonly FinanceCardNote[];
};

function count(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.floor(value));
}

function headlineOf(entry: unknown): FinanceHeadlineFigure[] {
  const row = asRecord(entry);
  const label = readString(row, "label");
  const value = readString(row, "value");
  if (!label || !value) {
    return [];
  }
  const unit = readString(row, "unit");
  return [unit ? { label, value, unit } : { label, value }];
}

function noteOf(entry: unknown): FinanceCardNote[] {
  const row = asRecord(entry);
  const code = readString(row, "code");
  const message = readString(row, "message");
  return code && message ? [{ code, message }] : [];
}

export function readFinanceResult(_input: unknown, output: unknown): FinanceCardModel | null {
  const result = asRecord(output);
  if (result?.ok !== true || !isFinanceTask(result.task)) {
    return null;
  }
  const artifact = asRecord(result.artifact);
  const title = readString(artifact, "title");
  if (!artifact || !title) {
    return null;
  }
  const checks = asRecord(result.checks);
  const flagged = count(readNumber(checks, "flagged"));
  const removed = count(readNumber(checks, "removed"));
  return {
    artifactId: readString(artifact, "id") ?? null,
    title,
    task: result.task,
    headline: (readList(result, "headline") ?? []).flatMap(headlineOf).slice(0, HEADLINE_MAX),
    summary: readString(result, "summary") ?? "",
    checksPassed: checks?.passed === true && flagged === 0 && removed === 0,
    flagged,
    removed,
    notes: (readList(result, "notes") ?? []).flatMap(noteOf),
  };
}
