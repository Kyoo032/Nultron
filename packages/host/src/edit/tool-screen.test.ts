import { describe, expect, it } from "vitest";
import { redactToolEvent } from "../chat-tool-events";
import { screenEvent, screenToolCompleted } from "./tool-screen";

const SECRET = "sk-test-123456789";
const SIGNED_URL =
  "https://media.example.test/clip-7.mp4?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261011%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=9f2c4e6a8b0d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a";

describe("the Edit stream's screen", () => {
  it("screens a tool result and leaves the raw result the model reads unchanged", () => {
    const raw = { apiKey: SECRET, note: `echo ${SECRET}`, job: { outputUrl: SIGNED_URL } };
    const before = JSON.stringify(raw);

    const screened = screenToolCompleted("remove_silence", raw);

    expect(JSON.stringify(raw)).toBe(before);
    expect(JSON.stringify(screened)).not.toContain(SECRET);
    expect(screened.output).toMatchObject({
      apiKey: "[REDACTED]",
      note: "echo [REDACTED]",
      job: { outputUrl: SIGNED_URL },
    });
  });

  it("is the same copy Chat's redactToolEvent gives a tool.completed", () => {
    const raw = { apiKey: SECRET, job: { outputUrl: SIGNED_URL } };

    expect(screenToolCompleted("add_title", raw)).toEqual(
      redactToolEvent({ type: "tool.completed", toolKey: "add_title", output: raw }),
    );
  });

  it("masks a failure's own words and passes other events through as Chat does", () => {
    expect(screenEvent({ type: "run.failed", message: `upstream echoed ${SECRET}` })).toEqual({
      type: "run.failed",
      message: "upstream echoed [REDACTED]",
    });
    expect(screenEvent({ type: "run.interrupted", message: `stopped ${SECRET}` })).toEqual({
      type: "run.interrupted",
      message: "stopped [REDACTED]",
    });
    expect(screenEvent({ type: "assistant.delta", text: "Hello" })).toEqual({ type: "assistant.delta", text: "Hello" });
  });
});
