import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import {
  activeRuns,
  admitRun,
  createRunLimiter,
  DEFAULT_MAX_RUNS_PER_TENANT,
  guardRunStream,
  MAX_RUNS_PER_TENANT_ENV,
  MAX_RUNS_TOTAL_ENV,
  parseRunCap,
  runCapsFromEnv,
  runLimitKey,
  SERVER_BUSY,
  TOO_MANY_RUNS,
  withRunSlot,
  type RunCaps,
} from "./run-limits";

const SERVER = { AGENTFORGE_SERVER: "1" } as const;

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/** Everything a test admits is released by the end of it, so no case leaks a slot into the next. */
const taken: Array<() => void> = [];
afterEach(() => {
  while (taken.length > 0) {
    taken.pop()?.();
  }
});
function keep(release: () => void): () => void {
  taken.push(release);
  return release;
}

describe("parseRunCap", () => {
  it("reads a positive integer as the cap, trimmed", () => {
    expect(parseRunCap("6", null)).toBe(6);
    expect(parseRunCap("  12 ", null)).toBe(12);
    expect(parseRunCap("1", 6)).toBe(1);
  });

  it.each(["off", "none", "unlimited", "OFF", " None ", "Unlimited"])("turns the cap off for the word %j", (raw) => {
    expect(parseRunCap(raw, 6)).toBeNull();
  });

  it("reads 0 as a cap of zero, which refuses every run, and never as an off switch", () => {
    // An operator who sets 0 during an incident means "stop". Reading it as "no limit" would do the opposite.
    expect(parseRunCap("0", 6)).toBe(0);
    expect(parseRunCap(" 0 ", null)).toBe(0);
  });

  it.each([
    undefined,
    "",
    "   ",
    "abc",
    "-3",
    "2.5",
    "1e3",
    "00",
    "0x10",
    "NaN",
    "Infinity",
    "99999999999999999999",
    "6 runs",
  ])("falls back to the default for %j, so a typo never changes the limit", (raw) => {
    expect(parseRunCap(raw, 6)).toBe(6);
    expect(parseRunCap(raw, null)).toBeNull();
  });
});

describe("runCapsFromEnv", () => {
  it("defaults to six runs per tenant and no whole-server cap on the hosted server", () => {
    expect(DEFAULT_MAX_RUNS_PER_TENANT).toBe(6);
    expect(runCapsFromEnv(SERVER)).toEqual({ perTenant: 6, total: null });
  });

  it("reads both variables", () => {
    expect(runCapsFromEnv({ ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "2", [MAX_RUNS_TOTAL_ENV]: "40" })).toEqual({
      perTenant: 2,
      total: 40,
    });
  });

  it("switches each cap off on its own with an off word", () => {
    expect(runCapsFromEnv({ ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "unlimited", [MAX_RUNS_TOTAL_ENV]: "5" })).toEqual({
      perTenant: null,
      total: 5,
    });
    expect(runCapsFromEnv({ ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "none", [MAX_RUNS_TOTAL_ENV]: "off" })).toEqual({
      perTenant: null,
      total: null,
    });
  });

  it("does not switch a cap off with 0: it is a cap of zero", () => {
    expect(runCapsFromEnv({ ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "0", [MAX_RUNS_TOTAL_ENV]: "0" })).toEqual({
      perTenant: 0,
      total: 0,
    });
  });

  it("falls back to each variable's own default on junk", () => {
    expect(runCapsFromEnv({ ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "lots", [MAX_RUNS_TOTAL_ENV]: "many" })).toEqual({
      perTenant: 6,
      total: null,
    });
  });

  it("is no cap at all off server mode, whatever the environment says", () => {
    const set = { [MAX_RUNS_PER_TENANT_ENV]: "1", [MAX_RUNS_TOTAL_ENV]: "1" };
    for (const env of [set, { ...set, AGENTFORGE_SERVER: "0" }, { ...set, AGENTFORGE_SERVER: "false" }, {}]) {
      expect(runCapsFromEnv(env), JSON.stringify(env)).toEqual({ perTenant: null, total: null });
    }
  });
});

describe("createRunLimiter", () => {
  const caps = (perTenant: number | null, total: number | null = null): RunCaps => ({ perTenant, total });

  it("admits up to the tenant cap and then refuses with 429 too_many_runs", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(2)));
    keep(limiter.admit("a", caps(2)));
    const error = refusal(() => limiter.admit("a", caps(2)));
    expect(error.code).toBe(TOO_MANY_RUNS);
    expect(error.status).toBe(429);
    expect(error.message.length).toBeGreaterThan(0);
    expect(limiter.active("a")).toBe(2);
  });

  it("keeps tenants apart: A at its cap does not block B", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(1)));
    expect(refusal(() => limiter.admit("a", caps(1))).code).toBe(TOO_MANY_RUNS);
    const b = keep(limiter.admit("b", caps(1)));
    expect(limiter.active("a")).toBe(1);
    expect(limiter.active("b")).toBe(1);
    b();
    expect(limiter.active("a")).toBe(1);
    expect(limiter.active("b")).toBe(0);
  });

  it("refuses with 503 server_busy once the whole server is at its cap, for any tenant", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(null, 3)));
    keep(limiter.admit("b", caps(null, 3)));
    keep(limiter.admit("c", caps(null, 3)));
    for (const key of ["a", "d"]) {
      const error = refusal(() => limiter.admit(key, caps(null, 3)));
      expect(error.code).toBe(SERVER_BUSY);
      expect(error.status).toBe(503);
    }
    expect(limiter.active()).toBe(3);
  });

  it("tells a tenant over its own cap that it is over its own cap, even when the server is full too", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(1, 1)));
    expect(refusal(() => limiter.admit("a", caps(1, 1))).code).toBe(TOO_MANY_RUNS);
    expect(refusal(() => limiter.admit("b", caps(1, 1))).code).toBe(SERVER_BUSY);
  });

  it("takes no slot for a refusal", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(1, 5)));
    refusal(() => limiter.admit("a", caps(1, 5)));
    expect(limiter.active("a")).toBe(1);
    expect(limiter.active()).toBe(1);
  });

  it("gives the slot back on release, and the next run is admitted", () => {
    const limiter = createRunLimiter();
    const first = limiter.admit("a", caps(1));
    expect(refusal(() => limiter.admit("a", caps(1))).code).toBe(TOO_MANY_RUNS);
    first();
    keep(limiter.admit("a", caps(1)));
    expect(limiter.active("a")).toBe(1);
  });

  it("releases exactly once: a second call neither goes negative nor frees someone else's slot", () => {
    const limiter = createRunLimiter();
    const first = limiter.admit("a", caps(2, 3));
    keep(limiter.admit("a", caps(2, 3)));
    keep(limiter.admit("b", caps(2, 3)));
    first();
    first();
    first();
    // One slot came back, not three: the tenant has one running and one free, not two free.
    expect(limiter.active("a")).toBe(1);
    expect(limiter.active()).toBe(2);
    keep(limiter.admit("a", caps(2, 3)));
    expect(refusal(() => limiter.admit("a", caps(2, 3))).code).toBe(TOO_MANY_RUNS);
    // And tenant B's run was never counted against A's release.
    expect(limiter.active("b")).toBe(1);
  });

  it("never reports a negative count, and the cap still holds after a release storm", () => {
    const limiter = createRunLimiter();
    const releases = [limiter.admit("a", caps(2)), limiter.admit("a", caps(2))];
    for (const release of releases) {
      release();
      release();
    }
    expect(limiter.active("a")).toBe(0);
    expect(limiter.active()).toBe(0);
    keep(limiter.admit("a", caps(2)));
    keep(limiter.admit("a", caps(2)));
    expect(refusal(() => limiter.admit("a", caps(2))).code).toBe(TOO_MANY_RUNS);
  });

  it("forgets a tenant with nothing running, so a stream of one-off tenants cannot grow the map", () => {
    const limiter = createRunLimiter();
    for (let i = 0; i < 1000; i += 1) {
      limiter.admit(`tenant-${i}`, caps(1))();
    }
    expect(limiter.trackedTenants()).toBe(0);
    expect(limiter.active()).toBe(0);
  });

  it("applies the caps it is handed on every call, so a changed variable takes effect without a restart", () => {
    const limiter = createRunLimiter();
    keep(limiter.admit("a", caps(3)));
    keep(limiter.admit("a", caps(3)));
    expect(refusal(() => limiter.admit("a", caps(2))).code).toBe(TOO_MANY_RUNS);
    keep(limiter.admit("a", caps(null)));
    expect(limiter.active("a")).toBe(3);
  });

  it("refuses every run with 503 server_busy when a cap is zero, whoever asks and whatever is running", () => {
    const limiter = createRunLimiter();
    for (const zero of [caps(0), caps(null, 0), caps(0, 0), caps(3, 0), caps(0, 3)]) {
      for (const key of ["a", "b"]) {
        const error = refusal(() => limiter.admit(key, zero));
        expect(error, JSON.stringify(zero)).toMatchObject({ code: SERVER_BUSY, status: 503 });
      }
    }
    expect(limiter.active()).toBe(0);
  });

  it("counts but never refuses when both caps are off", () => {
    const limiter = createRunLimiter();
    for (let i = 0; i < 50; i += 1) {
      keep(limiter.admit("a", caps(null, null)));
    }
    expect(limiter.active("a")).toBe(50);
  });
});

describe("admitRun", () => {
  const tenant = (organizationId: string, tenantId = "partner", userId = "u1") => ({
    tenantId,
    organizationId,
    userId,
  });

  it("caps the hosted server per tenant from the environment", () => {
    const env = { ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "2" };
    keep(admitRun(tenant("org-a"), env));
    keep(admitRun(tenant("org-a"), env));
    const error = refusal(() => admitRun(tenant("org-a"), env));
    expect(error).toMatchObject({ code: TOO_MANY_RUNS, status: 429 });
    keep(admitRun(tenant("org-b"), env));
  });

  it("applies the whole-server cap from the environment", () => {
    const env = { ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "off", [MAX_RUNS_TOTAL_ENV]: "2" };
    keep(admitRun(tenant("org-a"), env));
    keep(admitRun(tenant("org-b"), env));
    expect(refusal(() => admitRun(tenant("org-c"), env))).toMatchObject({ code: SERVER_BUSY, status: 503 });
  });

  it("is no cap and no count off server mode, whatever the variables say (Personal parity)", () => {
    const env = { [MAX_RUNS_PER_TENANT_ENV]: "1", [MAX_RUNS_TOTAL_ENV]: "1" };
    const releases = Array.from({ length: 20 }, () => admitRun(tenant("local-org", "local-tenant"), env));
    // 0 is a cap of zero on the hosted server, and still nothing at all off it.
    releases.push(admitRun(tenant("local-org", "local-tenant"), { ...env, [MAX_RUNS_PER_TENANT_ENV]: "0" }));
    expect(activeRuns()).toBe(0);
    for (const release of releases) {
      release();
      release();
    }
    expect(activeRuns()).toBe(0);
  });

  it("keys on the company, not on the white-label partner every company of a deployment shares", () => {
    expect(runLimitKey(tenant("org-a", "partner"))).not.toBe(runLimitKey(tenant("org-b", "partner")));
    expect(runLimitKey(tenant("org-a", "partner", "u1"))).toBe(runLimitKey(tenant("org-a", "partner", "u2")));
    expect(runLimitKey(tenant("org-a", "partner-1"))).not.toBe(runLimitKey(tenant("org-a", "partner-2")));

    const env = { ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "1" };
    keep(admitRun(tenant("org-a", "partner"), env));
    keep(admitRun(tenant("org-b", "partner"), env));
    expect(refusal(() => admitRun(tenant("org-a", "partner", "someone-else"), env)).code).toBe(TOO_MANY_RUNS);
  });

  it("holds a slot until released and counts it", () => {
    const env = { ...SERVER };
    const release = admitRun(tenant("org-count"), env);
    expect(activeRuns(tenant("org-count"))).toBe(1);
    release();
    expect(activeRuns(tenant("org-count"))).toBe(0);
  });
});

describe("guardRunStream", () => {
  async function* frames(...items: string[]): AsyncGenerator<string> {
    for (const item of items) {
      yield item;
    }
  }

  function counting() {
    let calls = 0;
    const release = () => {
      calls += 1;
    };
    return { release, calls: () => calls };
  }

  it("passes every frame through in order and holds the slot until the stream is done", async () => {
    const slot = counting();
    const seen: string[] = [];
    for await (const frame of guardRunStream(slot.release, frames("a", "b", "c"))) {
      seen.push(frame);
      expect(slot.calls(), "released while frames were still coming").toBe(0);
    }
    expect(seen).toEqual(["a", "b", "c"]);
    expect(slot.calls()).toBe(1);
  });

  it("releases when the stream fails after its first frame, and rethrows", async () => {
    const slot = counting();
    async function* broken(): AsyncGenerator<string> {
      yield "first";
      throw new Error("model blew up");
    }
    const drain = async () => {
      for await (const _frame of guardRunStream(slot.release, broken())) {
        // Drain.
      }
    };
    await expect(drain()).rejects.toThrow("model blew up");
    expect(slot.calls()).toBe(1);
  });

  it("releases when it fails before the first event is produced", async () => {
    const slot = counting();
    // What a run that fails before its first frame looks like to the guard: `next()` rejects.
    const refused: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new ApiError("not_found", "Thread not found", 404)),
      }),
    };
    const iterator = guardRunStream(slot.release, refused)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "not_found" });
    expect(slot.calls()).toBe(1);
  });

  it("releases when the consumer walks away mid-stream (the client went away)", async () => {
    const slot = counting();
    let inner: "open" | "closed" = "open";
    async function* endless(): AsyncGenerator<string> {
      try {
        while (true) {
          yield "tick";
        }
      } finally {
        inner = "closed";
      }
    }
    for await (const _frame of guardRunStream(slot.release, endless())) {
      break;
    }
    expect(slot.calls()).toBe(1);
    expect(inner).toBe("closed");
  });

  it("releases when the consumer returns before ever asking for a frame", async () => {
    const slot = counting();
    const iterator = guardRunStream(slot.release, frames("never read"))[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(slot.calls()).toBe(1);
  });

  it("releases once however many of those paths fire", async () => {
    const limiter = createRunLimiter();
    const caps: RunCaps = { perTenant: 1, total: null };
    const release = limiter.admit("a", caps);
    const iterator = guardRunStream(release, frames("a"))[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.return?.();
    await iterator.return?.();
    release();
    expect(limiter.active("a")).toBe(0);
    keep(limiter.admit("a", caps));
    expect(refusal(() => limiter.admit("a", caps)).code).toBe(TOO_MANY_RUNS);
  });
});

describe("withRunSlot", () => {
  const tenant = { tenantId: "partner", organizationId: "org-slot" };
  const hosted = { ...SERVER, [MAX_RUNS_PER_TENANT_ENV]: "1" };

  it("runs the work under a slot, returns its value, and gives the slot back", async () => {
    let during = -1;
    const value = await withRunSlot(
      tenant,
      async () => {
        during = activeRuns(tenant);
        return "result";
      },
      hosted,
    );
    expect(value).toBe("result");
    expect(during).toBe(1);
    expect(activeRuns(tenant)).toBe(0);
  });

  it("gives the slot back when the work rejects, and when it throws before returning a promise", async () => {
    await expect(
      withRunSlot(
        tenant,
        async () => {
          throw new Error("model blew up");
        },
        hosted,
      ),
    ).rejects.toThrow("model blew up");
    expect(activeRuns(tenant)).toBe(0);

    await expect(
      withRunSlot(
        tenant,
        () => {
          throw new Error("sync failure");
        },
        hosted,
      ),
    ).rejects.toThrow("sync failure");
    expect(activeRuns(tenant)).toBe(0);
  });

  it("refuses over the cap without ever calling the work", async () => {
    const first = admitRun(tenant, hosted);
    keep(first);
    let called = false;
    await expect(
      withRunSlot(
        tenant,
        async () => {
          called = true;
        },
        hosted,
      ),
    ).rejects.toMatchObject({ code: TOO_MANY_RUNS, status: 429 });
    expect(called).toBe(false);
    expect(activeRuns(tenant)).toBe(1);
  });

  it("holds the slot for the whole of a slow job, so a second one is refused until it ends", async () => {
    let finish: () => void = () => undefined;
    const slow = withRunSlot(tenant, () => new Promise<void>((resolve) => (finish = resolve)), hosted);
    await expect(withRunSlot(tenant, async () => 1, hosted)).rejects.toMatchObject({ code: TOO_MANY_RUNS });
    finish();
    await slow;
    await expect(withRunSlot(tenant, async () => 2, hosted)).resolves.toBe(2);
  });

  it("is a straight call-through off server mode, counting nothing (Personal parity)", async () => {
    const env = { [MAX_RUNS_PER_TENANT_ENV]: "1" };
    const results = await Promise.all([1, 2, 3].map((n) => withRunSlot(tenant, async () => n, env)));
    expect(results).toEqual([1, 2, 3]);
    expect(activeRuns(tenant)).toBe(0);
  });
});
