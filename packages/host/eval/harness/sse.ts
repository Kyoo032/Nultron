/**
 * Server-sent events, read the way the host writes them (`encodeSse` in `packages/core/src/sse.ts`):
 * `event: <type>\ndata: <json>\n\n`, with a `: connected` comment first so headers flush.
 *
 * The renderer's own reader (`apps/web/lib/sse-client.ts`) is not reused: it drops a frame it cannot
 * parse without saying so, and this tool has to count those. Chunks arrive split anywhere, including
 * between the `\r` and `\n` of a line end, so the parser holds a trailing `\r` back until it knows.
 */

export type SseFrame = { event: string; data: string };

/** One decoded frame. `type` is the payload's own `type`, else the `event:` line. */
export type StreamEvent = { type: string } & Record<string, unknown>;

function parseFrame(text: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

export class SseParser {
  private buffer = "";

  /** Feed a decoded chunk; returns the frames it completed. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const heldBack = this.buffer.endsWith("\r") ? "\r" : "";
    const ready = (heldBack ? this.buffer.slice(0, -1) : this.buffer).replace(/\r\n?/g, "\n");
    const parts = ready.split("\n\n");
    this.buffer = (parts.pop() ?? "") + heldBack;
    return parts.flatMap((part) => parseFrame(part) ?? []);
  }

  /** The stream ended: a last frame with no closing blank line still counts. */
  flush(): SseFrame[] {
    const rest = this.buffer.replace(/\r\n?/g, "\n");
    this.buffer = "";
    const frame = parseFrame(rest);
    return frame ? [frame] : [];
  }
}

/** The payload as an event, or null when it is not a JSON object (the caller counts those). */
export function decodeFrame(frame: SseFrame): StreamEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const type = typeof record.type === "string" && record.type ? record.type : frame.event;
  return { ...record, type };
}

/** Everything a finished stream said: the decoded events in order, and how many frames were not JSON. */
export function readFrames(frames: readonly SseFrame[]): { events: StreamEvent[]; malformed: number } {
  const events: StreamEvent[] = [];
  let malformed = 0;
  for (const frame of frames) {
    const event = decodeFrame(frame);
    if (event) {
      events.push(event);
    } else {
      malformed += 1;
    }
  }
  return { events, malformed };
}
