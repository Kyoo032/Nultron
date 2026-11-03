import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import type { ContentPart } from "../content/types";
import type { ReasoningEffort } from "../models/reasoning-effort";
import type { TenantContext } from "../tenancy/types";
import { defineTool } from "../tools/define-tool";
import { registerTool, resetToolRegistry } from "../tools/registry";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { RuntimeEvent } from "./types";

const GOLDEN_URL = new URL("./__fixtures__/runtime-recording-golden.json", import.meta.url);
const RECORD = process.env.RECORD_RUNTIME_GOLDEN === "1";
const GATEWAY = "https://gateway.test/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

type Reply = () => Response;
type Recorded = { url: string; body: unknown };
type Recording = { requests: Recorded[]; events: RuntimeEvent[]; threw: string | null };
type Scenario = {
  model: string;
  baseUrl?: string;
  tools?: string[];
  reasoningEffort?: ReasoningEffort;
  thinking?: boolean;
  history?: Array<{ role: "user" | "assistant"; parts: ContentPart[] }>;
  replies: Reply[];
};

const encoder = new TextEncoder();

function stream(body: string): Response {
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function httpError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatFrame(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } : {}),
  };
}

function chatStream(frames: unknown[], done = true): Reply {
  return () => stream(`${frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`);
}

function chatText(...chunks: string[]): Reply {
  return chatStream([
    chatFrame({ role: "assistant", content: "" }),
    ...chunks.map((content) => chatFrame({ content })),
    chatFrame({}, "stop"),
  ]);
}

function chatToolCall(id: string, name: string, args: string): Reply {
  return chatStream([
    chatFrame({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }),
    chatFrame({}, "tool_calls"),
  ]);
}

function namedStream(events: Array<{ event: string; data: Record<string, unknown> }>): Reply {
  return () =>
    stream(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join(""));
}

const responseCreated = {
  event: "response.created",
  data: { response: { id: "resp_1", object: "response", created_at: 1, model: "gpt-5.6", status: "in_progress" } },
};

function responseCompleted(): { event: string; data: Record<string, unknown> } {
  return {
    event: "response.completed",
    data: {
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "gpt-5.6",
        status: "completed",
        incomplete_details: null,
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
  };
}

function responsesReasoning(itemId: string, summary: string) {
  return [
    {
      event: "response.output_item.added",
      data: { output_index: 0, item: { type: "reasoning", id: itemId, summary: [] } },
    },
    {
      event: "response.reasoning_summary_part.added",
      data: { item_id: itemId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
    },
    {
      event: "response.reasoning_summary_text.delta",
      data: { item_id: itemId, output_index: 0, summary_index: 0, delta: summary },
    },
    {
      event: "response.output_item.done",
      data: { output_index: 0, item: { type: "reasoning", id: itemId, summary: [{ type: "summary_text", text: summary }] } },
    },
  ];
}

function responsesText(itemId: string, outputIndex: number, text: string) {
  return [
    {
      event: "response.output_item.added",
      data: { output_index: outputIndex, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } },
    },
    {
      event: "response.output_text.delta",
      data: { item_id: itemId, output_index: outputIndex, content_index: 0, delta: text },
    },
    {
      event: "response.output_item.done",
      data: {
        output_index: outputIndex,
        item: {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      },
    },
  ];
}

function responsesCall(itemId: string, outputIndex: number, callId: string, name: string, args: string) {
  return [
    {
      event: "response.output_item.added",
      data: {
        output_index: outputIndex,
        item: { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" },
      },
    },
    {
      event: "response.function_call_arguments.delta",
      data: { item_id: itemId, output_index: outputIndex, delta: args },
    },
    {
      event: "response.output_item.done",
      data: {
        output_index: outputIndex,
        item: { type: "function_call", id: itemId, call_id: callId, name, arguments: args, status: "completed" },
      },
    },
  ];
}

const messageStart = {
  event: "message_start",
  data: {
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [],
      usage: { input_tokens: 31, output_tokens: 0 },
    },
  },
};

function messageEnd(stop: string) {
  return [
    { event: "message_delta", data: { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } } },
    { event: "message_stop", data: {} },
  ];
}

function anthropicThinking(index: number, text: string, signature: string) {
  return [
    { event: "content_block_start", data: { index, content_block: { type: "thinking", thinking: "", signature: "" } } },
    { event: "content_block_delta", data: { index, delta: { type: "thinking_delta", thinking: text } } },
    { event: "content_block_delta", data: { index, delta: { type: "signature_delta", signature } } },
    { event: "content_block_stop", data: { index } },
  ];
}

function anthropicText(index: number, text: string) {
  return [
    { event: "content_block_start", data: { index, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { index, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { index } },
  ];
}

function anthropicToolUse(index: number, id: string, name: string, args: string) {
  return [
    { event: "content_block_start", data: { index, content_block: { type: "tool_use", id, name, input: {} } } },
    { event: "content_block_delta", data: { index, delta: { type: "input_json_delta", partial_json: args } } },
    { event: "content_block_stop", data: { index } },
  ];
}

function geminiStream(chunks: unknown[]): Reply {
  return () => stream(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));
}

function geminiChunk(parts: unknown[], finish?: string): Record<string, unknown> {
  return {
    candidates: [{ content: { parts, role: "model" }, index: 0, ...(finish ? { finishReason: finish } : {}) }],
    ...(finish ? { usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 5, totalTokenCount: 22 } } : {}),
  };
}

function registerTools(): void {
  resetToolRegistry();
  registerTool(
    defineTool({
      key: "echo",
      name: "Echo",
      description: "Echo a number.",
      schema: z.object({ x: z.number() }),
      execute: async ({ x }) => ({ echoed: x }),
    }),
  );
  registerTool(
    defineTool({
      key: "probe",
      name: "Probe",
      description: "Exercise every schema feature the tools use.",
      schema: z.object({
        query: z.string().min(1).max(200).describe("What to look up"),
        limit: z.number().int().min(1).max(50).default(10),
        mode: z.enum(["fast", "deep"]).optional(),
        shots: z.union([z.literal(4), z.literal(6)]).optional(),
        tags: z.array(z.string()).max(5).default([]),
        filters: z
          .array(z.object({ field: z.string(), value: z.string().nullable() }))
          .max(3)
          .optional(),
        weights: z.record(z.string(), z.number()).optional(),
        nested: z.object({ on: z.boolean().default(false), label: z.string().optional() }).optional(),
        session_id: z.string().uuid().optional(),
        url: z.string().url().optional(),
      }),
      execute: async (input) => ({ received: input }),
    }),
  );
}

function binding(toolKey: string): ToolBindingRecord {
  return { id: `b-${toolKey}`, agentVersionId: "v", organizationId: "org", toolKey, config: {}, enabled: true };
}

function versionFor(model: string): AgentVersionRecord {
  return {
    id: `v-${model}`,
    agentId: "chat",
    organizationId: "org",
    version: 1,
    systemPrompt: "You are helpful.",
    model,
    inputModalities: ["text", "image"],
    config: {},
    createdAt: new Date(0),
  };
}

const SAY_HI: Scenario["history"] = [{ role: "user", parts: [{ type: "text", text: "Say hi." }] }];

const SCENARIOS: Record<string, Scenario> = {
  "chat text, two turns of history": {
    model: "deepseek-v4-flash",
    history: [
      { role: "user", parts: [{ type: "text", text: "Remember 7." }] },
      { role: "assistant", parts: [{ type: "text", text: "Noted: 7." }] },
      { role: "user", parts: [{ type: "text", text: "What number?" }] },
    ],
    replies: [chatText("It ", "was 7.")],
  },
  "chat tools, explicit high effort": {
    model: "deepseek-v4-flash",
    tools: ["probe", "echo"],
    reasoningEffort: "high",
    history: SAY_HI,
    replies: [
      chatToolCall("call_probe", "probe", JSON.stringify({ query: "tides", nested: {}, filters: [{ field: "a", value: null }] })),
      chatText("Done."),
    ],
  },
  "chat repairs a call to an unknown tool": {
    model: "deepseek-v4-flash",
    tools: ["echo"],
    history: SAY_HI,
    replies: [chatToolCall("call_nope", "nope", "{}"), chatToolCall("call_echo", "echo", '{"x":3}'), chatText("Three.")],
  },
  "chat reasoning_content deltas": {
    model: "deepseek-v4-flash",
    reasoningEffort: "medium",
    history: SAY_HI,
    replies: [
      chatStream([
        chatFrame({ role: "assistant", content: "", reasoning_content: "Thinking it over." }),
        chatFrame({ content: "Hi." }),
        chatFrame({}, "stop"),
      ]),
    ],
  },
  "minimax think tags and reasoning_details": {
    model: "minimax-m3",
    history: SAY_HI,
    replies: [
      chatStream([
        chatFrame({ role: "assistant", content: "", reasoning_details: [{ text: "Plan a greeting." }] }),
        chatFrame({ content: "<think>more</think>Hello!" }),
        chatFrame({}, "stop"),
      ]),
    ],
  },
  "openrouter zero retention": {
    model: "glm-5",
    baseUrl: OPENROUTER,
    history: SAY_HI,
    replies: [chatText("Hi from OpenRouter.")],
  },
  "chat image in history": {
    model: "gpt-4o",
    history: [
      {
        role: "user",
        parts: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ],
    replies: [chatText("A pixel.")],
  },
  "chat HTTP 400": {
    model: "deepseek-v4-flash",
    history: SAY_HI,
    replies: [() => httpError(400, "Bad request: unsupported thing."), () => httpError(400, "Bad request: unsupported thing.")],
  },
  "chat error frame mid-stream": {
    model: "deepseek-v4-flash",
    history: SAY_HI,
    replies: [
      chatStream([chatFrame({ role: "assistant", content: "Partial " }), { error: { message: "upstream overloaded", type: "server_error" } }]),
    ],
  },
  "responses tools with reasoning summary": {
    model: "gpt-5.6",
    tools: ["echo"],
    reasoningEffort: "medium",
    history: SAY_HI,
    replies: [
      namedStream([
        responseCreated,
        ...responsesReasoning("rs_1", "Need the echo tool."),
        ...responsesCall("fc_1", 1, "call_echo", "echo", '{"x":5}'),
        responseCompleted(),
      ]),
      namedStream([responseCreated, ...responsesText("msg_1", 0, "Five."), responseCompleted()]),
    ],
  },
  "responses image and high effort on an id the SDK does not know": {
    model: "gpt-6-luna",
    reasoningEffort: "high",
    history: [
      {
        role: "user",
        parts: [
          { type: "text", text: "Describe." },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ],
    replies: [namedStream([responseCreated, ...responsesText("msg_1", 0, "One pixel."), responseCompleted()])],
  },
  "messages signed thinking then a tool": {
    model: "claude-sonnet-5-5",
    tools: ["echo"],
    reasoningEffort: "medium",
    history: SAY_HI,
    replies: [
      namedStream([
        messageStart,
        ...anthropicThinking(0, "Use echo.", "sig-1"),
        ...anthropicToolUse(1, "toolu_1", "echo", '{"x":9}'),
        ...messageEnd("tool_use"),
      ]),
      namedStream([messageStart, ...anthropicText(0, "Nine."), ...messageEnd("end_turn")]),
    ],
  },
  "generateContent tool then thought and text": {
    model: "gemini-3-pro",
    tools: ["echo"],
    history: SAY_HI,
    replies: [
      geminiStream([geminiChunk([{ functionCall: { name: "echo", args: { x: 2 } } }], "STOP")]),
      geminiStream([geminiChunk([{ text: "Weighing it.", thought: true }]), geminiChunk([{ text: "Two." }], "STOP")]),
    ],
  },
};

let replies: Reply[] = [];
let recorded: Recorded[] = [];

beforeEach(() => {
  resetLearnedEffortLimits();
  registerTools();
  recorded = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    recorded.push({ url: String(url), body });
    const reply = replies[recorded.length - 1];
    return reply ? reply() : httpError(401, "Incorrect API key provided.");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetToolRegistry();
});

async function play(scenario: Scenario): Promise<Recording> {
  replies = scenario.replies;
  const events: RuntimeEvent[] = [];
  let threw: string | null = null;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: scenario.baseUrl ?? GATEWAY }).execute({
      tenant,
      runId: "run-recording",
      modality: "text",
      version: versionFor(scenario.model),
      bindings: (scenario.tools ?? []).map(binding),
      history: scenario.history ?? SAY_HI ?? [],
      ...(scenario.reasoningEffort ? { reasoningEffort: scenario.reasoningEffort, reasoningEffortExplicit: true } : {}),
      ...(scenario.thinking === undefined ? {} : { thinking: scenario.thinking }),
      onEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  return { requests: recorded, events, threw };
}

function readGolden(): Record<string, Recording> {
  try {
    return (JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as { scenarios: Record<string, Recording> }).scenarios;
  } catch {
    return {};
  }
}

const golden = readGolden();
const fresh: Record<string, Recording> = {};

describe("the runtime's requests and events, recorded before the AI SDK and zod moves", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const recording = JSON.parse(JSON.stringify(await play(scenario))) as Recording;
      fresh[name] = recording;
      if (RECORD) {
        return;
      }
      expect(recording).toEqual(golden[name]);
    });
  }

  it("covers every scenario in the golden file", () => {
    if (RECORD) {
      writeFileSync(GOLDEN_URL, `${JSON.stringify({ scenarios: fresh }, null, 2)}\n`);
      return;
    }
    expect(Object.keys(golden).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});
