import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import type { RunBudget } from "../harness/spec";
import { defineTool } from "../tools/define-tool";
import { registerTool, resetToolRegistry } from "../tools/registry";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

/**
 * The run budget through the real AI SDK. `fetch` is replaced, so nothing leaves the machine, but the
 * model's tool calls go through the SDK, the tool wrapper in `stream()` and `invokeToolGuarded`: what
 * these tests read is how many tools ran, what the model was told about the rest, and how many steps
 * the loop took.
 */

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const version: AgentVersionRecord = {
  id: "v-budget",
  agentId: "chat",
  organizationId: "org",
  version: 1,
  systemPrompt: "You are helpful.",
  model: "deepseek-v4-flash",
  inputModalities: ["text"],
  config: {},
  createdAt: new Date(),
};

const encoder = new TextEncoder();

type ToolCall = { name: string; args: string };
type Captured = { body: { messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }> } };

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

/** One model step that asks for every call in `calls` at once, each with its own id. */
function callsStream(calls: ToolCall[], step: number): Response {
  return sse([
    frame({
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index,
        id: `call_${step}_${index}`,
        type: "function",
        function: { name: call.name, arguments: call.args },
      })),
    }),
    frame({}, "tool_calls"),
  ]);
}

function textStream(text: string): Response {
  return sse([frame({ role: "assistant", content: text }), frame({}, "stop")]);
}

/** Answers request number n (from 1) with `reply(n)`, and keeps every request body. */
function gateway(reply: (request: number) => Response): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    seen.push({ body: JSON.parse(String(init?.body ?? "{}")) as Captured["body"] });
    return reply(seen.length);
  });
  return seen;
}

function binding(toolKey: string): ToolBindingRecord {
  return { id: `b-${toolKey}`, agentVersionId: "v", organizationId: "org", toolKey, config: {}, enabled: true };
}

function registerCounting(): { echoed: number[]; others: number[] } {
  const seen = { echoed: [] as number[], others: [] as number[] };
  resetToolRegistry();
  registerTool(
    defineTool({
      key: "echo",
      name: "Echo",
      description: "Echo a number.",
      schema: z.object({ x: z.number() }),
      execute: async ({ x }) => {
        seen.echoed.push(x);
        return { echoed: x };
      },
    }),
  );
  registerTool(
    defineTool({
      key: "other",
      name: "Other",
      description: "Another tool.",
      schema: z.object({ x: z.number() }),
      execute: async ({ x }) => {
        seen.others.push(x);
        return { other: x };
      },
    }),
  );
  return seen;
}

async function run(budget: RunBudget | undefined): Promise<{ events: RuntimeEvent[]; failed: unknown }> {
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-budget",
      modality: "text",
      version,
      bindings: [binding("echo"), binding("other")],
      history: [{ role: "user", parts: [{ type: "text", text: "Use the tools." }] }],
      thinking: false,
      reasoningEffort: "none",
      reasoningEffortExplicit: true,
      ...(budget ? { budget } : {}),
      onEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    failed = error;
  }
  return { events, failed };
}

const toolOutputs = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "tool.completed" ? [event.output] : []));

/** What the model was shown for each tool call of the step before request `index`. */
function toolMessages(request: Captured): unknown[] {
  return (request.body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(String(message.content)) as unknown);
}

beforeEach(() => {
  resetLearnedEffortLimits();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
  resetToolRegistry();
});

describe("maxToolCalls", () => {
  it("runs the calls up to the cap, refuses the rest to the model, and finishes the turn", async () => {
    const ran = registerCounting();
    const seen = gateway((request) =>
      request === 1
        ? callsStream(
            [
              { name: "echo", args: '{"x":1}' },
              { name: "echo", args: '{"x":2}' },
              { name: "echo", args: '{"x":3}' },
            ],
            1,
          )
        : textStream("done"),
    );
    const { events, failed } = await run({ maxSteps: 6, maxToolCalls: 2 });

    const refusal = {
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent: this run allows 2 calls in all and they have run. Do not call more tools; answer with what you have.",
    };
    expect(failed).toBeUndefined();
    expect(ran.echoed).toEqual([1, 2]);
    expect(toolOutputs(events)).toEqual([{ echoed: 1 }, { echoed: 2 }, refusal]);
    // The model saw the refusal as the third call's result and answered on the next step.
    expect(seen).toHaveLength(2);
    expect(toolMessages(seen[1] as Captured)).toEqual([{ echoed: 1 }, { echoed: 2 }, refusal]);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("counts every tool toward the total, across steps", async () => {
    const ran = registerCounting();
    const seen = gateway((request) =>
      request === 1
        ? callsStream([{ name: "echo", args: '{"x":1}' }], 1)
        : request === 2
          ? callsStream(
              [
                { name: "other", args: '{"x":2}' },
                { name: "echo", args: '{"x":3}' },
              ],
              2,
            )
          : textStream("done"),
    );
    const { events } = await run({ maxSteps: 6, maxToolCalls: 2 });

    expect(ran.echoed).toEqual([1]);
    expect(ran.others).toEqual([2]);
    expect(toolOutputs(events)[2]).toMatchObject({ ok: false, reason: "budget" });
    expect(seen).toHaveLength(3);
  });
});

describe("perTool", () => {
  it("refuses a tool past its own ceiling while the others keep running", async () => {
    const ran = registerCounting();
    const seen = gateway((request) =>
      request === 1
        ? callsStream(
            [
              { name: "echo", args: '{"x":1}' },
              { name: "echo", args: '{"x":2}' },
              { name: "other", args: '{"x":3}' },
            ],
            1,
          )
        : textStream("done"),
    );
    const { events, failed } = await run({ maxSteps: 6, maxToolCalls: 5, perTool: { echo: 1 } });

    const refusal = {
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent for echo: this run allows 1 call to it and they have run. Use another tool or answer with what you have.",
    };
    expect(failed).toBeUndefined();
    expect(ran.echoed).toEqual([1]);
    expect(ran.others).toEqual([3]);
    expect(toolOutputs(events)).toEqual([{ echoed: 1 }, refusal, { other: 3 }]);
    expect(toolMessages(seen[1] as Captured)).toEqual([{ echoed: 1 }, refusal, { other: 3 }]);
  });
});

describe("maxSteps", () => {
  /** A model that asks for a tool on every step, so only the step cap ends the loop. */
  function neverStops() {
    return gateway((request) => callsStream([{ name: "echo", args: `{"x":${request}}` }], request));
  }

  it("keeps today's 6 steps and no tool-call cap when no budget is given", async () => {
    const ran = registerCounting();
    const seen = neverStops();
    const { failed, events } = await run(undefined);

    expect(failed).toBeUndefined();
    expect(seen).toHaveLength(6);
    expect(ran.echoed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toolOutputs(events)).toHaveLength(6);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("takes the step count from the budget", async () => {
    const ran = registerCounting();
    const seen = neverStops();
    const { failed } = await run({ maxSteps: 2, maxToolCalls: 10 });

    expect(failed).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(ran.echoed).toEqual([1, 2]);
  });

  it("lets a larger budget run past the old 6", async () => {
    const ran = registerCounting();
    const seen = neverStops();
    await run({ maxSteps: 8, maxToolCalls: 10 });

    expect(seen).toHaveLength(8);
    expect(ran.echoed).toHaveLength(8);
  });

  it("ends the loop at the cap with calls refused on the steps in between", async () => {
    const ran = registerCounting();
    const seen = neverStops();
    const { events } = await run({ maxSteps: 3, maxToolCalls: 1 });

    expect(seen).toHaveLength(3);
    expect(ran.echoed).toEqual([1]);
    expect(toolOutputs(events).map((output) => (output as { reason?: string }).reason)).toEqual([
      undefined,
      "budget",
      "budget",
    ]);
  });
});
