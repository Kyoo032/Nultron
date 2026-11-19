/**
 * A Chat run that outlives its session.
 *
 * The owner sends in one session and opens another from the rail while the reply is still
 * streaming. The composer used to keep handing that stream's deltas, tool calls and failure to the
 * pane, which by then showed the other session — the reply was drawn into the wrong conversation.
 *
 * It must not be fixed by cancelling the stream: the host aborts a run whose client goes away
 * (`packages/host/src/http-adapter.ts`, `res.on("close")`), and the reply the owner asked for would
 * never be saved. So `readRunStream` reads to the end whatever happens, and only stops *drawing*
 * once `showing()` says the run's session is no longer on screen.
 */
import { describe, expect, it } from "vitest";
import { readRunStream, type RunStreamHandlers } from "@/components/chat-composer";

function frame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A body that hands over one chunk per read and records whether it was read to the end or cancelled. */
function body(chunks: string[]) {
  const encoder = new TextEncoder();
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled];
      state.pulled += 1;
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function recorder() {
  const seen: string[] = [];
  const handlers: RunStreamHandlers = {
    onStarted: () => seen.push("started"),
    onDelta: (text) => seen.push(`delta:${text}`),
    onThinking: (text) => seen.push(`thinking:${text}`),
    onTool: (event) => seen.push(`tool:${event.phase}:${event.toolKey}`),
    onFailed: (message) => seen.push(`failed:${message}`),
  };
  return { seen, handlers };
}

describe("readRunStream", () => {
  it("replaces failed thinking even when the replacement is empty", async () => {
    const { stream } = body([
      frame("assistant.thinking", { text: "Failed attempt." }),
      frame("assistant.thinking", { text: "", replace: true }),
      frame("assistant.thinking", { text: "Final attempt." }),
    ]);
    let thinking = "";
    await readRunStream(stream, {
      onDelta: () => undefined,
      onThinking: (text, replace) => {
        thinking = replace ? text : thinking + text;
      },
    });
    expect(thinking).toBe("Final attempt.");
  });

  it("draws every event of a run whose session is on screen, in order", async () => {
    const { stream } = body([
      frame("run.started"),
      frame("assistant.thinking", { text: "hm" }),
      frame("tool.started", { toolKey: "web_search", input: { q: "x" } }),
      frame("tool.completed", { toolKey: "web_search", output: {} }),
      frame("assistant.delta", { text: "Hel" }),
      frame("assistant.delta", { text: "lo" }),
    ]);
    const { seen, handlers } = recorder();

    await readRunStream(stream, handlers);

    expect(seen).toEqual([
      "started",
      "thinking:hm",
      "tool:started:web_search",
      "tool:completed:web_search",
      "delta:Hel",
      "delta:lo",
    ]);
  });

  it("draws the closing sentence of a turn whose model call failed after a tool, as a delta and not as a failure", async () => {
    // What the host sends for that turn (`packages/host/src/runs-resilience.test.ts`): the tool frames,
    // then the closing sentence as an ordinary delta, then `run.completed`. No `run.failed`, so the pane
    // keeps the turn, and the sentence reaches the live bubble with no reload.
    const sentence =
      'The tool steps above ran, but I could not finish the answer.\n\nReason: The gateway is unavailable right now.\n\nSend "continue" and I will try again.';
    const { stream } = body([
      frame("run.started"),
      frame("tool.started", { toolKey: "read_file", input: { path: "/a.docx" } }),
      frame("tool.completed", { toolKey: "read_file", output: { ok: true } }),
      frame("assistant.delta", { text: sentence }),
      frame("run.completed", { runId: "r1" }),
    ]);
    const { seen, handlers } = recorder();

    await readRunStream(stream, handlers);

    expect(seen).toEqual(["started", "tool:started:read_file", "tool:completed:read_file", `delta:${sentence}`]);
  });

  it("reports the run's own failure", async () => {
    const { stream } = body([frame("run.failed", { message: "Model refused" })]);
    const { seen, handlers } = recorder();

    await readRunStream(stream, handlers);

    expect(seen).toEqual(["failed:Model refused"]);
  });

  it("joins a frame split across two reads", async () => {
    const whole = frame("assistant.delta", { text: "split" });
    const { stream } = body([whole.slice(0, 12), whole.slice(12)]);
    const { seen, handlers } = recorder();

    await readRunStream(stream, handlers);

    expect(seen).toEqual(["delta:split"]);
  });

  it("stops drawing once another session is on screen, and still reads the stream to the end", async () => {
    const chunks = [
      frame("assistant.delta", { text: "first" }),
      frame("assistant.delta", { text: "second" }),
      frame("tool.started", { toolKey: "image_generate" }),
      frame("run.failed", { message: "late failure" }),
    ];
    const { stream, state } = body(chunks);
    const { seen, handlers } = recorder();
    let onScreen = true;
    const drawing: RunStreamHandlers = {
      ...handlers,
      onDelta: (text) => {
        handlers.onDelta(text);
        // The owner opens another session right after the first delta lands.
        onScreen = false;
      },
    };

    await readRunStream(stream, drawing, { showing: () => onScreen });

    expect(seen).toEqual(["delta:first"]);
    // Every chunk was pulled and the body was never cancelled: the host is left to finish the run.
    expect(state.pulled).toBe(chunks.length + 1);
    expect(state.cancelled).toBe(false);
  });

  it("keeps the stall watchdog fed for a run it has stopped drawing", async () => {
    const { stream } = body([frame("assistant.delta", { text: "a" }), frame("assistant.delta", { text: "b" })]);
    const { handlers } = recorder();
    let activity = 0;

    await readRunStream(stream, handlers, { showing: () => false, onActivity: () => (activity += 1) });

    expect(activity).toBe(2);
  });
});

describe("run.model_fallback", () => {
  // The host answers a turn whose model could not be reached with the next live model, and says so once
  // before the reply (`packages/host/src/runs.ts`, `announceFallback`). The pane must get that, or the
  // person reads an answer from a model they did not pick with no word about it.
  it("hands the stand-in to the pane once, with both models and the host's sentence", async () => {
    const sentence = "gpt-6-luna is unavailable; used glm-5.3 for this answer.";
    const { stream } = body([
      frame("run.started"),
      frame("run.model_fallback", { from: "gpt-6-luna", to: "glm-5.3", message: sentence }),
      frame("assistant.delta", { text: "Hi" }),
      frame("run.completed", { runId: "r" }),
    ]);
    const { handlers } = recorder();
    const fallbacks: unknown[] = [];

    await readRunStream(stream, { ...handlers, onModelFallback: (event) => fallbacks.push(event) });

    expect(fallbacks).toEqual([{ from: "gpt-6-luna", to: "glm-5.3", message: sentence }]);
  });

  it("hands a tier run's fallback with no models, so the notice shows the host's sentence alone", async () => {
    // A tier run's fallback names no models (model tiers spec, section 5). The event still reaches the
    // pane, which draws `message` instead of a from-to line.
    const sentence = "This tier's model was unavailable; another model of the same tier answered.";
    const { stream } = body([
      frame("run.started"),
      frame("run.model_fallback", { message: sentence }),
      frame("assistant.delta", { text: "Hi" }),
      frame("run.completed", { runId: "r" }),
    ]);
    const { handlers } = recorder();
    const fallbacks: unknown[] = [];

    await readRunStream(stream, { ...handlers, onModelFallback: (event) => fallbacks.push(event) });

    expect(fallbacks).toEqual([{ from: "", to: "", message: sentence }]);
  });

  it("does not draw a stand-in into a session the owner has left", async () => {
    const { stream } = body([frame("run.model_fallback", { from: "gpt-6-luna", to: "glm-5.3", message: "m" })]);
    const { handlers } = recorder();
    const fallbacks: unknown[] = [];

    await readRunStream(
      stream,
      { ...handlers, onModelFallback: (event) => fallbacks.push(event) },
      {
        showing: () => false,
      },
    );

    expect(fallbacks).toEqual([]);
  });
});

describe("run.completed", () => {
  it("tells the pane the run is over before the stream closes, and still reads to the end", async () => {
    const { stream, state } = body([frame("assistant.delta", { text: "hi" }), frame("run.completed", { runId: "r" })]);
    const seen: string[] = [];
    await readRunStream(stream, {
      onDelta: (text) => seen.push(`delta:${text}`),
      onCompleted: () => seen.push(`completed:pulled=${state.pulled}`),
    });
    expect(seen[0]).toBe("delta:hi");
    // Heard on the second chunk, before the read that sees the stream end.
    expect(seen[1]).toBe("completed:pulled=2");
    expect(state.cancelled).toBe(false);
  });
});

describe("tool.progress", () => {
  const progress = (job: Record<string, unknown>, toolKey = "research_dossier") =>
    frame("tool.progress", { toolKey, job });

  function progressRecorder() {
    const lines: { toolKey: string; label: string }[] = [];
    const handlers: RunStreamHandlers = { onDelta: () => {}, onToolProgress: (event) => lines.push(event) };
    return { lines, handlers };
  }

  it("hands the pane the label of a phase, a step and a round, and nothing else", async () => {
    const { stream } = body([
      frame("tool.started", { toolKey: "research_dossier" }),
      progress({ type: "job.phase", phase: "searching", label: "Searching the web" }),
      progress({ type: "job.delta", text: "partial prose" }),
      progress({ type: "job.step", phase: "reading", label: "Reading source 2 of 5" }),
      progress({ type: "job.round", round: 1, total: 2, label: "Checking round 1" }),
      progress({ type: "job.source", id: "s", title: "t", url: "https://example.com", status: "found" }),
      frame("tool.completed", { toolKey: "research_dossier", output: {} }),
      frame("run.completed", { runId: "r" }),
    ]);
    const { lines, handlers } = progressRecorder();

    await readRunStream(stream, handlers);

    expect(lines).toEqual([
      { toolKey: "research_dossier", label: "Searching the web" },
      { toolKey: "research_dossier", label: "Reading source 2 of 5" },
      { toolKey: "research_dossier", label: "Checking round 1" },
    ]);
  });

  it("ignores a progress event that has no usable label or tool", async () => {
    const { stream } = body([
      progress({ type: "job.phase", phase: "searching", label: "   " }),
      progress({ type: "job.phase", phase: "searching" }),
      progress({ type: "job.phase", phase: "searching", label: 4 }),
      frame("tool.progress", { job: { type: "job.phase", label: "No tool key" } }),
      frame("tool.progress", { toolKey: "research_dossier" }),
    ]);
    const { lines, handlers } = progressRecorder();

    await readRunStream(stream, handlers);

    expect(lines).toEqual([]);
  });

  it("reads one run end to end: one progress line, and the watchdog fed for all five events", async () => {
    const { stream } = body([
      frame("tool.started", { toolKey: "research_dossier" }),
      progress({ type: "job.phase", phase: "searching", label: "Searching" }),
      progress({ type: "job.delta", text: "x" }),
      frame("tool.completed", { toolKey: "research_dossier", output: {} }),
      frame("run.completed", { runId: "r" }),
    ]);
    const { lines, handlers } = progressRecorder();
    let activity = 0;

    await readRunStream(stream, handlers, { onActivity: () => (activity += 1) });

    expect(lines).toEqual([{ toolKey: "research_dossier", label: "Searching" }]);
    expect(activity).toBe(5);
  });

  it("works with no progress handler", async () => {
    const { stream } = body([progress({ type: "job.phase", phase: "searching", label: "Searching" })]);
    const { seen, handlers } = recorder();
    let activity = 0;

    await readRunStream(stream, handlers, { onActivity: () => (activity += 1) });

    expect(seen).toEqual([]);
    expect(activity).toBe(1);
  });

  it("stops drawing progress once another session is on screen", async () => {
    const { stream } = body([progress({ type: "job.phase", phase: "searching", label: "Searching" })]);
    const { lines, handlers } = progressRecorder();

    await readRunStream(stream, handlers, { showing: () => false });

    expect(lines).toEqual([]);
  });
});
