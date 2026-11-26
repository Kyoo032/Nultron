import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeLanguage } from "@agentforge/core";
import type { BootOutcome, SandboxChild } from "./child-process";
import { type ChildPool, createChildPool, type PoolKey, poolKeyString } from "./pool";

type FakeChild = SandboxChild & { readonly id: number; readonly killed: () => boolean; die(): void };

let nextId = 1;
const spawned: FakeChild[] = [];

function fakeChild(language: CodeLanguage, boot: BootOutcome = { ok: true }): FakeChild {
  let dead = false;
  const listeners: Array<() => void> = [];
  const child: FakeChild = {
    id: nextId++,
    language,
    alive: () => !dead,
    boot: () => Promise.resolve(boot),
    run: () => Promise.reject(new Error("the pool never runs jobs")),
    kill() {
      if (!dead) {
        dead = true;
        for (const listener of listeners) {
          listener();
        }
      }
    },
    onExit: (listener) => {
      if (dead) {
        listener();
      } else {
        listeners.push(listener);
      }
    },
    killed: () => dead,
    die() {
      child.kill();
    },
  };
  spawned.push(child);
  return child;
}

const key = (tenantId: string, workspaceId: string, language: CodeLanguage = "python"): PoolKey => ({
  tenantId,
  workspaceId,
  language,
});

function personalPool(overrides: { boot?: BootOutcome; idleMs?: number } = {}): ChildPool {
  return createChildPool({
    serverMode: false,
    idleMs: overrides.idleMs,
    spawn: (language) => fakeChild(language, overrides.boot),
  });
}

function hostedPool(idleMs?: number, hostedWarmTotal?: number): ChildPool {
  return createChildPool({ serverMode: true, idleMs, hostedWarmTotal, spawn: (language) => fakeChild(language) });
}

async function checkout(pool: ChildPool, k: PoolKey) {
  const result = await pool.checkout(k);
  if (!result.ok) {
    throw new Error(`checkout refused: ${result.why}`);
  }
  return result.lease;
}

beforeEach(() => {
  spawned.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("warm reuse", () => {
  it("hands the same child back to the same tenant, desk and language", async () => {
    const pool = personalPool();
    const first = await checkout(pool, key("t1", "d1"));
    expect(first.cold).toBe(true);
    first.release(true);

    const second = await checkout(pool, key("t1", "d1"));
    expect(second.cold).toBe(false);
    expect(second.child).toBe(first.child);
    expect(spawned).toHaveLength(1);
    pool.shutdown();
  });

  it("never gives one tenant's child to another tenant", async () => {
    const pool = hostedPool();
    const a = await checkout(pool, key("tenant-a", "desk"));
    a.release(true);
    const b = await checkout(pool, key("tenant-b", "desk"));
    expect(b.child).not.toBe(a.child);
    expect(b.cold).toBe(true);
    pool.shutdown();
  });

  it("never gives one desk's child to another desk of the same tenant", async () => {
    const pool = hostedPool();
    const a = await checkout(pool, key("t", "desk-1"));
    a.release(true);
    const b = await checkout(pool, key("t", "desk-2"));
    expect(b.child).not.toBe(a.child);
    pool.shutdown();
  });

  it("keeps languages apart for the same desk", async () => {
    const pool = personalPool();
    const py = await checkout(pool, key("t", "d", "python"));
    py.release(true);
    const js = await checkout(pool, key("t", "d", "javascript"));
    expect(js.child).not.toBe(py.child);
    expect(pool.size()).toBe(2);
    pool.shutdown();
  });

  it("does not hand a leased child to a second caller", async () => {
    const pool = hostedPool(undefined, 2);
    const first = await checkout(pool, key("t", "d"));
    const second = await checkout(pool, key("t", "d"));
    expect(second.child).not.toBe(first.child);
    pool.shutdown();
  });

  it("keys on a tuple, so ids that concatenate to the same text stay distinct", () => {
    expect(poolKeyString(key("ab", "c"))).not.toBe(poolKeyString(key("a", "bc")));
  });
});

describe("capacity", () => {
  it("Personal keeps one warm child per language and replaces it when the desk changes", async () => {
    const pool = personalPool();
    const first = await checkout(pool, key("local", "desk-1"));
    first.release(true);
    const second = await checkout(pool, key("local", "desk-2"));
    expect(first.child.alive()).toBe(false);
    expect(second.child.alive()).toBe(true);
    expect(pool.size()).toBe(1);
    pool.shutdown();
  });

  it("Personal lets Python and JavaScript each keep one", async () => {
    const pool = personalPool();
    (await checkout(pool, key("local", "d", "python"))).release(true);
    (await checkout(pool, key("local", "d", "javascript"))).release(true);
    expect(pool.size()).toBe(2);
    pool.shutdown();
  });

  it("hosted keeps one warm child by default, so a 768 MiB desk holds it beside the host", async () => {
    const pool = hostedPool();
    const a = await checkout(pool, key("a", "d"));
    a.release(true);
    const b = await checkout(pool, key("b", "d"));
    expect(pool.size()).toBe(1);
    expect(a.child.alive()).toBe(false);
    expect(b.cold).toBe(true);
    pool.shutdown();
  });

  it("hosted keeps the configured warm children in total and evicts the least recently used", async () => {
    let clock = 1000;
    const pool = createChildPool({
      serverMode: true,
      hostedWarmTotal: 2,
      now: () => clock,
      spawn: (language) => fakeChild(language),
    });
    const a = await checkout(pool, key("a", "d"));
    a.release(true);
    clock += 10;
    const b = await checkout(pool, key("b", "d"));
    b.release(true);
    clock += 10;
    // Use a again, so b is now the oldest.
    (await checkout(pool, key("a", "d"))).release(true);
    clock += 10;
    const c = await checkout(pool, key("c", "d"));
    expect(pool.size()).toBe(2);
    expect(b.child.alive()).toBe(false);
    expect(a.child.alive()).toBe(true);
    expect(c.cold).toBe(true);
    pool.shutdown();
  });

  it("answers busy rather than evicting a child that is running", async () => {
    const pool = hostedPool();
    await checkout(pool, key("a", "d"));
    const second = await pool.checkout(key("b", "d"));
    expect(second).toEqual({ ok: false, why: "busy" });
    expect(pool.size()).toBe(1);
    pool.shutdown();
  });

  it("Personal answers busy when its one child for the language is running", async () => {
    const pool = personalPool();
    await checkout(pool, key("local", "d1"));
    expect(await pool.checkout(key("local", "d2"))).toEqual({ ok: false, why: "busy" });
    pool.shutdown();
  });
});

describe("discarding", () => {
  it("kills a child released without reuse and boots a new one next time", async () => {
    const pool = personalPool();
    const first = await checkout(pool, key("t", "d"));
    first.release(false);
    expect(first.child.alive()).toBe(false);
    expect(pool.size()).toBe(0);
    const second = await checkout(pool, key("t", "d"));
    expect(second.cold).toBe(true);
    expect(second.child).not.toBe(first.child);
    pool.shutdown();
  });

  it("ignores a second release", async () => {
    const pool = personalPool();
    const lease = await checkout(pool, key("t", "d"));
    lease.release(true);
    lease.release(false);
    expect(lease.child.alive()).toBe(true);
    expect(pool.size()).toBe(1);
    pool.shutdown();
  });

  it("forgets a child that dies while idle and does not hand it out", async () => {
    const pool = personalPool();
    const first = await checkout(pool, key("t", "d"));
    first.release(true);
    (first.child as FakeChild).die();
    expect(pool.size()).toBe(0);
    const second = await checkout(pool, key("t", "d"));
    expect(second.cold).toBe(true);
    pool.shutdown();
  });

  it("does not keep a child that died during its run", async () => {
    const pool = personalPool();
    const lease = await checkout(pool, key("t", "d"));
    (lease.child as FakeChild).die();
    lease.release(true);
    expect(pool.size()).toBe(0);
    pool.shutdown();
  });

  it("reports a failed boot and leaves no child behind", async () => {
    const pool = personalPool({ boot: { ok: false, why: "fatal", detail: "sha256 mismatch" } });
    const result = await pool.checkout(key("t", "d"));
    expect(result).toMatchObject({ ok: false, why: "boot_failed", boot: { why: "fatal" } });
    expect(pool.size()).toBe(0);
    expect(spawned[0]?.alive()).toBe(false);
  });
});

describe("idle timeout", () => {
  it("kills a warm child nobody used for five minutes", async () => {
    vi.useFakeTimers();
    const pool = createChildPool({ serverMode: false, spawn: (language) => fakeChild(language) });
    const lease = await checkout(pool, key("t", "d"));
    lease.release(true);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(lease.child.alive()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(lease.child.alive()).toBe(false);
    expect(pool.size()).toBe(0);
  });

  it("restarts the clock when the child is used again", async () => {
    vi.useFakeTimers();
    const pool = createChildPool({ serverMode: false, spawn: (language) => fakeChild(language) });
    const first = await checkout(pool, key("t", "d"));
    first.release(true);
    vi.advanceTimersByTime(4 * 60_000);
    const second = await checkout(pool, key("t", "d"));
    second.release(true);
    vi.advanceTimersByTime(4 * 60_000);
    expect(second.child.alive()).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(second.child.alive()).toBe(false);
  });
});

describe("shutdown", () => {
  it("kills every child, idle or running", async () => {
    const pool = hostedPool(undefined, 2);
    const running = await checkout(pool, key("a", "d"));
    const idle = await checkout(pool, key("b", "d"));
    idle.release(true);
    pool.shutdown();
    expect(running.child.alive()).toBe(false);
    expect(idle.child.alive()).toBe(false);
    expect(pool.size()).toBe(0);
  });
});
