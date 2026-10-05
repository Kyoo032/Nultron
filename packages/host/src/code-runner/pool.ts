import type { CodeLanguage } from "@agentforge/core";
import type { BootOutcome, SandboxChild } from "./child-process";
import { HOSTED_WARM_TOTAL, IDLE_TIMEOUT_MS, PERSONAL_WARM_PER_LANGUAGE } from "./limits";

/**
 * Warm sandbox children, keyed by (tenant, desk, language).
 *
 * A child boots slowly (Pyodide with pandas is 11 to 25 s), so a finished run leaves it warm for the
 * next one. Warm never means shared: a child is only ever handed back to the SAME tenant, desk and
 * language that used it, and each run starts in a fresh namespace and a cleaned /workspace (the child
 * scripts do that). A child that timed out, ran out of memory, crashed, produced an oversize result or
 * asked to be discarded is killed, never reused.
 *
 * Capacity: on Personal one warm child per language (switching desks replaces it); hosted keeps at most
 * `HOSTED_WARM_TOTAL` in all, evicting the least recently used idle one. Idle children die after five
 * minutes. A child that is booting or running is never evicted.
 */

export type PoolKey = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly language: CodeLanguage;
};

export type Lease = {
  readonly child: SandboxChild;
  /** True when this checkout had to boot a new child. */
  readonly cold: boolean;
  /** Give the child back (`reuse`) or kill it. Idempotent. */
  release(reuse: boolean): void;
};

export type CheckoutResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly why: "busy" }
  | { readonly ok: false; readonly why: "boot_failed"; readonly boot: Extract<BootOutcome, { ok: false }> };

export type PoolOptions = {
  readonly spawn: (language: CodeLanguage) => SandboxChild;
  /** Hosted: a total cap. Personal: a cap per language. */
  readonly serverMode: boolean;
  readonly idleMs?: number;
  readonly hostedWarmTotal?: number;
  readonly personalWarmPerLanguage?: number;
  readonly now?: () => number;
};

export type ChildPool = {
  checkout(key: PoolKey): Promise<CheckoutResult>;
  /** Children the pool holds right now (idle, booting or running). */
  size(): number;
  /** The keys of the idle children, least recently used first. For tests and diagnostics. */
  idleKeys(): string[];
  /** Kills everything and forgets it. */
  shutdown(): void;
};

type Entry = {
  readonly id: number;
  readonly key: string;
  readonly language: CodeLanguage;
  readonly child: SandboxChild;
  state: "leased" | "idle";
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
};

export function poolKeyString(key: PoolKey): string {
  return JSON.stringify([key.tenantId, key.workspaceId, key.language]);
}

export function createChildPool(options: PoolOptions): ChildPool {
  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
  const hostedTotal = options.hostedWarmTotal ?? HOSTED_WARM_TOTAL;
  const perLanguage = options.personalWarmPerLanguage ?? PERSONAL_WARM_PER_LANGUAGE;
  const now = options.now ?? Date.now;
  const entries = new Map<number, Entry>();
  let nextId = 1;

  const drop = (entry: Entry, kill: boolean): void => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entries.delete(entry.id);
    if (kill) {
      entry.child.kill();
    }
  };

  const idleOldestFirst = (): Entry[] =>
    [...entries.values()].filter((entry) => entry.state === "idle").sort((a, b) => a.lastUsed - b.lastUsed);

  /** Frees one slot for `language`, or says there is no idle child to give up. */
  const makeRoom = (language: CodeLanguage): boolean => {
    if (options.serverMode) {
      if (entries.size < hostedTotal) {
        return true;
      }
      const victim = idleOldestFirst()[0];
      if (!victim) {
        return false;
      }
      drop(victim, true);
      return true;
    }
    const sameLanguage = [...entries.values()].filter((entry) => entry.language === language);
    const needed = sameLanguage.length - perLanguage + 1;
    if (needed <= 0) {
      return true;
    }
    const victims = idleOldestFirst().filter((entry) => entry.language === language);
    if (victims.length < needed) {
      return false;
    }
    for (const victim of victims.slice(0, needed)) {
      drop(victim, true);
    }
    return true;
  };

  const leaseFor = (entry: Entry, cold: boolean): Lease => {
    let released = false;
    return {
      child: entry.child,
      cold,
      release(reuse) {
        if (released) {
          return;
        }
        released = true;
        if (!reuse || !entry.child.alive() || !entries.has(entry.id)) {
          drop(entry, true);
          return;
        }
        entry.state = "idle";
        entry.lastUsed = now();
        entry.idleTimer = setTimeout(() => drop(entry, true), idleMs);
        entry.idleTimer.unref?.();
      },
    };
  };

  return {
    async checkout(key) {
      const keyText = poolKeyString(key);
      const warm = [...entries.values()].find(
        (entry) => entry.state === "idle" && entry.key === keyText && entry.child.alive(),
      );
      if (warm) {
        if (warm.idleTimer) {
          clearTimeout(warm.idleTimer);
          warm.idleTimer = null;
        }
        warm.state = "leased";
        return { ok: true, lease: leaseFor(warm, false) };
      }
      if (!makeRoom(key.language)) {
        return { ok: false, why: "busy" };
      }
      const child = options.spawn(key.language);
      const entry: Entry = {
        id: nextId++,
        key: keyText,
        language: key.language,
        child,
        state: "leased",
        lastUsed: now(),
        idleTimer: null,
      };
      entries.set(entry.id, entry);
      // A child that dies on its own (a crash while idle) must not stay in the table.
      child.onExit(() => drop(entry, false));
      const boot = await child.boot();
      if (!boot.ok) {
        drop(entry, true);
        return { ok: false, why: "boot_failed", boot };
      }
      return { ok: true, lease: leaseFor(entry, true) };
    },
    size: () => entries.size,
    idleKeys: () => idleOldestFirst().map((entry) => entry.key),
    shutdown() {
      for (const entry of [...entries.values()]) {
        drop(entry, true);
      }
    },
  };
}
