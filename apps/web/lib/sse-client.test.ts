import { describe, expect, it } from "vitest";
import { consumeSse } from "./sse-client";

describe("consumeSse", () => {
  it("parses thinking and tool events from an SSE buffer", () => {
    const { events, rest } = consumeSse(
      [
        "event: run.started\ndata: {\"type\":\"run.started\",\"runId\":\"r1\"}\n\n",
        "event: run.probing\ndata: {\"type\":\"run.probing\",\"model\":\"gpt-5.6-luna\",\"attempt\":2,\"attempts\":3,\"message\":\"2nd try · gpt-5.6-luna\"}\n\n",
        "event: assistant.thinking\ndata: {\"type\":\"assistant.thinking\",\"text\":\"hmm\"}\n\n",
        "event: tool.started\ndata: {\"type\":\"tool.started\",\"toolKey\":\"calculator\",\"input\":{}}\n\n",
        "event: assistant.delta\ndata: {\"type\":\"assistant.delta\",\"text\":\"hi\"}\n\n",
        "event: run.failed\ndata: {\"type\":\"run.failed\",\"message\":\"nope\"}\n\npartial",
      ].join(""),
    );
    expect(rest).toBe("partial");
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.probing",
      "assistant.thinking",
      "tool.started",
      "assistant.delta",
      "run.failed",
    ]);
    expect(events[1]?.message).toBe("2nd try · gpt-5.6-luna");
    expect(events[1]?.attempt).toBe(2);
    expect(events[2]?.text).toBe("hmm");
    expect(events[5]?.message).toBe("nope");
  });

  it("hands an event type it does not know through untouched, so a reader that checks types ignores it", () => {
    // `run.step_limit` is sent by the Edit agent's stream and not by Chat's. Both readers
    // (`edit-studio.tsx` and `chat-composer.tsx`) test the types they handle one by one and have no
    // default branch, so an unknown type must come out of the parser as a plain event and nothing more.
    const { events, rest } = consumeSse(
      [
        'event: tool.started\ndata: {"type":"tool.started","toolKey":"split_clip","touching":[]}\n\n',
        'event: run.step_limit\ndata: {"type":"run.step_limit","steps":6}\n\n',
        'event: run.completed\ndata: {"type":"run.completed","runId":"r1"}\n\n',
      ].join(""),
    );
    expect(rest).toBe("");
    expect(events.map((event) => event.type)).toEqual(["tool.started", "run.step_limit", "run.completed"]);
    expect(events[1]).toMatchObject({ type: "run.step_limit", steps: 6 });
    const handled = events.filter((event) => event.type === "assistant.delta" || event.type === "run.failed");
    expect(handled).toEqual([]);
  });

  it("skips a malformed data line instead of aborting the stream", () => {
    const { events } = consumeSse("event: assistant.delta\ndata: not-json\n\nevent: assistant.delta\ndata: {\"text\":\"ok\"}\n\n");
    expect(events).toEqual([expect.objectContaining({ type: "assistant.delta", text: "ok" })]);
  });
});
