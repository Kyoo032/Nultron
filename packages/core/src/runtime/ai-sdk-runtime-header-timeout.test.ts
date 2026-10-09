import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import { HEADERS_TIMEOUT_MS, STREAM_IDLE_MS, formatHeadersTimeoutError } from "./stream-watchdog";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import { defineTool } from "../tools/define-tool";
import { registerTool, resetToolRegistry } from "../tools/registry";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

/**
 * How long a model request may take to send its response headers, through the real AI SDK with `fetch`
 * replaced by one that answers after a chosen time and honours the request's own abort, like the real one.
 *
 * Measured 2026-10-07 on a diagnostic server with the old 10 s limit stretched, Thinking Off, gpt-6-luna:
 * a Word file turn made two gateway calls, each returned HTTP 200 and each took about 15.1 s to send
 * its headers (15 146 ms and 15 135 ms). With the 10 s limit the same turn was cut three times in a row.
 */

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const version: AgentVersionRecord = {
  id: "v-header-timeout",
  agentId: "chat",
  organizationId: "org",
  version: 1,
  systemPrompt: "You are helpful.",
  model: "gpt-6-luna",
  inputModalities: ["text"],
  config: {},
  createdAt: new Date(),
};

/** What the gateway took to send headers in the 2026-10-07 drive. */
const MEASURED_HEADERS_MS = 15_150;

const encoder = new TextEncoder();

function frame(delta: Record<string, unknown>, finish: string | null = null) {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage } : {}),
  };
}

function sse(frames: unknown[]): Response {
  const body = `${frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const textStream = (text: string) => sse([frame({ role: "assistant", content: text }), frame({}, "stop")]);

const toolStream = () =>
  sse([
    frame({
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: '{"x":1}' } }],
    }),
    frame({}, "tool_calls"),
  ]);

/**
 * A gateway that sends headers `delayMs` after each request starts (never, for `undefined`). Like the real
 * `fetch`, it rejects with the abort's reason when the request is cancelled before that.
 */
function gatewayAnsweringAfter(delayMs: number | undefined, reply: (request: number) => Response) {
  const starts: number[] = [];
  vi.stubGlobal(
    "fetch",
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        starts.push(Date.now());
        const request = starts.length;
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (delayMs !== undefined) {
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(reply(request));
          }, delayMs);
        }
      }),
  );
  return starts;
}

function binding(toolKey: string): ToolBindingRecord {
  return { id: `b-${toolKey}`, agentVersionId: "v", organizationId: "org", toolKey, config: {}, enabled: true };
}

type Outcome = { events: RuntimeEvent[]; failed: unknown; elapsedMs: number };

/** Starts a Thinking-Off Chat turn and advances the fake clock until it ends, to the millisecond that it ended. */
async function runTurn(options: { tools?: string[]; locale?: "en" | "id" } = {}): Promise<Outcome> {
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  let ended = false;
  const startedAt = Date.now();
  const turn = new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" })
    .execute({
      tenant,
      runId: "run-header-timeout",
      modality: "text",
      version,
      bindings: (options.tools ?? []).map(binding),
      history: [{ role: "user", parts: [{ type: "text", text: "Read my file." }] }],
      thinking: false,
      reasoningEffort: "none",
      reasoningEffortExplicit: true,
      wire: "chat_completions",
      ...(options.locale ? { locale: options.locale } : {}),
      onEvent: (event) => {
        events.push(event);
      },
    })
    .catch((error: unknown) => {
      failed = error;
    })
    .finally(() => {
      ended = true;
    });
  let elapsedMs = 0;
  while (!ended && elapsedMs < 5 * 60_000) {
    await vi.advanceTimersByTimeAsync(250);
    elapsedMs += 250;
  }
  await turn;
  return { events, failed, elapsedMs: Date.now() - startedAt };
}

const types = (events: RuntimeEvent[]) => events.map((event) => event.type);

beforeEach(() => {
  vi.useFakeTimers();
  resetLearnedEffortLimits();
  resetToolRegistry();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
  resetToolRegistry();
});

describe("the wait for a model request's response headers", () => {
  it("is longer than the 15 s a real gateway took, and shorter than the idle watchdog that runs on a follow-up call", () => {
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(MEASURED_HEADERS_MS * 2);
    // After a tool the stream watchdog is already in its idle budget. This limit has to fire before it,
    // or the person would be told "no stream events" and never "no response".
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(STREAM_IDLE_MS);
  });

  it("lets a gateway that answers 200 after 15 s answer, with one request and no retry", async () => {
    const starts = gatewayAnsweringAfter(MEASURED_HEADERS_MS, () => textStream("Here is the summary."));
    const { events, failed } = await runTurn();

    expect(failed).toBeUndefined();
    expect(starts).toHaveLength(1);
    expect(types(events)).not.toContain("run.failed");
    expect(events.filter((event) => event.type === "run.probing")).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant.delta" && event.text.includes("summary"))).toBe(true);
    expect(types(events)).toContain("run.completed");
  });

  it("applies per request, so a tool turn whose two calls each take 15 s completes", async () => {
    registerTool(
      defineTool({
        key: "echo",
        name: "echo",
        description: "echo tool",
        schema: z.object({ x: z.number() }),
        execute: async ({ x }) => ({ echoed: x }),
      }),
    );
    const starts = gatewayAnsweringAfter(MEASURED_HEADERS_MS, (request) =>
      request === 1 ? toolStream() : textStream("The file says hello."),
    );
    const { events, failed, elapsedMs } = await runTurn({ tools: ["echo"] });

    expect(failed).toBeUndefined();
    expect(starts).toHaveLength(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(MEASURED_HEADERS_MS * 2);
    expect(types(events)).toContain("tool.completed");
    expect(types(events)).not.toContain("run.interrupted");
    expect(events.some((event) => event.type === "assistant.delta" && event.text.includes("hello"))).toBe(true);
  });

  describe("when the gateway never answers", () => {
    it("waits once, for the full limit, and then stops: no second try against the same silent call", async () => {
      const starts = gatewayAnsweringAfter(undefined, () => textStream("never"));
      const { events, failed, elapsedMs } = await runTurn();

      expect(failed).toBeInstanceOf(Error);
      expect(starts).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.probing")).toHaveLength(1);
      // Not before the limit, and not much after it.
      expect(elapsedMs).toBeGreaterThanOrEqual(HEADERS_TIMEOUT_MS);
      expect(elapsedMs).toBeLessThanOrEqual(HEADERS_TIMEOUT_MS + 1_000);
      const failure = events.find((event) => event.type === "run.failed");
      expect(failure).toMatchObject({
        type: "run.failed",
        message: formatHeadersTimeoutError("gpt-6-luna", HEADERS_TIMEOUT_MS, "en"),
      });
    });

    it("says so in Bahasa Indonesia on an Indonesian desk", async () => {
      gatewayAnsweringAfter(undefined, () => textStream("never"));
      const { events } = await runTurn({ locale: "id" });
      const failure = events.find((event) => event.type === "run.failed");
      expect(failure).toMatchObject({
        message: formatHeadersTimeoutError("gpt-6-luna", HEADERS_TIMEOUT_MS, "id"),
      });
      expect((failure as { message: string }).message).toMatch(/Tidak ada respons dalam 45 detik/);
    });

    it("tells a person who sent a tool turn that the tools ran, when only the follow-up call goes silent", async () => {
      registerTool(
        defineTool({
          key: "echo",
          name: "echo",
          description: "echo tool",
          schema: z.object({ x: z.number() }),
          execute: async ({ x }) => ({ echoed: x }),
        }),
      );
      // The first call answers at once; the follow-up after the tool never does.
      const starts: number[] = [];
      vi.stubGlobal(
        "fetch",
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            starts.push(Date.now());
            if (starts.length === 1) {
              resolve(toolStream());
              return;
            }
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      );
      const { events, failed, elapsedMs } = await runTurn({ tools: ["echo"] });

      expect(failed).toBeUndefined();
      expect(starts).toHaveLength(2);
      expect(elapsedMs).toBeGreaterThanOrEqual(HEADERS_TIMEOUT_MS);
      expect(elapsedMs).toBeLessThanOrEqual(HEADERS_TIMEOUT_MS + 1_000);
      expect(events.find((event) => event.type === "run.interrupted")).toMatchObject({
        message: formatHeadersTimeoutError("gpt-6-luna", HEADERS_TIMEOUT_MS, "en"),
      });
      expect(types(events)).not.toContain("run.failed");
      expect(types(events)).toContain("run.completed");
    });
  });
});
