import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentforge/core";
import { collectJobEvents, jobErrorFromUnknown, streamJob, throwIfJobAborted } from "./job-stream";
import { activeRuns } from "./run-limits";

describe("streamJob", () => {
  it("streams progress in order and ends with job.done carrying the result", async () => {
    const result = streamJob(async (emit) => {
      emit({ type: "job.phase", phase: "searching", label: "Searching" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      emit({ type: "job.step", phase: "searching", label: "q1", current: 1, total: 1 });
      return { title: "done" };
    });
    const events = await collectJobEvents(result);
    expect(events.map((event) => event.type)).toEqual(["job.phase", "job.step", "job.done"]);
    expect(events.at(-1)).toEqual({ type: "job.done", result: { title: "done" } });
  });

  it("maps ApiError to job.error with its code and status", async () => {
    const result = streamJob(async () => {
      throw new ApiError("tool_failed", "Add a Tavily key sk-secret-123456789", 503);
    });
    const events = await collectJobEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "job.error", code: "tool_failed", status: 503 });
    expect((events[0] as { message: string }).message).not.toContain("sk-secret-123456789");
  });

  it("maps unknown errors to internal_error and ignores emits after completion", async () => {
    const late: { emit: (() => void) | null } = { emit: null };
    const result = streamJob(async (emit) => {
      late.emit = () => emit({ type: "job.delta", text: "late" });
      throw new Error("boom");
    });
    const events = await collectJobEvents(result);
    late.emit?.();
    expect(events).toEqual([{ type: "job.error", code: "internal_error", message: "boom", status: 500 }]);
    expect(jobErrorFromUnknown("x")).toMatchObject({ code: "internal_error", message: "Job failed" });
  });

  it("hands the abort signal to the job and stops it between phases", async () => {
    const controller = new AbortController();
    const result = streamJob(
      async (emit, signal) => {
        emit({ type: "job.phase", phase: "searching", label: "Searching" });
        controller.abort();
        throwIfJobAborted(signal);
        return "should not get here";
      },
      { abortSignal: controller.signal },
    );
    const events = await collectJobEvents(result);
    expect(events[0]).toMatchObject({ type: "job.phase" });
    expect(events.some((event) => event.type === "job.done")).toBe(false);
    expect(() => throwIfJobAborted(undefined)).not.toThrow();
  });

  it("does not let the job forge a done event", async () => {
    const result = streamJob(async (emit) => {
      emit({ type: "job.done", result: "forged" });
      return "real";
    });
    const events = await collectJobEvents(result);
    expect(events).toEqual([{ type: "job.done", result: "real" }]);
  });
});

/**
 * SR-138: a streaming job that names its tenant holds one run slot from admission until the stream is
 * over, and is refused before it starts when the tenant is at its cap (the route answers 429 as JSON).
 */
describe("streamJob and the per-tenant run cap", () => {
  const tenant = { tenantId: "partner", organizationId: "org-jobs" };
  const other = { tenantId: "partner", organizationId: "org-other" };

  function hostedWithCap(cap: string): void {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    vi.stubEnv("AGENTFORGE_MAX_RUNS_PER_TENANT", cap);
    vi.stubEnv("AGENTFORGE_MAX_RUNS_TOTAL", "");
  }

  /** A job the test finishes by hand. */
  function gated() {
    let finish: (value: unknown) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    return { run, finish: (value: unknown = "done") => finish(value), fail: (error: Error) => fail(error) };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("holds a slot while the job runs and gives it back when the job is done", async () => {
    hostedWithCap("2");
    const job = gated();
    const result = streamJob(job.run, { tenant });
    expect(activeRuns(tenant)).toBe(1);
    job.finish({ title: "ok" });
    const events = await collectJobEvents(result);
    expect(events.at(-1)).toEqual({ type: "job.done", result: { title: "ok" } });
    expect(activeRuns(tenant)).toBe(0);
  });

  it("refuses the job over the cap before it starts, with 429 too_many_runs, and never runs it", () => {
    hostedWithCap("1");
    const job = gated();
    streamJob(job.run, { tenant });
    const started = vi.fn(async () => "never");
    let refusal: unknown;
    try {
      streamJob(started, { tenant });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: "too_many_runs", status: 429 });
    expect(started).not.toHaveBeenCalled();
    expect(activeRuns(tenant)).toBe(1);
    // Another tenant is not held up by it.
    const unrelated = gated();
    streamJob(unrelated.run, { tenant: other });
    expect(activeRuns(other)).toBe(1);
    job.finish();
    unrelated.finish();
  });

  it("gives the slot back when the job fails", async () => {
    hostedWithCap("1");
    const job = gated();
    const result = streamJob(job.run, { tenant });
    job.fail(new Error("boom"));
    const events = await collectJobEvents(result);
    expect(events).toEqual([{ type: "job.error", code: "internal_error", message: "boom", status: 500 }]);
    expect(activeRuns(tenant)).toBe(0);
  });

  it("gives the slot back when the client goes away, though the job has not noticed yet", async () => {
    hostedWithCap("1");
    const controller = new AbortController();
    const job = gated();
    const result = streamJob(job.run, { tenant, abortSignal: controller.signal });
    const reading = collectJobEvents(result);
    controller.abort();
    await reading;
    expect(activeRuns(tenant)).toBe(0);
    job.finish();
  });

  it("gives the slot back when the consumer stops reading", async () => {
    hostedWithCap("1");
    const job = gated();
    const result = streamJob(
      async (emit) => {
        emit({ type: "job.phase", phase: "searching", label: "Searching" });
        return job.run();
      },
      { tenant },
    );
    for await (const _frame of result.events) {
      break;
    }
    expect(activeRuns(tenant)).toBe(0);
    job.finish();
  });

  it("gives the slot back when the job settles though nobody ever read the stream", async () => {
    hostedWithCap("1");
    const job = gated();
    streamJob(job.run, { tenant });
    expect(activeRuns(tenant)).toBe(1);
    job.finish();
    await vi.waitFor(() => expect(activeRuns(tenant)).toBe(0));
  });

  it("gives the slot back when the job throws before it returns a promise, and rethrows", () => {
    hostedWithCap("1");
    expect(() =>
      streamJob(
        (() => {
          throw new Error("sync failure");
        }) as unknown as () => Promise<unknown>,
        { tenant },
      ),
    ).toThrow("sync failure");
    expect(activeRuns(tenant)).toBe(0);
  });

  it("takes no slot from a job that names no tenant (machine-wide work), or off server mode", async () => {
    hostedWithCap("1");
    await collectJobEvents(streamJob(async () => "no tenant"));
    expect(activeRuns()).toBe(0);

    vi.unstubAllEnvs();
    vi.stubEnv("AGENTFORGE_SERVER", "");
    vi.stubEnv("AGENTFORGE_MAX_RUNS_PER_TENANT", "1");
    const jobs = [gated(), gated(), gated()];
    for (const job of jobs) {
      streamJob(job.run, { tenant });
    }
    expect(activeRuns()).toBe(0);
    for (const job of jobs) {
      job.finish();
    }
  });
});
