/**
 * What a finished stream tells the harness, folded from its events with no I/O.
 *
 * Two streams exist. A Chat run speaks `RuntimeEvent`s (`packages/core/src/runtime/types.ts`), tool
 * calls included. A job (Data, Research) speaks `JobEvent`s (`packages/core/src/jobs/job-events.ts`),
 * and its tool calls never reach the stream: Data announces each `run_sql` as a `job.step` in the
 * `analyzing` phase, and Research's web searches are `job.step`s in `searching`. Those are read as the
 * tool calls they are, and the row says which kind of evidence it holds (`ToolCallSource`).
 */
import type { StreamEvent } from "./sse";

export type ToolCallSource = "tool.started" | "job.step" | "none";

export type Observation = {
  eventCounts: Readonly<Record<string, number>>;
  malformedFrames: number;
  text: string;
  /** `tool.started` keys, in the order the model asked for them. */
  toolCalls: readonly string[];
  /** Keys of `tool.completed` events whose output says `success: false`. */
  toolFailures: readonly string[];
  /** The `run.failed` message, else the `job.error` message. */
  failure: string | null;
  runCompleted: boolean;
  jobDone: boolean;
  jobResult: unknown;
  usage: { model: string; inputTokens: number; outputTokens: number } | null;
  /** `run.probing` frames: one per contact attempt, so more than one means the gateway needed a retry. */
  contactAttempts: number;
  jobSteps: ReadonlyArray<{ phase: string; label: string; detail: string }>;
  sources: { found: number; read: number; unreachable: number };
};

export const EMPTY_OBSERVATION: Observation = {
  eventCounts: {},
  malformedFrames: 0,
  text: "",
  toolCalls: [],
  toolFailures: [],
  failure: null,
  runCompleted: false,
  jobDone: false,
  jobResult: null,
  usage: null,
  contactAttempts: 0,
  jobSteps: [],
  sources: { found: 0, read: 0, unreachable: 0 },
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(value: unknown): Observation["usage"] {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return { model: str(record.model), inputTokens: num(record.inputTokens), outputTokens: num(record.outputTokens) };
}

function outputFailed(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && (output as { success?: unknown }).success === false);
}

/** Fold one event into the observation; returns a new one. */
export function observe(previous: Observation, event: StreamEvent): Observation {
  const counted = {
    ...previous,
    eventCounts: { ...previous.eventCounts, [event.type]: (previous.eventCounts[event.type] ?? 0) + 1 },
  };
  switch (event.type) {
    case "assistant.delta":
      return { ...counted, text: counted.text + str(event.text) };
    case "run.probing":
      return { ...counted, contactAttempts: counted.contactAttempts + 1 };
    case "tool.started":
      return { ...counted, toolCalls: [...counted.toolCalls, str(event.toolKey)] };
    case "tool.completed":
      return outputFailed(event.output)
        ? { ...counted, toolFailures: [...counted.toolFailures, str(event.toolKey)] }
        : counted;
    case "run.failed":
      return { ...counted, failure: str(event.message) || "run.failed" };
    case "run.completed":
      return { ...counted, runCompleted: true, usage: usageOf(event.usage) ?? counted.usage };
    case "job.step":
      return {
        ...counted,
        jobSteps: [
          ...counted.jobSteps,
          { phase: str(event.phase), label: str(event.label), detail: str(event.detail) },
        ],
      };
    case "job.source": {
      const status = str(event.status);
      if (status !== "found" && status !== "read" && status !== "unreachable") {
        return counted;
      }
      return { ...counted, sources: { ...counted.sources, [status]: counted.sources[status] + 1 } };
    }
    case "job.done":
      return { ...counted, jobDone: true, jobResult: event.result ?? null };
    case "job.error":
      return { ...counted, failure: str(event.message) || str(event.code) || "job.error" };
    default:
      return counted;
  }
}

export function observeAll(events: readonly StreamEvent[], malformed = 0): Observation {
  return events.reduce(observe, { ...EMPTY_OBSERVATION, malformedFrames: malformed });
}

export function totalEvents(observation: Observation): number {
  return Object.values(observation.eventCounts).reduce((total, count) => total + count, 0);
}

/** The tool a job `phase` stands for, when its steps are tool calls. */
export type JobToolMap = Readonly<Record<string, string>>;

/** A job's tool calls, read from its steps in order. Unmapped phases are not tool calls. */
export function jobToolCalls(steps: Observation["jobSteps"], map: JobToolMap): string[] {
  return steps.flatMap((step) => {
    const key = map[step.phase];
    return key ? [key] : [];
  });
}

/** How a chat run or a job ended, as the row records it. */
export type Ending = { completed: boolean; error: string | null };

export function runEnding(observation: Observation): Ending {
  if (observation.failure) {
    return { completed: false, error: observation.failure };
  }
  return observation.runCompleted
    ? { completed: true, error: null }
    : { completed: false, error: "stream ended without run.completed" };
}

export function jobEnding(observation: Observation): Ending {
  if (observation.failure) {
    return { completed: false, error: observation.failure };
  }
  return observation.jobDone
    ? { completed: true, error: null }
    : { completed: false, error: "stream ended without job.done" };
}

const EVIDENCE_FAILED = /\(Evidence query failed: ([^)]*)\)/;

/**
 * The only checks the API reports today are Data's: its `verifying` phase re-runs each finding's
 * evidence query, and a query that fails leaves `(Evidence query failed: <reason>)` in the finding
 * (`packages/host/src/data-analysis-build.ts`). Failed `run_sql` steps are reported too.
 */
export function dataCheckFailures(result: unknown, steps: Observation["jobSteps"]): string[] {
  const findings =
    result &&
    typeof result === "object" &&
    Array.isArray((result as { analysis?: { findings?: unknown } }).analysis?.findings)
      ? ((result as { analysis: { findings: unknown[] } }).analysis.findings as Array<{
          heading?: unknown;
          body?: unknown;
        }>)
      : [];
  const evidence = findings.flatMap((finding) => {
    const match = EVIDENCE_FAILED.exec(str(finding.body));
    return match ? [`evidence query failed: ${str(finding.heading)}: ${match[1]}`] : [];
  });
  const sql = steps
    .filter((step) => step.phase === "analyzing" && step.detail.startsWith("failed:"))
    .map((step) => `run_sql ${step.detail}`);
  return [...evidence, ...sql];
}
