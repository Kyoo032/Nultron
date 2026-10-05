import { isServerMode, type EnvLike } from "@agentforge/core";
import { createLimiter, maxFromEnv, type Limiter, type Release } from "../concurrency";
import {
  HOSTED_MAX_RUNS,
  HOSTED_MAX_RUNS_PER_TENANT,
  MAX_CODE_RUNS_ENV,
  MAX_CODE_RUNS_PER_TENANT_ENV,
  PERSONAL_MAX_RUNS,
  QUEUE_WAIT_MS,
} from "./limits";

/**
 * How many code runs may be in flight.
 *
 * Unlike the other job limiters (concurrency.ts leaves a desk uncapped) this one caps Personal too: a
 * Python child with pandas holds hundreds of megabytes, and one owner does not need two at once. A run
 * that cannot get a slot within a short wait answers `busy` instead of queueing behind a 30 s job.
 *
 * Hosted adds a per-tenant cap on top of the global one, taken first so a tenant waiting for its own
 * slot never holds a global one.
 */

export type CodeLimiter = {
  /** A release function, or null when the wait ran out (the caller answers `busy`). */
  acquire(tenantId: string): Promise<Release | null>;
  /** Runs holding a slot right now. */
  active(): number;
};

export type CodeLimiterOptions = {
  readonly serverMode?: boolean;
  readonly maxRuns?: number;
  readonly maxPerTenant?: number;
  readonly queueWaitMs?: number;
  readonly env?: EnvLike;
};

async function tryAcquire(limiter: Limiter): Promise<Release | null> {
  try {
    return await limiter.acquire();
  } catch {
    // `too_many_jobs`: the waiting room is full or the wait timed out. Both mean busy.
    return null;
  }
}

export function createCodeLimiter(options: CodeLimiterOptions = {}): CodeLimiter {
  const env = options.env ?? process.env;
  const server = options.serverMode ?? isServerMode(env);
  const queueTimeoutMs = options.queueWaitMs ?? QUEUE_WAIT_MS;

  if (!server) {
    const personal = createLimiter("code", options.maxRuns ?? PERSONAL_MAX_RUNS, { queueTimeoutMs });
    return {
      acquire: () => tryAcquire(personal),
      active: () => personal.active(),
    };
  }

  const global = createLimiter("code", options.maxRuns ?? maxFromEnv(MAX_CODE_RUNS_ENV, HOSTED_MAX_RUNS, env), {
    queueTimeoutMs,
  });
  const perTenant = options.maxPerTenant ?? maxFromEnv(MAX_CODE_RUNS_PER_TENANT_ENV, HOSTED_MAX_RUNS_PER_TENANT, env);
  const tenants = new Map<string, Limiter>();

  const tenantLimiter = (tenantId: string): Limiter => {
    let limiter = tenants.get(tenantId);
    if (!limiter) {
      limiter = createLimiter("code-tenant", perTenant, { queueTimeoutMs });
      tenants.set(tenantId, limiter);
    }
    return limiter;
  };

  return {
    async acquire(tenantId) {
      const mine = tenantLimiter(tenantId);
      const tenantRelease = await tryAcquire(mine);
      const forget = (): void => {
        if (mine.active() === 0 && mine.queued() === 0 && tenants.get(tenantId) === mine) {
          tenants.delete(tenantId);
        }
      };
      if (!tenantRelease) {
        forget();
        return null;
      }
      const globalRelease = await tryAcquire(global);
      if (!globalRelease) {
        tenantRelease();
        forget();
        return null;
      }
      return () => {
        globalRelease();
        tenantRelease();
        forget();
      };
    },
    active: () => global.active(),
  };
}
