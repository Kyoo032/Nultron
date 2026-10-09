import {
  isGatewayUnavailableFailure,
  modelFallbackNotice,
  nextJobFallbackModel,
  resetLearnedEffortLimits,
  type JobMode,
  type JobModelFallbackNotice,
} from "@agentforge/core";
import type { ModelCacheScope } from "./model-cache";
import { listSelectableModels } from "./selectable-models";

/**
 * A job must not die because the model its mode defaults to is down. When the gateway cannot be
 * reached at all — a 503, a refused socket, no response headers, no first token — the same prompt
 * is retried once on the next model of that mode's ranked list that the workspace actually lists.
 *
 * Only the model id changes. The endpoint, the key and the request body are the ones
 * `createRuntime(loadSettings(...))` already built, so a fallback can never move a financial prompt
 * to a second gateway.
 */

/**
 * How long a model that could not be reached is skipped before the first attempt. Mirrors the
 * embedding breaker in `knowledge-embed.ts`: without it every job in a row pays the three contact
 * tries (~30 s on the live eval run) before it discovers the same outage again.
 */
export const JOB_MODEL_DOWN_MS = 5 * 60 * 1000;

const downUntil = new Map<string, number>();

/**
 * One entry per company and model. A process serves many companies on the hosted server, and one
 * company's outage (a bad key, a quota, its own endpoint) must not make another company skip a model that
 * works for it. A desk, which has one owner, passes no scope and has its own entry.
 */
function circuitKey(model: string, scope?: ModelCacheScope): string {
  const id = model.trim().toLowerCase();
  if (!id) {
    return "";
  }
  const owner = scope ? `${scope.tenantId}/${scope.organizationId ?? ""}` : "";
  return `${owner}|${id}`;
}

export function markJobModelDown(model: string, now: number = Date.now(), scope?: ModelCacheScope): void {
  const key = circuitKey(model, scope);
  if (key) {
    downUntil.set(key, now + JOB_MODEL_DOWN_MS);
  }
}

export function isJobModelDown(model: string, now: number = Date.now(), scope?: ModelCacheScope): boolean {
  const key = circuitKey(model, scope);
  if (!key) {
    return false;
  }
  const until = downUntil.get(key);
  if (until === undefined) {
    return false;
  }
  if (now >= until) {
    downUntil.delete(key);
    return false;
  }
  return true;
}

/** Test hook for the down circuit alone. Production code calls `resetModelReliabilityState`. */
export function resetJobModelCircuit(): void {
  downUntil.clear();
}

/**
 * Everything this process has learned about which models misbehave, forgotten: the models a job
 * skips because they were unreachable, and the Thinking levels the runtime learned a model refuses
 * (`resetLearnedEffortLimits`, core). Saving Settings, forgetting the key and resetting a tenant
 * call this, because a new key or endpoint may sit in front of a different upstream and none of it
 * is known to hold there.
 */
export function resetModelReliabilityState(): void {
  resetJobModelCircuit();
  resetLearnedEffortLimits();
}

/** One attempt's outcome. The original error is carried, never wrapped: its ApiError status matters. */
export type JobModelOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: unknown;
      /** True once the model had started answering. A half-written answer is never re-run elsewhere. */
      streamed: boolean;
    };

export type JobModelRun<T> = {
  value: T;
  /** The model that produced `value` — the stand-in when the first choice could not be reached. */
  model: string;
  /** Set only when `model` is not the one the request asked for. */
  notice?: JobModelFallbackNotice;
};

export type JobModelFallbackOptions = {
  model: string;
  jobMode?: JobMode;
  /**
   * The person pinned this model in the UI for this request. Then a failure is the answer: a job
   * that quietly ran somewhere else would make the picker a lie.
   */
  modelExplicit?: boolean;
  /** Chat ids this workspace lists. Defaults to the live selectable catalog. */
  availableModelIds?: string[];
  /** Whose catalogue that default is. Every job call carries its tenant; only the hosted server reads it. */
  tenant?: ModelCacheScope;
  /**
   * The job's cancel. Once it has fired a failure is the caller's answer, not the model's: nothing is
   * retried on a stand-in and the model is not marked down for it.
   */
  signal?: AbortSignal;
  now?: () => number;
};

export function jobFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "";
}

function availableIds(options: JobModelFallbackOptions): string[] {
  return options.availableModelIds ?? listSelectableModels(options.tenant).map((model) => model.id);
}

export function pickNext(options: JobModelFallbackOptions, current: string, now: number): string | undefined {
  if (options.modelExplicit === true) {
    return undefined;
  }
  return nextJobFallbackModel({
    ...(options.jobMode ? { mode: options.jobMode } : {}),
    current,
    availableIds: availableIds(options),
    isDown: (id) => isJobModelDown(id, now, options.tenant),
  });
}

/** A model the circuit already saw fail is skipped before the first attempt, not after it. */
export function startModel(options: JobModelFallbackOptions, now: number): string {
  if (!isJobModelDown(options.model, now, options.tenant)) {
    return options.model;
  }
  return pickNext(options, options.model, now) ?? options.model;
}

export function maySwapModel(
  failure: { error: unknown; streamed: boolean },
  options: JobModelFallbackOptions,
): boolean {
  if (options.modelExplicit === true || failure.streamed || options.signal?.aborted === true) {
    return false;
  }
  return isGatewayUnavailableFailure(jobFailureMessage(failure.error));
}

function finish<T>(requested: string, used: string, value: T): JobModelRun<T> {
  if (used.trim().toLowerCase() === requested.trim().toLowerCase()) {
    return { value, model: used };
  }
  return { value, model: used, notice: modelFallbackNotice(requested, used) };
}

/**
 * Run `attempt`, and on a gateway-unavailable failure run it once more on the next healthy model.
 * Anything else — a rejected prompt, a bad key, a half-streamed answer — is rethrown untouched.
 */
export async function runWithJobModelFallback<T>(
  options: JobModelFallbackOptions,
  attempt: (model: string) => Promise<JobModelOutcome<T>>,
): Promise<JobModelRun<T>> {
  const now = options.now ?? Date.now;
  const first = startModel(options, now());
  const outcome = await attempt(first);
  if (outcome.ok) {
    return finish(options.model, first, outcome.value);
  }
  if (!maySwapModel(outcome, options)) {
    throw outcome.error;
  }
  markJobModelDown(first, now(), options.tenant);
  const next = pickNext(options, first, now());
  if (!next) {
    throw outcome.error;
  }
  const retry = await attempt(next);
  if (!retry.ok) {
    if (maySwapModel(retry, options)) {
      markJobModelDown(next, now(), options.tenant);
    }
    throw retry.error;
  }
  return finish(options.model, next, retry.value);
}
