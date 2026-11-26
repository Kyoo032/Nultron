import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentVersionRecord, ToolBindingRecord } from "../agents/service";
import type { RunBudget } from "../harness/spec";
import type { TenantContext } from "../tenancy/types";
import { defineTool } from "../tools/define-tool";
import { registerPlatformTools } from "../tools/platform/register";
import { listTools } from "../tools/registry";
import { invokeToolGuarded } from "./invoke-guarded";
import { StubRuntime } from "./stub-runtime";
import { DEFAULT_MAX_STEPS, createToolBudget, resolveMaxSteps } from "./tool-budget";
import { runWithToolIoSink, takeLastToolIo } from "./tool-io";
import type { RuntimeEvent } from "./types";

registerPlatformTools();

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "builder",
};

const TOTAL_REFUSAL = {
  ok: false,
  reason: "budget",
  message:
    "Tool budget spent: this run allows 2 calls in all and they have run. Do not call more tools; answer with what you have.",
};

describe("resolveMaxSteps", () => {
  it("keeps today's 6 steps when no budget is given", () => {
    expect(DEFAULT_MAX_STEPS).toBe(6);
    expect(resolveMaxSteps(undefined)).toBe(6);
  });

  it("takes the budget's own step count", () => {
    expect(resolveMaxSteps({ maxSteps: 3, maxToolCalls: 10 })).toBe(3);
  });
});

describe("createToolBudget", () => {
  it("applies the default budget when the run passes none (F7a)", () => {
    const budget = createToolBudget(undefined);
    // Under the default's 60-call ceiling: every call admitted.
    for (let call = 0; call < 60; call += 1) {
      expect(budget.admit("echo")).toBeNull();
    }
    // The 61st is refused: no budget no longer means admit-all.
    expect(budget.admit("echo")?.message).toMatch(/^Tool budget spent: this run allows 60 calls in all/);
  });

  it("refuses every call past maxToolCalls, all tools counted together", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 2 });
    expect(budget.admit("echo")).toBeNull();
    expect(budget.admit("other")).toBeNull();
    expect(budget.admit("echo")).toEqual(TOTAL_REFUSAL);
    expect(budget.admit("other")).toEqual(TOTAL_REFUSAL);
  });

  it("refuses a tool past its own ceiling and lets the others run", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 5, perTool: { run_code: 1 } });
    expect(budget.admit("run_code")).toBeNull();
    expect(budget.admit("run_code")).toEqual({
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent for run_code: this run allows 1 call to it and they have run. Use another tool or answer with what you have.",
    });
    expect(budget.admit("echo")).toBeNull();
  });

  it("does not count a refused call, so a spent tool leaves room for the rest", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 3, perTool: { run_code: 1 } });
    expect(budget.admit("run_code")).toBeNull();
    expect(budget.admit("run_code")?.reason).toBe("budget");
    expect(budget.admit("run_code")?.reason).toBe("budget");
    expect(budget.admit("echo")).toBeNull();
    expect(budget.admit("echo")).toBeNull();
    expect(budget.admit("echo")?.message).toMatch(/^Tool budget spent: this run allows 3 calls in all/);
  });

  it("checks the total before the tool's own ceiling", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 1, perTool: { echo: 1 } });
    expect(budget.admit("echo")).toBeNull();
    expect(budget.admit("echo")?.message).toMatch(/^Tool budget spent: this run allows 1 call in all/);
  });

  it("refuses everything at maxToolCalls 0", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 0 });
    expect(budget.admit("echo")?.message).toMatch(/^Tool budget spent: this run allows 0 calls in all/);
  });

  it("reads a perTool key by its own name only, never one inherited from Object", () => {
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 5, perTool: { echo: 1 } });
    expect(budget.admit("constructor")).toBeNull();
    expect(budget.admit("toString")).toBeNull();
  });

  it("gives each run its own count", () => {
    const spec: RunBudget = { maxSteps: 6, maxToolCalls: 1 };
    const first = createToolBudget(spec);
    const second = createToolBudget(spec);
    expect(first.admit("echo")).toBeNull();
    expect(first.admit("echo")?.reason).toBe("budget");
    expect(second.admit("echo")).toBeNull();
  });
});

describe("invokeToolGuarded with a budget", () => {
  it("never executes a call past the cap and returns the refusal", async () => {
    let executed = 0;
    const tool = defineTool({
      key: "echo",
      name: "Echo",
      description: "echo",
      schema: z.object({ x: z.number() }),
      execute: async ({ x }) => {
        executed += 1;
        return { echoed: x };
      },
    });
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 1 });
    const first = await invokeToolGuarded(tool, { x: 1 }, tenant, budget);
    const second = await invokeToolGuarded(tool, { x: 2 }, tenant, budget);
    expect(first).toEqual({ echoed: 1 });
    expect(second).toEqual({
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent: this run allows 1 call in all and they have run. Do not call more tools; answer with what you have.",
    });
    expect(executed).toBe(1);
  });

  it("records the refusal on the tool I/O sink like any other answer", async () => {
    const tool = defineTool({
      key: "echo",
      name: "Echo",
      description: "echo",
      schema: z.object({ x: z.number() }),
      execute: async () => ({ ok: true }),
    });
    const budget = createToolBudget({ maxSteps: 6, maxToolCalls: 0 });
    const seen = await runWithToolIoSink(async () => {
      const result = await invokeToolGuarded(tool, { x: 1 }, tenant, budget);
      return { result, recorded: takeLastToolIo("echo") };
    });
    expect(seen.recorded).toEqual({ toolKey: "echo", input: { x: 1 }, full: seen.result, thin: seen.result });
  });

  it("runs unbudgeted exactly as before when no budget is passed", async () => {
    let executed = 0;
    const tool = defineTool({
      key: "echo",
      name: "Echo",
      description: "echo",
      schema: z.object({ x: z.number() }),
      execute: async () => {
        executed += 1;
        return { ok: true };
      },
    });
    for (let call = 0; call < 20; call += 1) {
      await invokeToolGuarded(tool, { x: call }, tenant);
    }
    expect(executed).toBe(20);
  });
});

describe("StubRuntime and the budget", () => {
  const version: AgentVersionRecord = {
    id: "v1",
    agentId: "a1",
    organizationId: "org",
    version: 1,
    systemPrompt: "You are helpful.",
    model: "stub-model",
    inputModalities: ["text"],
    config: {},
    createdAt: new Date(),
  };

  function binding(toolKey: string): ToolBindingRecord {
    return { id: `bind-${toolKey}`, agentVersionId: "v1", organizationId: "org", toolKey, config: {}, enabled: true };
  }

  async function run(budget: RunBudget | undefined): Promise<{ answer: string; completed: unknown[] }> {
    let answer = "";
    const completed: unknown[] = [];
    await new StubRuntime().execute({
      tenant,
      runId: "run-stub-budget",
      modality: "text",
      version,
      bindings: [binding("calculator"), binding("datetime")],
      history: [{ role: "user", parts: [{ type: "text", text: "What is 2 + 3 and what time is it now?" }] }],
      thinking: false,
      ...(budget ? { budget } : {}),
      onEvent: (event: RuntimeEvent) => {
        if (event.type === "assistant.delta") {
          answer += event.text;
        }
        if (event.type === "tool.completed") {
          completed.push(event.output);
        }
      },
    });
    return { answer, completed };
  }

  it("runs both tools when no budget is given", async () => {
    const seen = await run(undefined);
    expect(seen.completed).toHaveLength(2);
    // The stub streams its answer through `.{1,24}` chunks, which drop the newline between lines.
    expect(seen.answer).toMatch(/^2 \+ 3 = 5\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses the second tool call past maxToolCalls", async () => {
    const seen = await run({ maxSteps: 6, maxToolCalls: 1 });
    const refusal = {
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent: this run allows 1 call in all and they have run. Do not call more tools; answer with what you have.",
    };
    expect(seen.completed).toEqual([{ result: 5 }, refusal]);
    expect(seen.answer).toBe(`2 + 3 = 5${JSON.stringify(refusal)}`);
  });

  it("refuses a tool past its own ceiling", async () => {
    const seen = await run({ maxSteps: 6, maxToolCalls: 5, perTool: { datetime: 0 } });
    expect(seen.completed[0]).toEqual({ result: 5 });
    expect(seen.completed[1]).toEqual({
      ok: false,
      reason: "budget",
      message:
        "Tool budget spent for datetime: this run allows 0 calls to it and they have run. Use another tool or answer with what you have.",
    });
  });
});

describe("platform tool trust", () => {
  it("marks exactly the tools whose output is outside text as network", () => {
    const trust = Object.fromEntries(listTools().map((tool) => [tool.key, tool.trust]));
    expect(trust).toMatchObject({
      web_search: "network",
      web_fetch: "network",
      calculator: "internal",
      datetime: "internal",
      image_generate: "internal",
      video_generate: "internal",
      music_generate: "internal",
      lyrics_write: "internal",
      speech_generate: "internal",
    });
    const network = listTools()
      .filter((tool) => tool.trust === "network")
      .map((tool) => tool.key)
      .sort();
    expect(network).toEqual(["web_fetch", "web_search"]);
  });
});
