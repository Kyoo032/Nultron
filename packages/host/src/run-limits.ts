/**
 * How many model runs one tenant, and the whole server, may have in flight (SR-138).
 *
 * Nothing else bounds a signed-in account: the request limiters count requests, not runs
 * (`./rate-limit.ts`), and the job pools in `./concurrency.ts` are global and only guard ffmpeg and SQL
 * workers. One account could open a hundred Chat streams at once and take the box. This is the missing
 * counter: a slot is taken when a run is admitted and given back exactly once when its stream ends.
 *
 * Refusals come before any stream starts, in the host's ordinary error shape:
 *   - over the tenant's cap  -> 429 `too_many_runs`;
 *   - over the server's cap  -> 503 `server_busy`.
 * The tenant cap is checked first, so an account that is the reason the server is full is told so.
 * A cap of ZERO refuses every run with `server_busy`: it is the operator's "stop" for an incident, and
 * it is never read as "no limit" (that takes the word `off`, `none` or `unlimited`).
 *
 * Where it applies: the hosted server only. A desk is one owner on their own machine and webdev is the
 * same, so off server mode `admitRun` hands back a no-op and counts nothing, whatever the variables say
 * (the same rule `./concurrency.ts` states for its pools).
 *
 * What it is not: the counters live in this process's memory. A restart empties them and a second
 * process would keep its own, so it does not hold across two app containers. It protects one box
 * from one account; it is not a billing control and says nothing about spend.
 */
import { ApiError, isServerMode, type EnvLike, type TenantContext } from "@agentforge/core";
import type { Release } from "./concurrency";

export const TOO_MANY_RUNS = "too_many_runs";
export const SERVER_BUSY = "server_busy";

const TOO_MANY_RUNS_STATUS = 429;
const SERVER_BUSY_STATUS = 503;

export const MAX_RUNS_PER_TENANT_ENV = "AGENTFORGE_MAX_RUNS_PER_TENANT";
export const MAX_RUNS_TOTAL_ENV = "AGENTFORGE_MAX_RUNS_TOTAL";
/** Six runs at once is a busy afternoon for one company and nowhere near a flood. */
export const DEFAULT_MAX_RUNS_PER_TENANT = 6;

/** A cap (0 refuses every run), or `null` when that cap is off. */
export type RunCaps = {
  readonly perTenant: number | null;
  readonly total: number | null;
};

const OFF_WORDS: ReadonlySet<string> = new Set(["off", "none", "unlimited"]);
const CAP_NUMBER = /^(0|[1-9]\d*)$/;

/**
 * One cap variable: a whole number sets it, `off` / `none` / `unlimited` switch it off, and anything
 * else is the default. `0` is a cap of zero (every run refused), not an off switch: removing a limit
 * takes a word, so it is always something somebody typed on purpose, and a typo falls back to the
 * default.
 */
export function parseRunCap(raw: string | undefined, fallback: number | null): number | null {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (OFF_WORDS.has(value)) {
    return null;
  }
  if (!CAP_NUMBER.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

const NO_CAPS: RunCaps = { perTenant: null, total: null };

/** The caps for this process. Off server mode there are none, whatever the variables say. */
export function runCapsFromEnv(env: EnvLike = process.env): RunCaps {
  if (!isServerMode(env)) {
    return NO_CAPS;
  }
  return {
    perTenant: parseRunCap(env[MAX_RUNS_PER_TENANT_ENV], DEFAULT_MAX_RUNS_PER_TENANT),
    total: parseRunCap(env[MAX_RUNS_TOTAL_ENV], null),
  };
}

export type RunLimiter = {
  /** A release function for the new slot. Throws `too_many_runs` / `server_busy` and takes nothing. */
  admit(key: string, caps: RunCaps): Release;
  /** Runs in flight for `key`, or on the whole server when no key is given. */
  active(key?: string): number;
  /** How many keys currently hold a slot. Zero when idle: an idle tenant is not remembered. */
  trackedTenants(): number;
};

function tooManyRuns(cap: number): ApiError {
  return new ApiError(
    TOO_MANY_RUNS,
    `Your account already has ${cap} runs in progress. Wait for one to finish, then try again.`,
    TOO_MANY_RUNS_STATUS,
  );
}

function serverBusy(): ApiError {
  return new ApiError(SERVER_BUSY, "The server is busy right now. Try again in a moment.", SERVER_BUSY_STATUS);
}

/**
 * Counters only. The caps arrive with each call, so a changed variable applies to the next run
 * without rebuilding anything, and a limiter built for a test has no environment in it.
 */
export function createRunLimiter(): RunLimiter {
  const perKey = new Map<string, number>();
  let total = 0;

  return {
    admit(key, caps) {
      // A cap of zero is the operator's "stop": nothing is admitted, and it reads as the server being
      // unavailable, not as this account having too many runs.
      if (caps.perTenant === 0 || caps.total === 0) {
        throw serverBusy();
      }
      const mine = perKey.get(key) ?? 0;
      if (caps.perTenant !== null && mine >= caps.perTenant) {
        throw tooManyRuns(caps.perTenant);
      }
      if (caps.total !== null && total >= caps.total) {
        throw serverBusy();
      }
      perKey.set(key, mine + 1);
      total += 1;

      // One slot, one release. A second call must not hand out a slot that was never freed, and it
      // must not free one that belongs to somebody else's run.
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const left = (perKey.get(key) ?? 1) - 1;
        if (left > 0) {
          perKey.set(key, left);
        } else {
          perKey.delete(key);
        }
        total = Math.max(0, total - 1);
      };
    },
    active: (key) => (key === undefined ? total : (perKey.get(key) ?? 0)),
    trackedTenants: () => perKey.size,
  };
}

/** What the limiter needs to know about whose run this is. */
export type RunTenant = Pick<TenantContext, "tenantId" | "organizationId">;

/**
 * The unit a cap counts: the company (organisation) inside its white-label partner.
 *
 * `TenantContext.tenantId` is the partner every company of a deployment sits under, so keying on it
 * alone would make all customers of one deployment share a single cap. The organisation is the
 * account a person signs in to; the pair keeps two partners' ids from ever meeting. To count per
 * person instead, change this one function.
 */
export function runLimitKey(tenant: RunTenant): string {
  return JSON.stringify([tenant.tenantId, tenant.organizationId]);
}

const processLimiter = createRunLimiter();

const noopRelease: Release = () => undefined;

/**
 * Takes a slot for one run, or refuses. The slot is the caller's to release (once; further calls are
 * ignored), normally by handing the release to `guardRunStream` or `streamJob`.
 */
export function admitRun(tenant: RunTenant, env: EnvLike = process.env): Release {
  if (!isServerMode(env)) {
    return noopRelease;
  }
  return processLimiter.admit(runLimitKey(tenant), runCapsFromEnv(env));
}

/**
 * Runs `work` under one slot for `tenant`: admitted first (a refusal never calls `work`), released in a
 * `finally` whether it returns, rejects or throws before returning a promise. This is the wrapper for a
 * handler that answers when the work is done; a handler that answers with a stream hands the release to
 * `guardRunStream` or `streamJob` instead.
 */
export async function withRunSlot<T>(
  tenant: RunTenant,
  work: () => Promise<T> | T,
  env: EnvLike = process.env,
): Promise<T> {
  const release = admitRun(tenant, env);
  try {
    return await work();
  } finally {
    release();
  }
}

/** Runs in flight in this process for `tenant`, or in total. Diagnostics and tests. */
export function activeRuns(tenant?: RunTenant): number {
  return processLimiter.active(tenant ? runLimitKey(tenant) : undefined);
}

/**
 * The same frames, with the slot given back when the stream ends however it ends: it completes, it
 * throws (before the first frame too), or the consumer walks away - a closed connection, a `break`, an
 * abandoned `return()`. Written by hand rather than as a generator because a generator that is
 * returned before its first `next()` never runs its `finally`, and that is exactly the case a slot
 * would leak in.
 */
export function guardRunStream(release: Release, events: AsyncIterable<string>): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let iterator: AsyncIterator<string>;
      try {
        iterator = events[Symbol.asyncIterator]();
      } catch (error) {
        release();
        throw error;
      }
      return {
        async next() {
          try {
            const step = await iterator.next();
            if (step.done) {
              release();
            }
            return step;
          } catch (error) {
            release();
            throw error;
          }
        },
        async return(value?: unknown) {
          try {
            return iterator.return ? await iterator.return(value) : { done: true as const, value: undefined };
          } finally {
            release();
          }
        },
        async throw(error?: unknown) {
          try {
            if (iterator.throw) {
              return await iterator.throw(error);
            }
            throw error;
          } finally {
            release();
          }
        },
      };
    },
  };
}
