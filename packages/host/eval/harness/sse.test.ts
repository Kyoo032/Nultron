import { describe, expect, it } from "vitest";
import { SseParser, decodeFrame, readFrames } from "./sse";

describe("SseParser", () => {
  it("reads the host's own framing and skips the connected comment", () => {
    const parser = new SseParser();
    const frames = parser.push(
      ': connected\n\nevent: run.started\ndata: {"type":"run.started","runId":"r1"}\n\nevent: assistant.delta\ndata: {"type":"assistant.delta","text":"hi"}\n\n',
    );
    expect(frames).toEqual([
      { event: "run.started", data: '{"type":"run.started","runId":"r1"}' },
      { event: "assistant.delta", data: '{"type":"assistant.delta","text":"hi"}' },
    ]);
  });

  it("holds a frame back until its blank line arrives, however the chunks split", () => {
    const parser = new SseParser();
    expect(parser.push("event: job.delta\nda")).toEqual([]);
    expect(parser.push('ta: {"type":"job.delta","text":"a"}\n')).toEqual([]);
    expect(parser.push("\nevent: job.done\ndata: {}\n\n")).toEqual([
      { event: "job.delta", data: '{"type":"job.delta","text":"a"}' },
      { event: "job.done", data: "{}" },
    ]);
  });

  it("reads CRLF line ends, including a chunk that ends between the CR and the LF", () => {
    const parser = new SseParser();
    expect(parser.push("event: a\r\ndata: 1\r")).toEqual([]);
    expect(parser.push("\n\r\nevent: b\r\ndata: 2\r\n\r\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins several data lines with a newline and strips one leading space", () => {
    const parser = new SseParser();
    expect(parser.push("data: one\ndata:  two\n\n")).toEqual([{ event: "message", data: "one\n two" }]);
  });

  it("drops a comment-only frame and counts a last frame with no closing blank line", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\n\n")).toEqual([]);
    expect(parser.push('event: job.done\ndata: {"type":"job.done"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: "job.done", data: '{"type":"job.done"}' }]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("decodeFrame and readFrames", () => {
  it("takes the type from the payload, else from the event line", () => {
    expect(decodeFrame({ event: "x", data: '{"type":"tool.started","toolKey":"calculator"}' })).toEqual({
      type: "tool.started",
      toolKey: "calculator",
    });
    expect(decodeFrame({ event: "run.completed", data: '{"runId":"r"}' })).toEqual({
      type: "run.completed",
      runId: "r",
    });
  });

  it("returns null for anything that is not a JSON object", () => {
    expect(decodeFrame({ event: "x", data: "not json" })).toBeNull();
    expect(decodeFrame({ event: "x", data: "[1,2]" })).toBeNull();
    expect(decodeFrame({ event: "x", data: "7" })).toBeNull();
  });

  it("counts the frames it could not read", () => {
    const result = readFrames([
      { event: "a", data: '{"type":"a"}' },
      { event: "b", data: "{oops" },
      { event: "c", data: '{"type":"c"}' },
    ]);
    expect(result.events).toEqual([{ type: "a" }, { type: "c" }]);
    expect(result.malformed).toBe(1);
  });
});
