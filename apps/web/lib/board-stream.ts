/**
 * The board's live stream, `GET /api/v1/board/events` (team-board-spec.md sections 8.1 and 8.2).
 *
 * Read with `fetch`, not `EventSource`: the hosted app's requests go through `apiFetch` (one place
 * for the 401 and plan signals), and `fetch` can send `Last-Event-ID` on the first connect too, so
 * the stream starts exactly after the snapshot the page drew.
 *
 * What the host may send besides card events:
 *   - `reset`: the browser was more than 1000 events behind; reload the board.
 *   - `closed` with `reason`:
 *       `lifetime`: the stream's 15 minutes are up; reconnect at once from the last id.
 *       `replaced`: this person opened more streams than the cap; this one was the oldest. Do not
 *                   reconnect on our own, or two tabs would evict each other forever.
 *       `access`:   the session ended or the person left the company. Stop.
 * A dropped connection reconnects from the last id with a growing wait.
 */
import { apiFetch } from "./api-client";

export type BoardFrame = { id: number | null; event: string; data: Record<string, unknown> };

export type BoardStreamState = "connecting" | "live" | "reconnecting" | "paused" | "ended";

/** Split a buffer into whole SSE frames. Comment frames (`: hb`, `: open`) carry no event and are dropped. */
export function parseBoardFrames(buffer: string): { frames: BoardFrame[]; rest: string } {
  const normalised = buffer.replace(/\r\n/g, "\n");
  const parts = normalised.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: BoardFrame[] = [];
  for (const part of parts) {
    let id: number | null = null;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("id:")) {
        const value = Number(line.slice(3).trim());
        id = Number.isSafeInteger(value) && value >= 0 ? value : null;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trim());
      }
    }
    if (!event) {
      continue;
    }
    let parsed: unknown = {};
    try {
      parsed = data.length > 0 ? JSON.parse(data.join("\n")) : {};
    } catch {
      parsed = {};
    }
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    frames.push({ id, event, data: record });
  }
  return { frames, rest };
}

/** The wait before reconnect attempt `attempt` (1-based): 1 s, 2 s, 4 s ... up to 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export type BoardStreamOptions = {
  /** The snapshot's cursor: the stream starts after it. */
  readonly after: number;
  readonly onEvent: (frame: BoardFrame) => void;
  readonly onReset: () => void;
  readonly onState: (state: BoardStreamState) => void;
  /** Test seam. */
  readonly fetchStream?: (lastEventId: number, signal: AbortSignal) => Promise<Response>;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function defaultFetch(lastEventId: number, signal: AbortSignal): Promise<Response> {
  return apiFetch("/api/v1/board/events", {
    headers: { "Last-Event-ID": String(lastEventId), Accept: "text/event-stream" },
    signal,
  });
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type Outcome = "dropped" | "lifetime" | "replaced" | "access" | "refused";

/**
 * Open the stream and keep it open. Returns `close`, which ends it for good. `onState` reports what
 * the page should show: live, reconnecting after a drop, paused (replaced by another tab), or ended.
 */
export function openBoardStream(options: BoardStreamOptions): { close: () => void } {
  const controller = new AbortController();
  const fetchStream = options.fetchStream ?? defaultFetch;
  const wait = options.wait ?? defaultWait;
  let cursor = options.after;
  /** Set when a connect reached the stream, so the next drop starts the backoff over. */
  let reached = false;

  async function readOnce(): Promise<Outcome> {
    let res: Response;
    try {
      res = await fetchStream(cursor, controller.signal);
    } catch {
      return "dropped";
    }
    const type = res.headers.get("Content-Type") ?? "";
    if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return res.status === 401 || res.status === 403 || res.status === 404 ? "refused" : "dropped";
    }
    options.onState("live");
    reached = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return "dropped";
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseBoardFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          if (frame.event === "closed") {
            const reason = frame.data.reason;
            return reason === "lifetime" || reason === "replaced" || reason === "access" ? reason : "dropped";
          }
          if (frame.event === "reset") {
            options.onReset();
            continue;
          }
          if (frame.id !== null) {
            cursor = frame.id;
          }
          options.onEvent(frame);
        }
      }
    } catch {
      return "dropped";
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async function run(): Promise<void> {
    let attempt = 0;
    options.onState("connecting");
    while (!controller.signal.aborted) {
      const outcome = await readOnce();
      if (controller.signal.aborted) {
        return;
      }
      if (outcome === "replaced") {
        options.onState("paused");
        return;
      }
      if (outcome === "access" || outcome === "refused") {
        options.onState("ended");
        return;
      }
      if (outcome === "lifetime") {
        attempt = 0;
        continue;
      }
      attempt = reached ? 1 : attempt + 1;
      reached = false;
      options.onState("reconnecting");
      await wait(reconnectDelayMs(attempt), controller.signal);
    }
  }

  void run();
  return { close: () => controller.abort() };
}
