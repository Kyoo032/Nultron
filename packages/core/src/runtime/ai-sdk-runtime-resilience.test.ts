import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import type { RunBudget } from "../harness/spec";
import { defineTool } from "../tools/define-tool";
import { registerTool, resetToolRegistry } from "../tools/registry";
import { runWithToolSecrets } from "../tools/secret-scope";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

/**
 * What a run does when a step goes wrong, through the real AI SDK with `fetch` replaced: a tool that
 * throws, a call to a tool the run never offered, and a run that spends every step on tools. The model's
 * tool calls go through the SDK, the tool wrapper in `stream()` and `invokeToolGuarded`; what these tests
 * read is what the model was shown for each call, what the person's events carry, and how the run ends.
 */

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const version: AgentVersionRecord = {
  id: "v-resilience",
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
type Captured = {
  body: {
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  };
};

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

function register(key: string, execute: (args: { x: number }) => Promise<unknown>) {
  registerTool(
    defineTool({ key, name: key, description: `${key} tool`, schema: z.object({ x: z.number() }), execute }),
  );
}

async function run(options: {
  tools: string[];
  budget?: RunBudget;
  disabled?: string[];
}): Promise<{ events: RuntimeEvent[]; failed: unknown }> {
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  const execute = () =>
    new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-resilience",
      modality: "text",
      version,
      bindings: options.tools.map(binding),
      history: [{ role: "user", parts: [{ type: "text", text: "Use the tools." }] }],
      thinking: false,
      reasoningEffort: "none",
      reasoningEffortExplicit: true,
      ...(options.budget ? { budget: options.budget } : {}),
      onEvent: (event) => {
        events.push(event);
      },
    });
  try {
    await (options.disabled
      ? runWithToolSecrets({ secrets: {}, backends: {}, disabledTools: options.disabled }, execute)
      : execute());
  } catch (error) {
    failed = error;
  }
  return { events, failed };
}

const toolOutputs = (events: RuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "tool.completed" ? [event.output] : []));

function toolMessages(request: Captured): Array<Record<string, unknown>> {
  return (request.body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
}

const offered = (request: Captured) => (request.body.tools ?? []).map((tool) => tool.function?.name);
const types = (events: RuntimeEvent[]) => events.map((event) => event.type);

beforeEach(() => {
  resetLearnedEffortLimits();
  resetToolRegistry();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
  resetToolRegistry();
});

describe("a tool that throws", () => {
  it("is told to the model as a redacted result, and the run goes on to an answer", async () => {
    register("flaky", async () => {
      throw new Error("upstream returned 502 for Bearer abcdefghijklmnop1234567890");
    });
    const seen = gateway((request) =>
      request === 1 ? callsStream([{ name: "flaky", args: '{"x":1}' }], 1) : textStream("I tried another way."),
    );
    const { events, failed } = await run({ tools: ["flaky"] });

    expect(failed).toBeUndefined();
    expect(types(events)).not.toContain("run.failed");
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    const [result] = toolOutputs(events) as Array<{ ok: boolean; reason: string; message: string }>;
    expect(result).toMatchObject({ ok: false, reason: "tool_error" });
    expect(result?.message).toContain("502");
    expect(result?.message).not.toContain("abcdefghijklmnop1234567890");
    // The model saw the same words on the next step and wrote an answer from them.
    expect(seen).toHaveLength(2);
    expect(toolMessages(seen[1] as Captured)).toEqual([result]);
    expect(events.some((event) => event.type === "assistant.delta" && event.text.includes("another way"))).toBe(true);
  });

  it("does not turn a cancel into a tool result: the run rejects with the caller's reason", async () => {
    const controller = new AbortController();
    register("slow", async () => {
      controller.abort(new Error("client left"));
      throw new DOMException("aborted", "AbortError");
    });
    gateway((request) => (request === 1 ? callsStream([{ name: "slow", args: '{"x":1}' }], 1) : textStream("late")));
    const events: RuntimeEvent[] = [];
    await expect(
      new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
        tenant,
        runId: "run-cancel",
        modality: "text",
        version,
        bindings: [binding("slow")],
        history: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
        thinking: false,
        reasoningEffort: "none",
        reasoningEffortExplicit: true,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("client left");
    expect(toolOutputs(events).some((output) => (output as { reason?: string }).reason === "tool_error")).toBe(false);
  });
});

describe("a call to a tool the run does not offer", () => {
  it("is not in the list the model is given", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    register("run_code", async () => ({ ok: true }));
    const seen = gateway(() => textStream("hi"));
    await run({ tools: ["echo", "run_code"], disabled: ["run_code"] });
    expect(offered(seen[0] as Captured)).toEqual(["echo"]);
  });

  it("gets the disabled refusal, never runs, and does not end the run", async () => {
    let ran = 0;
    register("echo", async ({ x }) => ({ echoed: x }));
    register("run_code", async () => {
      ran += 1;
      return { ok: true };
    });
    const seen = gateway((request) =>
      request === 1
        ? callsStream([{ name: "run_code", args: '{"language":"python","code":"print(1)"}' }], 1)
        : textStream("I cannot run code here, so here is the answer by hand."),
    );
    const { events, failed } = await run({ tools: ["echo", "run_code"], disabled: ["run_code"] });

    expect(failed).toBeUndefined();
    expect(ran).toBe(0);
    expect(types(events)).not.toContain("run.failed");
    expect(toolOutputs(events)).toEqual([{ success: false, error: "Tool run_code is disabled on this machine." }]);
    expect(seen).toHaveLength(2);
    expect(toolMessages(seen[1] as Captured)).toEqual([
      { success: false, error: "Tool run_code is disabled on this machine." },
    ]);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("counts every refused call toward the run's budget, so parallel calls cannot run without limit", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    register("run_code", async () => ({ ok: true }));
    const calls = Array.from({ length: 5 }, (_, i) => ({
      name: "run_code",
      args: `{"language":"python","code":"${i}"}`,
    }));
    gateway((request) => (request === 1 ? callsStream(calls, 1) : textStream("done")));
    const { events, failed } = await run({
      tools: ["echo", "run_code"],
      disabled: ["run_code"],
      budget: { maxSteps: 6, maxToolCalls: 5, perTool: { run_code: 2 } },
    });
    expect(failed).toBeUndefined();
    const reasons = toolOutputs(events).map((output) => (output as { reason?: string }).reason);
    expect(reasons).toEqual([undefined, undefined, "budget", "budget", "budget"]);
  });

  it("sends no tool list at all when every bound tool is disabled, as before", async () => {
    register("run_code", async () => ({ ok: true }));
    const seen = gateway(() => textStream("hi"));
    const { failed } = await run({ tools: ["run_code"], disabled: ["run_code"] });
    expect(failed).toBeUndefined();
    expect((seen[0] as Captured).body.tools).toBeUndefined();
  });
});

describe("a run that spends every step on tools", () => {
  function neverStops() {
    return gateway((request) => callsStream([{ name: "echo", args: `{"x":${request}}` }], request));
  }

  it("says so once, after the last tool result and before it completes", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    neverStops();
    const { events, failed } = await run({ tools: ["echo"], budget: { maxSteps: 3, maxToolCalls: 10 } });

    expect(failed).toBeUndefined();
    const marks = events.filter((event) => event.type === "run.step_limit");
    expect(marks).toEqual([{ type: "run.step_limit", steps: 3 }]);
    const order = types(events);
    expect(order.lastIndexOf("tool.completed")).toBeLessThan(order.indexOf("run.step_limit"));
    expect(order.indexOf("run.step_limit")).toBeLessThan(order.indexOf("run.completed"));
  });

  it("also says so under the default 6 steps", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    neverStops();
    const { events } = await run({ tools: ["echo"] });
    expect(events.filter((event) => event.type === "run.step_limit")).toEqual([{ type: "run.step_limit", steps: 6 }]);
  });

  it("stays quiet when the model answers before the limit", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    gateway((request) =>
      request < 3 ? callsStream([{ name: "echo", args: `{"x":${request}}` }], request) : textStream("done"),
    );
    const { events } = await run({ tools: ["echo"], budget: { maxSteps: 4, maxToolCalls: 10 } });
    expect(types(events)).not.toContain("run.step_limit");
  });

  it("stays quiet when the last allowed step is the answer", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    gateway((request) =>
      request < 3 ? callsStream([{ name: "echo", args: `{"x":${request}}` }], request) : textStream("done"),
    );
    const { events } = await run({ tools: ["echo"], budget: { maxSteps: 3, maxToolCalls: 10 } });
    expect(types(events)).not.toContain("run.step_limit");
  });

  it("stays quiet when the model never used a tool", async () => {
    register("echo", async ({ x }) => ({ echoed: x }));
    gateway(() => textStream("hello"));
    const { events } = await run({ tools: ["echo"], budget: { maxSteps: 1, maxToolCalls: 10 } });
    expect(types(events)).not.toContain("run.step_limit");
  });
});
