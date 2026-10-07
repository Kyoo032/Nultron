import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@agentforge/core";
import { redactToolEvent } from "./chat-tool-events";

const KEY = "sk-live-0123456789abcdefABCDEF";

describe("redactToolEvent", () => {
  it("masks a key in a started tool's input and keeps the rest of the event", () => {
    const event: RuntimeEvent = { type: "tool.started", toolKey: "write_file", input: { path: "a.md", content: KEY } };
    expect(redactToolEvent(event)).toEqual({
      type: "tool.started",
      toolKey: "write_file",
      input: { path: "a.md", content: "[REDACTED]" },
    });
  });

  it("masks a key in a completed tool's output", () => {
    const event: RuntimeEvent = { type: "tool.completed", toolKey: "web_fetch", output: { body: `x ${KEY}` } };
    expect(redactToolEvent(event)).toEqual({
      type: "tool.completed",
      toolKey: "web_fetch",
      output: { body: "x [REDACTED]" },
    });
  });

  it("returns a new event and leaves the original as the runtime made it", () => {
    const event: RuntimeEvent = { type: "tool.started", toolKey: "t", input: { k: KEY } };
    const safe = redactToolEvent(event);
    expect(safe).not.toBe(event);
    expect(event).toEqual({ type: "tool.started", toolKey: "t", input: { k: KEY } });
  });

  it("passes every other event through as the same object", () => {
    const events: RuntimeEvent[] = [
      { type: "assistant.delta", text: KEY },
      { type: "run.completed", runId: "r" },
      { type: "run.step_limit", steps: 3 },
    ];
    for (const event of events) {
      expect(redactToolEvent(event)).toBe(event);
    }
  });
});
