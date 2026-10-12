import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobEvent } from "@agentforge/core/jobs";
import {
  WORKER_HEARTBEAT_MS,
  WORKER_MAX_MS,
  WORKER_STREAM_IDLE_MS,
  currentWorkerChannel,
  runWithWorkerProgress,
  withWorkerChannel,
  type WorkerChannel,
} from "./worker-channel";

/**
 * The seam between a chat run and a worker tool. A worker reads its channel from async storage, sends
 * its harness's progress through it, and repeats the last progress line while it sits inside one long
 * model call, so the run's stall guard sees a sign of life.
 */

const KEY = "research_dossier";

const PHASE: JobEvent = { type: "job.phase", phase: "searching", label: "Searching the web" };
const STEP: JobEvent = { type: "job.step", phase: "reading", label: "Reading a page", current: 2, total: 5 };
const ROUND: JobEvent = { type: "job.round", round: 1, total: 1, label: "Repairing the findings" };
const DELTA: JobEvent = { type: "job.delta", text: "partial words" };

function channelWith(signal?: AbortSignal): WorkerChannel & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn(), ...(signal ? { signal } : {}) };
}

/** A promise the test settles by hand, so the work stays pending while the clock moves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runWithWorkerProgress outside a chat run", () => {
  it("has no channel, runs the work and returns its value", async () => {
    expect(currentWorkerChannel()).toBeUndefined();

    const value = await runWithWorkerProgress(KEY, async () => "done");

    expect(value).toBe("done");
  });

  it("hands the work a no-op emitter and no signal, and starts no heartbeat", async () => {
    const seen: { emit: unknown; signal: unknown }[] = [];

    await runWithWorkerProgress(KEY, async (emit, signal) => {
      seen.push({ emit, signal });
      expect(() => emit(PHASE)).not.toThrow();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeUndefined();
    expect(typeof seen[0]?.emit).toBe("function");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the work's own error through", async () => {
    await expect(
      runWithWorkerProgress(KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("runWithWorkerProgress inside withWorkerChannel", () => {
  it("is visible only inside the wrapped call", async () => {
    const channel = channelWith();

    const inside = await withWorkerChannel(channel, async () => currentWorkerChannel());

    expect(inside).toBe(channel);
    expect(currentWorkerChannel()).toBeUndefined();
  });

  it("sends an event the work emits to the channel, tagged with the tool key", async () => {
    const channel = channelWith();

    const value = await withWorkerChannel(channel, () =>
      runWithWorkerProgress(KEY, async (emit) => {
        emit(PHASE);
        emit(DELTA);
        return 42;
      }),
    );

    expect(value).toBe(42);
    expect(channel.emit.mock.calls).toEqual([
      [KEY, PHASE],
      [KEY, DELTA],
    ]);
  });

  it("gives the work the channel's own signal", async () => {
    const controller = new AbortController();
    const channel = channelWith(controller.signal);
    let received: AbortSignal | undefined;

    await withWorkerChannel(channel, () =>
      runWithWorkerProgress(KEY, async (_emit, signal) => {
        received = signal;
      }),
    );

    expect(received).toBe(controller.signal);
  });

  it("clears its heartbeat timer when the work is done", async () => {
    const channel = channelWith();

    await withWorkerChannel(channel, () => runWithWorkerProgress(KEY, async () => undefined));

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the heartbeat", () => {
  it("defaults to a period shorter than the shortest idle budget of a run (60 s)", () => {
    expect(WORKER_HEARTBEAT_MS).toBeGreaterThan(0);
    expect(WORKER_HEARTBEAT_MS).toBeLessThan(60_000);
  });

  it("repeats the starting phase while nothing has been emitted yet", async () => {
    const channel = channelWith();
    const gate = deferred<void>();

    const run = withWorkerChannel(channel, () => runWithWorkerProgress(KEY, () => gate.promise, { heartbeatMs: 1000 }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(channel.emit).toHaveBeenCalledTimes(3);
    for (const call of channel.emit.mock.calls) {
      expect(call[0]).toBe(KEY);
      expect(call[1]).toMatchObject({ type: "job.phase", phase: "starting" });
    }
    gate.resolve();
    await run;
  });

  it("re-emits the last phase three times in three seconds", async () => {
    const channel = channelWith();
    const gate = deferred<void>();

    const run = withWorkerChannel(channel, () =>
      runWithWorkerProgress(
        KEY,
        async (emit) => {
          emit(PHASE);
          await gate.promise;
        },
        { heartbeatMs: 1000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(3000);

    // One call from the work itself, then one heartbeat per second.
    expect(channel.emit.mock.calls).toEqual([
      [KEY, PHASE],
      [KEY, PHASE],
      [KEY, PHASE],
      [KEY, PHASE],
    ]);
    gate.resolve();
    await run;
  });

  it("repeats the newest of phase, step and round, not an older one", async () => {
    const channel = channelWith();
    const gate = deferred<void>();
    let emitFromWork: ((event: JobEvent) => void) | undefined;

    const run = withWorkerChannel(channel, () =>
      runWithWorkerProgress(
        KEY,
        async (emit) => {
          emitFromWork = emit;
          emit(PHASE);
          await gate.promise;
        },
        { heartbeatMs: 1000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(1000);
    emitFromWork?.(STEP);
    await vi.advanceTimersByTimeAsync(1000);
    emitFromWork?.(ROUND);
    await vi.advanceTimersByTimeAsync(1000);

    const beats = channel.emit.mock.calls.map((call) => call[1]);
    // phase (work), beat, step (work), beat, round (work), beat
    expect(beats).toEqual([PHASE, PHASE, STEP, STEP, ROUND, ROUND]);
    gate.resolve();
    await run;
  });

  it("does not turn a job.delta into the heartbeat's event", async () => {
    const channel = channelWith();
    const gate = deferred<void>();

    const run = withWorkerChannel(channel, () =>
      runWithWorkerProgress(
        KEY,
        async (emit) => {
          emit(STEP);
          emit(DELTA);
          await gate.promise;
        },
        { heartbeatMs: 1000 },
      ),
    );
    await vi.advanceTimersByTimeAsync(2000);

    const heartbeats = channel.emit.mock.calls.slice(2).map((call) => call[1]);
    expect(heartbeats).toEqual([STEP, STEP]);
    expect(heartbeats).not.toContainEqual(DELTA);
    gate.resolve();
    await run;
  });

  it("stops after the work resolves", async () => {
    const channel = channelWith();
    const gate = deferred<string>();

    const run = withWorkerChannel(channel, () => runWithWorkerProgress(KEY, () => gate.promise, { heartbeatMs: 1000 }));
    await vi.advanceTimersByTimeAsync(2000);
    gate.resolve("ok");
    await expect(run).resolves.toBe("ok");
    const afterSettle = channel.emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(afterSettle).toBe(2);
    expect(channel.emit).toHaveBeenCalledTimes(afterSettle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after the work rejects, and the error still reaches the caller", async () => {
    const channel = channelWith();
    const gate = deferred<string>();

    const run = withWorkerChannel(channel, () => runWithWorkerProgress(KEY, () => gate.promise, { heartbeatMs: 1000 }));
    const settled = expect(run).rejects.toThrow("search failed");
    await vi.advanceTimersByTimeAsync(2000);
    gate.reject(new Error("search failed"));
    await settled;
    const afterSettle = channel.emit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(afterSettle).toBe(2);
    expect(channel.emit).toHaveBeenCalledTimes(afterSettle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("beats at the default period when none is given", async () => {
    const channel = channelWith();
    const gate = deferred<void>();

    const run = withWorkerChannel(channel, () => runWithWorkerProgress(KEY, () => gate.promise));
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS - 1);
    expect(channel.emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(channel.emit).toHaveBeenCalledTimes(1);
    gate.resolve();
    await run;
  });

  it("stops beating once maxMs has passed, while the work is still pending", async () => {
    const channel = channelWith();
    const gate = deferred<void>();

    const run = withWorkerChannel(channel, () =>
      runWithWorkerProgress(KEY, () => gate.promise, { heartbeatMs: 1000, maxMs: 3500 }),
    );
    await vi.advanceTimersByTimeAsync(3000);
    // Beats at 1 s, 2 s and 3 s.
    expect(channel.emit).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    // The 4 s tick is past maxMs: it ends the beat and sends nothing.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(channel.emit).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    // The work itself was never stopped.
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await run;
  });

  it("keeps the run-level stream budget longer than the longest a worker is kept alive", () => {
    expect(WORKER_STREAM_IDLE_MS).toBeGreaterThan(WORKER_MAX_MS);
  });
});
