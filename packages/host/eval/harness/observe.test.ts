import { describe, expect, it } from "vitest";
import { dataCheckFailures, jobEnding, jobToolCalls, observeAll, runEnding, totalEvents } from "./observe";
import type { StreamEvent } from "./sse";

const ev = (type: string, rest: Record<string, unknown> = {}): StreamEvent => ({ type, ...rest });

describe("observeAll on a chat run", () => {
  const events = [
    ev("run.started", { runId: "r1" }),
    ev("run.probing", { model: "m", attempt: 1, attempts: 3, message: "contacting" }),
    ev("tool.started", { toolKey: "calculator", input: { expression: "0.175*2340" } }),
    ev("tool.completed", { toolKey: "calculator", output: { success: true, result: 409.5 } }),
    ev("tool.started", { toolKey: "datetime", input: {} }),
    ev("tool.completed", { toolKey: "datetime", output: { success: false, error: "boom" } }),
    ev("assistant.delta", { text: "It is " }),
    ev("assistant.delta", { text: "409.5." }),
    ev("run.completed", { runId: "r1", usage: { model: "gpt-x", inputTokens: 120, outputTokens: 18 } }),
  ];

  it("keeps the tool calls in order, the text and the usage", () => {
    const observation = observeAll(events);
    expect(observation.toolCalls).toEqual(["calculator", "datetime"]);
    expect(observation.toolFailures).toEqual(["datetime"]);
    expect(observation.text).toBe("It is 409.5.");
    expect(observation.usage).toEqual({ model: "gpt-x", inputTokens: 120, outputTokens: 18 });
    expect(observation.contactAttempts).toBe(1);
    expect(totalEvents(observation)).toBe(9);
    expect(observation.eventCounts["assistant.delta"]).toBe(2);
  });

  it("calls the run completed only when run.completed arrived and nothing failed", () => {
    expect(runEnding(observeAll(events))).toEqual({ completed: true, error: null });
    expect(runEnding(observeAll(events.slice(0, 3)))).toEqual({
      completed: false,
      error: "stream ended without run.completed",
    });
    expect(
      runEnding(observeAll([ev("run.failed", { message: "gateway 502" }), ev("run.completed", { runId: "r" })])),
    ).toEqual({
      completed: false,
      error: "gateway 502",
    });
  });
});

describe("observeAll on a job", () => {
  const events = [
    ev("job.phase", { phase: "profiling", label: "Profiling" }),
    ev("job.phase", { phase: "analyzing", label: "Querying" }),
    ev("job.step", { phase: "analyzing", label: "SELECT 1", detail: "1 row", current: 1, total: 8 }),
    ev("job.step", { phase: "analyzing", label: "SELECT x", detail: "failed: no such column", current: 2, total: 8 }),
    ev("job.step", { phase: "reading", label: "A page", current: 1, total: 2 }),
    ev("job.source", { id: "s1", title: "t", url: "https://a", status: "found" }),
    ev("job.source", { id: "s1", title: "t", url: "https://a", status: "read" }),
    ev("job.source", { id: "s2", title: "t", url: "https://b", status: "unreachable" }),
    ev("job.done", { result: { artifactId: "a1" } }),
  ];

  it("reads steps and sources, and the result of job.done", () => {
    const observation = observeAll(events);
    expect(observation.jobSteps.map((step) => step.phase)).toEqual(["analyzing", "analyzing", "reading"]);
    expect(observation.sources).toEqual({ found: 1, read: 1, unreachable: 1 });
    expect(observation.jobResult).toEqual({ artifactId: "a1" });
    expect(jobEnding(observation)).toEqual({ completed: true, error: null });
  });

  it("maps only the phases whose steps are tool calls", () => {
    const observation = observeAll(events);
    expect(jobToolCalls(observation.jobSteps, { analyzing: "run_sql" })).toEqual(["run_sql", "run_sql"]);
    expect(jobToolCalls(observation.jobSteps, { searching: "web_search" })).toEqual([]);
  });

  it("ends a job on job.error with its message", () => {
    const observation = observeAll([ev("job.error", { code: "tool_failed", message: "no results", status: 502 })]);
    expect(jobEnding(observation)).toEqual({ completed: false, error: "no results" });
  });

  it("counts frames the stream could not decode", () => {
    expect(observeAll([], 2).malformedFrames).toBe(2);
  });
});

describe("dataCheckFailures", () => {
  it("reports a finding whose evidence query failed and each failed run_sql step", () => {
    const result = {
      analysis: {
        findings: [
          { heading: "East leads", body: "East sold 610.\n\n(Evidence query failed: no such column: reigon)" },
          { heading: "Fine", body: "All good." },
        ],
      },
    };
    const steps = [
      { phase: "analyzing", label: "SELECT 1", detail: "1 row" },
      { phase: "analyzing", label: "SELECT reigon", detail: "failed: no such column: reigon" },
    ];
    expect(dataCheckFailures(result, steps)).toEqual([
      "evidence query failed: East leads: no such column: reigon",
      "run_sql failed: no such column: reigon",
    ]);
  });

  it("reports nothing for a clean result and for a result it cannot read", () => {
    expect(dataCheckFailures({ analysis: { findings: [{ heading: "h", body: "b" }] } }, [])).toEqual([]);
    expect(dataCheckFailures(null, [])).toEqual([]);
  });
});
