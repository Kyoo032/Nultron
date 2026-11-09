import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { AgentVersionRecord } from "../agents/service";
import type { TenantContext } from "../tenancy/types";
import type { RuntimeEvent } from "./types";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const version: AgentVersionRecord = {
  id: "v-gpt-5.6",
  agentId: "chat",
  organizationId: "org",
  version: 1,
  systemPrompt: "You are helpful.",
  model: "gpt-5.6",
  inputModalities: ["text"],
  config: {},
  createdAt: new Date(),
};

type Frame = { event: string; data: Record<string, unknown> };

const encoder = new TextEncoder();

function named(frames: Frame[]): Response {
  const body = frames
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
    .join("");
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const created: Frame = {
  event: "response.created",
  data: { response: { id: "resp_1", object: "response", created_at: 1, model: "gpt-5.6", status: "in_progress" } },
};

const completedFrame: Frame = {
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
        input_tokens: 3,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  },
};

function reasoning(summary: string): Frame[] {
  return [
    {
      event: "response.output_item.added",
      data: { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    },
    {
      event: "response.reasoning_summary_part.added",
      data: { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
    },
    {
      event: "response.reasoning_summary_text.delta",
      data: { item_id: "rs_1", output_index: 0, summary_index: 0, delta: summary },
    },
    {
      event: "response.output_item.done",
      data: {
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: summary }] },
      },
    },
  ];
}

function gateway(replies: Array<() => Response>): void {
  let sent = 0;
  vi.stubGlobal("fetch", async () => {
    sent += 1;
    const reply = replies[sent - 1];
    if (!reply) {
      throw new Error(`unexpected request number ${sent}`);
    }
    return reply();
  });
}

async function run(): Promise<{ events: RuntimeEvent[]; failed: unknown }> {
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-blank-reasoning",
      modality: "text",
      version,
      bindings: [],
      history: [{ role: "user", parts: [{ type: "text", text: "Say ok." }] }],
      thinking: true,
      reasoningEffort: "medium",
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

const completed = (events: RuntimeEvent[]) => events.filter((event) => event.type === "run.completed");
const failedEvents = (events: RuntimeEvent[]) => events.filter((event) => event.type === "run.failed");

beforeEach(() => {
  resetLearnedEffortLimits();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
});

describe("reasoning that is only whitespace, with no answer text", () => {
  it("is an empty reply: one run.failed, no run.completed", async () => {
    gateway(Array.from({ length: 3 }, () => () => named([created, ...reasoning(" "), completedFrame])));
    const { events, failed } = await run();

    expect(failedEvents(events)).toHaveLength(1);
    expect(completed(events)).toHaveLength(0);
    expect(String((failed as Error).message)).toMatch(/returned no text/);
  });

  it("is the same for newlines and mixed blanks", async () => {
    gateway(Array.from({ length: 3 }, () => () => named([created, ...reasoning(" \n\n\t"), completedFrame])));
    const { events, failed } = await run();

    expect(failedEvents(events)).toHaveLength(1);
    expect(completed(events)).toHaveLength(0);
    expect(String((failed as Error).message)).toMatch(/returned no text/);
  });
});

describe("reasoning that is readable, with no answer text", () => {
  it("still completes, so the thinking is saved as the turn", async () => {
    gateway(
      Array.from({ length: 3 }, () => () => named([created, ...reasoning("Weighing the options."), completedFrame])),
    );
    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    expect(events).toContainEqual({ type: "assistant.thinking", text: "Weighing the options." });
    expect(completed(events)).toHaveLength(1);
    expect(failedEvents(events)).toHaveLength(0);
  });
});
