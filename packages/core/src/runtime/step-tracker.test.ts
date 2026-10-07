import { describe, expect, it } from "vitest";
import { createStepTracker } from "./step-tracker";

const call = { type: "tool-call", toolName: "echo" };
const result = { type: "tool-result", toolName: "echo" };
const delta = { type: "text-delta", textDelta: "hi" };
const stepFinish = { type: "step-finish", finishReason: "stop" };

function feed(parts: unknown[]) {
  const tracker = createStepTracker();
  for (const part of parts) {
    tracker.observe(part);
  }
  return tracker;
}

describe("createStepTracker", () => {
  it("is at the limit when the last allowed step ended on a tool call", () => {
    const tracker = feed([call, result, stepFinish, call, result, stepFinish]);
    expect(tracker.stepsFinished()).toBe(2);
    expect(tracker.endedAtLimit(2)).toBe(true);
  });

  it("is not at the limit when the last step was the answer", () => {
    const tracker = feed([call, result, stepFinish, delta, stepFinish]);
    expect(tracker.endedAtLimit(2)).toBe(false);
  });

  it("is not at the limit when steps are left, even if the last one called a tool", () => {
    const tracker = feed([call, result, stepFinish]);
    expect(tracker.endedAtLimit(2)).toBe(false);
  });

  it("counts a step with several tool calls once", () => {
    const tracker = feed([call, call, result, result, stepFinish]);
    expect(tracker.stepsFinished()).toBe(1);
    expect(tracker.endedAtLimit(1)).toBe(true);
  });

  it("reads only the last step: an earlier tool step does not carry over", () => {
    const tracker = feed([call, result, stepFinish, delta, stepFinish]);
    expect(tracker.endedAtLimit(2)).toBe(false);
  });

  it("ignores anything that is not a stream part, and a stream that never finished a step", () => {
    const tracker = createStepTracker();
    for (const odd of [null, undefined, "x", 4, {}, { type: 3 }]) {
      tracker.observe(odd);
    }
    expect(tracker.stepsFinished()).toBe(0);
    expect(tracker.endedAtLimit(1)).toBe(false);
  });
});
