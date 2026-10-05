import { describe, expect, it } from "vitest";
import { createCodeLimiter } from "./code-limiter";

const FAST = { queueWaitMs: 40 };

describe("Personal", () => {
  it("allows one run at a time and answers busy to a second after the short wait", async () => {
    const limiter = createCodeLimiter({ serverMode: false, ...FAST });
    const first = await limiter.acquire("local");
    expect(first).not.toBeNull();
    const started = Date.now();
    expect(await limiter.acquire("local")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    first?.();
    expect(limiter.active()).toBe(0);
    const again = await limiter.acquire("local");
    expect(again).not.toBeNull();
    again?.();
  });

  it("lets a waiting run in when the first finishes inside the wait", async () => {
    const limiter = createCodeLimiter({ serverMode: false, queueWaitMs: 2000 });
    const first = await limiter.acquire("local");
    const waiting = limiter.acquire("local");
    setTimeout(() => first?.(), 20);
    const second = await waiting;
    expect(second).not.toBeNull();
    second?.();
  });
});

describe("hosted", () => {
  it("allows two runs overall and answers busy to a third", async () => {
    const limiter = createCodeLimiter({ serverMode: true, maxRuns: 2, maxPerTenant: 1, ...FAST });
    const a = await limiter.acquire("tenant-a");
    const b = await limiter.acquire("tenant-b");
    expect(a && b).toBeTruthy();
    expect(await limiter.acquire("tenant-c")).toBeNull();
    a?.();
    const c = await limiter.acquire("tenant-c");
    expect(c).not.toBeNull();
    b?.();
    c?.();
  });

  it("allows one run per tenant even when the global cap has room", async () => {
    const limiter = createCodeLimiter({ serverMode: true, maxRuns: 4, maxPerTenant: 1, ...FAST });
    const first = await limiter.acquire("tenant-a");
    expect(await limiter.acquire("tenant-a")).toBeNull();
    const other = await limiter.acquire("tenant-b");
    expect(other).not.toBeNull();
    first?.();
    other?.();
  });

  it("does not hold a global slot while a tenant waits for its own", async () => {
    const limiter = createCodeLimiter({ serverMode: true, maxRuns: 2, maxPerTenant: 1, ...FAST });
    const first = await limiter.acquire("tenant-a");
    expect(await limiter.acquire("tenant-a")).toBeNull();
    // The refused second call must not have kept a global slot: tenant-b can still run, and so can a third tenant.
    const b = await limiter.acquire("tenant-b");
    expect(b).not.toBeNull();
    expect(limiter.active()).toBe(2);
    first?.();
    b?.();
    expect(limiter.active()).toBe(0);
  });

  it("reads the caps from the environment", async () => {
    const limiter = createCodeLimiter({
      serverMode: true,
      env: { AGENTFORGE_MAX_CODE_RUNS: "1", AGENTFORGE_MAX_CODE_RUNS_PER_TENANT: "1" },
      ...FAST,
    });
    const a = await limiter.acquire("tenant-a");
    expect(await limiter.acquire("tenant-b")).toBeNull();
    a?.();
  });

  it("frees both slots on release, and a release called twice frees them once", async () => {
    const limiter = createCodeLimiter({ serverMode: true, maxRuns: 1, maxPerTenant: 1, ...FAST });
    const a = await limiter.acquire("tenant-a");
    a?.();
    a?.();
    const b = await limiter.acquire("tenant-a");
    expect(b).not.toBeNull();
    expect(await limiter.acquire("tenant-a")).toBeNull();
    b?.();
  });
});
