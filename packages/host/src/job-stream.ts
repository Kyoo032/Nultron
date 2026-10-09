import { ApiError, encodeSse } from "@agentforge/core";
import type { JobEmitter, JobErrorEvent, JobEvent } from "@agentforge/core/jobs";
import { redactSecrets } from "@agentforge/core";
import { admitRun, type RunTenant } from "./run-limits";
import type { HostStreamResult } from "./types";

const INTERNAL_ERROR: Omit<JobErrorEvent, "message"> = { type: "job.error", code: "internal_error", status: 500 };

export function jobErrorFromUnknown(error: unknown): JobErrorEvent {
  if (error instanceof ApiError) {
    return { type: "job.error", code: error.code, message: redactSecrets(error.message), status: error.status };
  }
  const message = error instanceof Error && error.message ? error.message : "Job failed";
  return { ...INTERNAL_ERROR, message: redactSecrets(message) };
}

type Waiter = () => void;

/** Jobs check this between phases so a cancelled client stops the work (and its cost) early. */
export function throwIfJobAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ApiError("aborted", "Job cancelled", 499);
  }
}

/**
 * Run a job and stream its progress as SSE. `run` pushes progress through
 * `emit` and receives the client's abort signal; its resolved value becomes
 * `job.done`, a throw becomes `job.error`. Events emitted after completion are dropped.
 *
 * `tenant` is whose job it is, and it is what the hosted per-tenant run cap counts (SR-138). A job
 * that names one takes a slot here, BEFORE `run` is called, and throws `too_many_runs` /
 * `server_busy` as an `ApiError` the handler turns into a JSON refusal; no stream exists yet. The
 * slot is given back exactly once, at whichever comes first: the job settles, the stream ends, or the
 * consumer stops reading. Every job route that reaches a model passes its tenant. Work that belongs to
 * the machine and not to a tenant (the component installer) names none and is never counted. Off
 * server mode `admitRun` is a no-op, so this costs a desk nothing.
 */
export function streamJob(
  run: (emit: JobEmitter, abortSignal: AbortSignal | undefined) => Promise<unknown>,
  options: { abortSignal?: AbortSignal; tenant?: RunTenant } = {},
): HostStreamResult {
  const release = options.tenant ? admitRun(options.tenant) : undefined;
  const queue: JobEvent[] = [];
  let finished = false;
  let wake: Waiter | null = null;

  const push = (event: JobEvent): void => {
    if (finished) {
      return;
    }
    queue.push(event);
    if (event.type === "job.done" || event.type === "job.error") {
      finished = true;
    }
    wake?.();
    wake = null;
  };

  const emit: JobEmitter = (event) => {
    if (event.type === "job.done" || event.type === "job.error") {
      return;
    }
    push(event);
  };

  let running: Promise<unknown>;
  try {
    running = run(emit, options.abortSignal);
  } catch (error) {
    // The job never started, so nothing else will give the slot back.
    release?.();
    throw error;
  }
  running.then(
    (result) => {
      release?.();
      push({ type: "job.done", result });
    },
    (error: unknown) => {
      release?.();
      push(jobErrorFromUnknown(error));
    },
  );

  async function* events(): AsyncIterable<string> {
    try {
      while (true) {
        if (queue.length === 0) {
          if (finished || options.abortSignal?.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            wake = () => {
              options.abortSignal?.removeEventListener("abort", onAbort);
              resolve();
            };
            options.abortSignal?.addEventListener("abort", onAbort, { once: true });
          });
          continue;
        }
        const next = queue.shift();
        if (next) {
          yield encodeSse(next);
        }
      }
    } finally {
      // The stream is over (finished, the client went away, or the consumer stopped reading).
      release?.();
    }
  }

  return { type: "stream", status: 200, events: events() };
}

/** Collect a job stream back into its parsed events (tests, in-process callers). */
export async function collectJobEvents(result: HostStreamResult): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const chunk of result.events) {
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine) {
      out.push(JSON.parse(dataLine.slice("data:".length).trim()) as JobEvent);
    }
  }
  return out;
}
