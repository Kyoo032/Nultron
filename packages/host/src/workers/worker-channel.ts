import { AsyncLocalStorage } from "node:async_hooks";
import type { JobEmitter, JobEvent } from "@agentforge/core/jobs";

/**
 * What a worker tool gets from the chat run it is called in: where its harness's progress goes, and
 * the run's own cancel. A tool's `execute` is only handed its arguments and the tenant, so the run
 * sets this around the model call and the worker reads it (`chat-workers-spec.md`, section 3).
 *
 * Outside a chat run there is no channel: progress is dropped and nothing cancels the worker.
 */
export type WorkerChannel = {
  /** One progress event of the harness the worker is running. Also tells the run it is still alive. */
  readonly emit: (toolKey: string, job: JobEvent) => void;
  readonly signal?: AbortSignal;
  readonly userText?: string;
};

const storage = new AsyncLocalStorage<WorkerChannel>();

export function withWorkerChannel<T>(channel: WorkerChannel, fn: () => Promise<T>): Promise<T> {
  return storage.run(channel, fn);
}

export function currentWorkerChannel(): WorkerChannel | undefined {
  return storage.getStore();
}

/** Shorter than the shortest idle budget a run has (60 s), with room for a slow event loop. */
export const WORKER_HEARTBEAT_MS = 20_000;

/**
 * The longest a worker's heartbeat keeps a run alive. After it the beat stops, the run's stall guard
 * sees silence, and the run ends an idle budget later: a worker that never returns cannot hold a
 * conversation open for good. Eight minutes is several times the longest dossier seen (about 70 s).
 */
export const WORKER_MAX_MS = 8 * 60_000;

/**
 * The model runtime has a stream watchdog of its own (`ai-sdk-runtime.ts`), fed only by the model's
 * stream. While a tool runs the model is silent by design, so that watchdog read a worker as a dead
 * stream and ended the run at its 60 s idle budget (seen live on 2026-10-09: a dossier cut off while
 * planning). A run that binds a worker hands the runtime this idle budget instead. Nothing is lost:
 * the run's own stall guard (`run-stall.ts`) keeps the model's budget, a stream that is truly wedged
 * sends it no events and no heartbeat, and it ends the run as before. It only has to outlast
 * `WORKER_MAX_MS`.
 */
export const WORKER_STREAM_IDLE_MS = WORKER_MAX_MS + 2 * 60_000;

/**
 * Run one worker with its progress wired to the chat run. A harness can sit inside one model call for
 * longer than the run's idle budget, so while it works the last progress event is sent again every
 * `WORKER_HEARTBEAT_MS`: the same label, which the screen already shows, and a sign of life for the
 * stall guards on both ends. The beat stops at `WORKER_MAX_MS`.
 */
export async function runWithWorkerProgress<T>(
  toolKey: string,
  work: (emit: JobEmitter, signal: AbortSignal | undefined) => Promise<T>,
  options: { readonly heartbeatMs?: number; readonly maxMs?: number } = {},
): Promise<T> {
  const channel = currentWorkerChannel();
  if (!channel) {
    return work(() => {}, undefined);
  }
  let last: JobEvent = { type: "job.phase", phase: "starting", label: "Starting" };
  const emit: JobEmitter = (job) => {
    if (job.type === "job.phase" || job.type === "job.step" || job.type === "job.round") {
      last = job;
    }
    channel.emit(toolKey, job);
  };
  const startedAt = Date.now();
  const maxMs = options.maxMs ?? WORKER_MAX_MS;
  const beat = setInterval(() => {
    if (Date.now() - startedAt >= maxMs) {
      clearInterval(beat);
      return;
    }
    channel.emit(toolKey, last);
  }, options.heartbeatMs ?? WORKER_HEARTBEAT_MS);
  try {
    return await work(emit, channel.signal);
  } finally {
    clearInterval(beat);
  }
}
