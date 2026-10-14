/**
 * `writeHostResult` and a slow reader (security review of K0, L8): while the socket's buffer is full, a
 * heartbeat is dropped and an event waits for `drain`, so a stalled client never makes the host queue
 * frames without bound. The response is a small fake: what matters here is the order of writes against
 * `drain`, which a real socket cannot be made to show on demand.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { writeHostResult } from "../http-adapter";
import type { HostStreamResult } from "../types";

class SlowResponse extends EventEmitter {
  statusCode = 0;
  writableNeedDrain = false;
  destroyed = false;
  ended = false;
  readonly log: string[] = [];
  setHeader(): void {}
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.log.push(`write ${chunk.trim()}`);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

function stream(chunks: AsyncGenerator<string>): HostStreamResult {
  return { type: "stream", status: 200, events: chunks };
}

describe("writeHostResult backpressure on the event stream", () => {
  it("drops a heartbeat while the buffer is full and holds an event until drain", async () => {
    const res = new SlowResponse();
    async function* frames() {
      yield "event: first\n\n";
      res.writableNeedDrain = true;
      yield ": hb\n\n";
      yield "event: second\n\n";
    }
    const writing = writeHostResult(res as unknown as ServerResponse, stream(frames()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(res.log).toEqual(["write event: first"]);

    res.log.push("drain");
    res.writableNeedDrain = false;
    res.emit("drain");
    await writing;

    expect(res.log).toEqual(["write event: first", "drain", "write event: second"]);
    expect(res.ended).toBe(true);
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("stops waiting when the client hangs up", async () => {
    const res = new SlowResponse();
    async function* frames() {
      res.writableNeedDrain = true;
      yield "event: stuck\n\n";
    }
    const writing = writeHostResult(res as unknown as ServerResponse, stream(frames()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(res.log).toEqual([]);
    res.emit("close");
    await writing;
    expect(res.ended).toBe(true);
  });

  it("never waits on a socket that is already destroyed", async () => {
    const res = new SlowResponse();
    res.destroyed = true;
    res.writableNeedDrain = true;
    async function* frames() {
      yield "event: late\n\n";
    }
    await writeHostResult(res as unknown as ServerResponse, stream(frames()));
    expect(res.log).toEqual(["write event: late"]);
  });
});
