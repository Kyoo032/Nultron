import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import { defineTool } from "../tools/define-tool";
import { registerTool, resetToolRegistry } from "../tools/registry";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

/**
 * A model that calls a tool with arguments the schema refuses, or a tool this run does not have, used to
 * end the whole turn: the SDK threw while parsing the call and the loop never reached a second step.
 * These run the real SDK against a replaced `fetch`: the bad call must come back to the model as a
 * result it can read, and the turn must go on to an answer.
 */

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const version: AgentVersionRecord = {
  id: "v-repair",
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

function callStream(name: string, args: string): Response {
  return sse([
    frame({
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: args } }],
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

function registerEcho(): number[] {
  const echoed: number[] = [];
  resetToolRegistry();
  registerTool(
    defineTool({
      key: "echo",
      name: "Echo",
      description: "Echo a number.",
      schema: z.object({ x: z.number() }),
      execute: async ({ x }) => {
        echoed.push(x);
        return { echoed: x };
      },
    }),
  );
  return echoed;
}

async function run(): Promise<{ events: RuntimeEvent[]; failed: unknown }> {
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-repair",
      modality: "text",
      version,
      bindings: [binding("echo")],
      history: [{ role: "user", parts: [{ type: "text", text: "Use the tool." }] }],
      thinking: false,
      reasoningEffort: "none",
      reasoningEffortExplicit: true,
      onEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    failed = error;
  }
  return { events, failed };
}

function toolMessageTexts(request: Captured): string[] {
  return (request.body.messages ?? []).filter((message) => message.role === "tool").map((m) => String(m.content));
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

describe("a tool call the SDK cannot parse", () => {
  it("goes back to the model as a result when the arguments break the schema, and the turn finishes", async () => {
    const echoed = registerEcho();
    const seen = gateway((request) => (request === 1 ? callStream("echo", '{"x":"not a number"}') : textStream("done")));
    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    expect(echoed).toEqual([]);
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expect(events.filter((event) => event.type === "assistant.delta").map((event) => (event as { text: string }).text)).toContain(
      "done",
    );
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(seen).toHaveLength(2);
    const told = toolMessageTexts(seen[1] as Captured).join("\n");
    expect(told).toContain("echo");
    expect(told).toMatch(/invalid|arguments/i);
  });

  it("goes back to the model as a result when the tool is not one this run has, naming the tools it does have", async () => {
    registerEcho();
    const seen = gateway((request) => (request === 1 ? callStream("nonexistent_tool", "{}") : textStream("done")));
    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    expect(events.some((event) => event.type === "run.failed")).toBe(false);
    expect(events.at(-1)?.type).toBe("run.completed");
    const told = toolMessageTexts(seen[1] as Captured).join("\n");
    expect(told).toContain("nonexistent_tool");
    expect(told).toContain("echo");
  });

  it("never offers the correction tool to the model, and never shows it as a tool on the screen", async () => {
    registerEcho();
    const seen = gateway((request) => (request === 1 ? callStream("nonexistent_tool", "{}") : textStream("done")));
    const { events } = await run();

    for (const request of seen) {
      const names = (request.body.tools ?? []).map((tool) => tool.function?.name);
      expect(names).toEqual(["echo"]);
    }
    const toolEvents = events.filter((event) => event.type === "tool.started" || event.type === "tool.completed");
    expect(toolEvents).toEqual([]);
  });

  it("still runs a valid call normally", async () => {
    const echoed = registerEcho();
    gateway((request) => (request === 1 ? callStream("echo", '{"x":7}') : textStream("done")));
    const { failed } = await run();
    expect(failed).toBeUndefined();
    expect(echoed).toEqual([7]);
  });
});
