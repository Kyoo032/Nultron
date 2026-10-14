import { describe, expect, it } from "vitest";
import {
  openBoardStream,
  parseBoardFrames,
  reconnectDelayMs,
  type BoardFrame,
  type BoardStreamState,
} from "./board-stream";

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("parseBoardFrames", () => {
  it("reads id, event and data, drops comment frames, and keeps a partial frame for later", () => {
    const { frames, rest } = parseBoardFrames(
      ': open\n\nid: 7\nevent: card.created\ndata: {"cardId":"c1"}\n\n: hb\n\nid: 8\nevent: card.ed',
    );
    expect(frames).toEqual([{ id: 7, event: "card.created", data: { cardId: "c1" } }]);
    expect(rest).toBe("id: 8\nevent: card.ed");
  });

  it("survives CRLF and a broken data line", () => {
    const { frames } = parseBoardFrames("event: reset\r\ndata: {}\r\n\r\nevent: card.moved\ndata: {nope\n\n");
    expect(frames).toEqual([
      { id: null, event: "reset", data: {} },
      { id: null, event: "card.moved", data: {} },
    ]);
  });
});

describe("reconnectDelayMs", () => {
  it("doubles from one second and stops at thirty", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("openBoardStream", () => {
  it("resumes after a drop from the last id it received, never from the start", async () => {
    const asked: number[] = [];
    const responses = [
      sse(['id: 11\nevent: card.created\ndata: {"cardId":"a"}\n\n']),
      sse(['id: 12\nevent: card.edited\ndata: {"cardId":"a"}\n\nevent: closed\ndata: {"reason":"access"}\n\n']),
    ];
    const seen: BoardFrame[] = [];
    const states: BoardStreamState[] = [];
    openBoardStream({
      after: 10,
      onEvent: (frame) => seen.push(frame),
      onReset: () => undefined,
      onState: (state) => states.push(state),
      fetchStream: async (lastEventId) => {
        asked.push(lastEventId);
        const next = responses.shift();
        if (!next) {
          throw new Error("no more");
        }
        return next;
      },
      wait: async () => undefined,
    });
    await settle();
    expect(asked).toEqual([10, 11]);
    expect(seen.map((frame) => frame.id)).toEqual([11, 12]);
    expect(states).toEqual(["connecting", "live", "reconnecting", "live", "ended"]);
  });

  it("reconnects at once when the stream's lifetime ends, and stops when another tab replaced it", async () => {
    const asked: number[] = [];
    const responses = [
      sse(['id: 3\nevent: card.moved\ndata: {}\n\nevent: closed\ndata: {"reason":"lifetime"}\n\n']),
      sse(['event: closed\ndata: {"reason":"replaced"}\n\n']),
    ];
    const states: BoardStreamState[] = [];
    let waited = 0;
    openBoardStream({
      after: 2,
      onEvent: () => undefined,
      onReset: () => undefined,
      onState: (state) => states.push(state),
      fetchStream: async (lastEventId) => {
        asked.push(lastEventId);
        return responses.shift() ?? sse([]);
      },
      wait: async () => {
        waited += 1;
      },
    });
    await settle();
    expect(asked).toEqual([2, 3]);
    expect(waited).toBe(0);
    expect(states.at(-1)).toBe("paused");
  });

  it("hands a reset to the page and does not treat it as a card event", async () => {
    let resets = 0;
    const seen: string[] = [];
    openBoardStream({
      after: 0,
      onEvent: (frame) => seen.push(frame.event),
      onReset: () => {
        resets += 1;
      },
      onState: () => undefined,
      fetchStream: async () => sse(['event: reset\ndata: {}\n\nevent: closed\ndata: {"reason":"access"}\n\n']),
      wait: async () => undefined,
    });
    await settle();
    expect(resets).toBe(1);
    expect(seen).toEqual([]);
  });

  it("stops for good on a 404, which is what Personal answers", async () => {
    let calls = 0;
    const states: BoardStreamState[] = [];
    openBoardStream({
      after: 0,
      onEvent: () => undefined,
      onReset: () => undefined,
      onState: (state) => states.push(state),
      fetchStream: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
      wait: async () => undefined,
    });
    await settle();
    expect(calls).toBe(1);
    expect(states).toEqual(["connecting", "ended"]);
  });

  it("closes without reconnecting when the page closes it", async () => {
    let calls = 0;
    const stream = openBoardStream({
      after: 0,
      onEvent: () => undefined,
      onReset: () => undefined,
      onState: () => undefined,
      fetchStream: async () => {
        calls += 1;
        return sse([]);
      },
      wait: async () => undefined,
    });
    stream.close();
    await settle();
    expect(calls).toBeLessThanOrEqual(1);
  });
});
