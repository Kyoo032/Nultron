/**
 * The runner's one clock: monotonic milliseconds, a sleep and a cancellable timer. Everything that times a
 * frame reads it, so the tests can run a whole turn at several times real speed (`scaledClock`) and the real
 * run uses `realClock`.
 *
 * `performance.now()` is monotonic: it does not jump when the wall clock is set, which is what a latency
 * number needs.
 */
import { performance } from "node:perf_hooks";

export type Timer = { cancel(): void };

export type Clock = {
  /** Monotonic milliseconds. Only differences mean anything. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Runs `fn` after `ms`, unless cancelled first. A cancelled timer does not keep the process alive. */
  after(ms: number, fn: () => void): Timer;
};

function clockOver(now: () => number, factor: number): Clock {
  const after = (ms: number, fn: () => void): Timer => {
    const handle = setTimeout(fn, Math.max(0, ms) / factor);
    return { cancel: () => clearTimeout(handle) };
  };
  return { now, sleep: (ms) => new Promise((resolve) => after(ms, resolve)), after };
}

export const realClock: Clock = clockOver(() => performance.now(), 1);

/**
 * A clock that runs `factor` times faster than real time: `now()` advances `factor` ms per real ms and
 * `sleep(ms)` takes `ms / factor` real ms. Two things sharing one scaled clock agree on every duration, so a
 * 1.5 s latency check can be run in a quarter of a second. Network time is not scaled, so it reads as
 * `factor` times larger in these numbers: tests keep a wide margin around every limit.
 */
export function scaledClock(factor: number): Clock {
  const origin = performance.now();
  return clockOver(() => (performance.now() - origin) * factor, factor);
}
