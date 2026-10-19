import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVersionRecord } from "../agents/service";
import type { TenantContext } from "../tenancy/types";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { RuntimeEvent } from "./types";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

function versionFor(model: string): AgentVersionRecord {
  return {
    id: `v-${model}`,
    agentId: "chat",
    organizationId: "org",
    version: 1,
    systemPrompt: "You are helpful.",
    model,
    inputModalities: ["text"],
    config: {},
    createdAt: new Date(),
  };
}

type SseEvent = { event: string; data: Record<string, unknown> };

function sse(events: SseEvent[]): Response {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const messageStart: SseEvent = {
  event: "message_start",
  data: { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
};

function thinkingBlock(index: number, thinking: string[], signature: string): SseEvent[] {
  return [
    { event: "content_block_start", data: { index, content_block: { type: "thinking", thinking: "", signature: "" } } },
    ...thinking.map((text) => ({ event: "content_block_delta", data: { index, delta: { type: "thinking_delta", thinking: text } } })),
    { event: "content_block_delta", data: { index, delta: { type: "signature_delta", signature } } },
    { event: "content_block_stop", data: { index } },
  ];
}

function textBlock(index: number, text: string): SseEvent[] {
  return [
    { event: "content_block_start", data: { index, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { index, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { index } },
  ];
}

const messageEnd: SseEvent[] = [
  { event: "message_delta", data: { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } } },
  { event: "message_stop", data: {} },
];

function gatewayAnswering(events: SseEvent[]): void {
  vi.stubGlobal("fetch", async () => sse(events));
}

async function chat(): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
    tenant,
    runId: "run-anthropic-signature",
    modality: "text",
    version: versionFor("claude-sonnet-5-5"),
    bindings: [],
    history: [{ role: "user", parts: [{ type: "text", text: "Halo, jelaskan secara singkat apa itu HYP AI." }] }],
    reasoningEffort: "medium",
    reasoningEffortExplicit: true,
    onEvent: (event) => {
      events.push(event);
    },
  });
  return events;
}

function answerOf(events: RuntimeEvent[]): string {
  return events.map((event) => (event.type === "assistant.delta" ? event.text : "")).join("");
}

beforeEach(() => {
  resetLearnedEffortLimits();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
});

describe("Claude on Messages with Thinking on", () => {
  it("answers when a thinking block carries a signature and no thinking text", async () => {
    gatewayAnswering([messageStart, ...thinkingBlock(0, [], "sig-empty"), ...textBlock(1, "HYP AI adalah ruang kerja AI."), ...messageEnd]);
    const events = await chat();
    expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
    expect(answerOf(events)).toBe("HYP AI adalah ruang kerja AI.");
  });

  it("answers when two thinking blocks arrive and the second has no thinking text", async () => {
    gatewayAnswering([
      messageStart,
      ...thinkingBlock(0, ["Plan the answer."], "sig-1"),
      ...thinkingBlock(1, [], "sig-2"),
      ...textBlock(2, "Siap."),
      ...messageEnd,
    ]);
    const events = await chat();
    expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
    expect(answerOf(events)).toBe("Siap.");
  });

  it("still streams the thinking text of a block that has it", async () => {
    gatewayAnswering([messageStart, ...thinkingBlock(0, ["Plan ", "the answer."], "sig-1"), ...textBlock(1, "Siap."), ...messageEnd]);
    const events = await chat();
    const thinking = events.map((event) => (event.type === "assistant.thinking" ? event.text : "")).join("");
    expect(thinking).toBe("Plan the answer.");
    expect(answerOf(events)).toBe("Siap.");
  });
});
