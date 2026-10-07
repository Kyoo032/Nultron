/**
 * `build_deck` through the real AI SDK: what a model that overruns a cap actually costs.
 *
 * The SDK checks a tool call's arguments against the tool's schema before `execute` runs, and an
 * argument that fails there ends the whole turn as `run.failed`: the person sees an error and no
 * deck, and the model never learns what was wrong. These cases replace `fetch`, so nothing leaves the
 * machine, and drive a model that writes too much; the turn must survive, the model must be told which
 * field and which limit, and a corrected call must make the deck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime, type AgentVersionRecord, type RuntimeEvent, type ToolBindingRecord } from "@agentforge/core";
import { harnessSpecFor } from "@agentforge/core/harness";
import { artifactStore } from "../artifacts";
import { ensureToolsRegistered } from "../register-tools";
import { getTenant } from "../tenant";

const version: AgentVersionRecord = {
  id: "v-deck",
  agentId: "chat",
  organizationId: "org",
  version: 1,
  systemPrompt: "You are helpful.",
  model: "deepseek-v4-flash",
  inputModalities: ["text"],
  config: {},
  createdAt: new Date(),
};

const binding: ToolBindingRecord = {
  id: "b-deck",
  agentVersionId: "v",
  organizationId: "org",
  toolKey: "build_deck",
  config: {},
  enabled: true,
};

const encoder = new TextEncoder();

type Captured = { body: { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] } };

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

function deckCall(args: unknown, step: number): Response {
  return sse([
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${step}`,
          type: "function",
          function: { name: "build_deck", arguments: JSON.stringify(args) },
        },
      ],
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

async function run(): Promise<{ events: RuntimeEvent[]; failed: unknown }> {
  ensureToolsRegistered();
  const tenant = await getTenant();
  const events: RuntimeEvent[] = [];
  let failed: unknown;
  try {
    await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }).execute({
      tenant,
      runId: "run-deck",
      modality: "text",
      version,
      bindings: [binding],
      history: [{ role: "user", parts: [{ type: "text", text: "Make me a deck." }] }],
      thinking: false,
      reasoningEffort: "none",
      reasoningEffortExplicit: true,
      budget: harnessSpecFor("chat").budget,
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

const toolMessages = (request: Captured): unknown[] =>
  (request.body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(String(message.content)) as unknown);

const slide = (n: number, extra: Record<string, unknown> = {}) => ({
  heading: `Claim ${n}`,
  bullets: [`Point for ${n}`],
  notes: `Say ${n}`,
  ...extra,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what the model is told about the tool", () => {
  it("still reads every limit and the four slide kinds, in words, though the schema enforces none", async () => {
    const seen = gateway(() => textStream("Hello."));
    await run();
    const tool = JSON.stringify((seen[0] as Captured).body.tools?.[0]);
    expect(tool).toContain("build_deck");
    for (const needle of ["2000", "600", "400", "300", "200", "12", "14", "section", "bullets", "split", "close"]) {
      expect(tool, needle).toContain(needle);
    }
    // The kinds are still an enum the model sees (a wrong one reads as `bullets` rather than failing).
    expect(tool).toContain('"enum":["section","bullets","split","close"]');
    // `title`, `slides` and each slide's `heading` stay required: that is shape, not a limit.
    expect(tool).toContain('"required":["title","slides"]');
    expect(tool).toContain('"required":["heading"]');
    expect(tool).not.toContain("maxLength");
    expect(tool).not.toContain("maxItems");
    expect(tool).not.toContain("minItems");
    expect(tool).not.toContain("minLength");
  });
});

describe("a model that overruns a cap", () => {
  it("gets a refusal it can read, the turn survives, and the corrected call makes the deck", async () => {
    const tenant = await getTenant();
    const before = artifactStore().list(tenant, "presentations").length;
    const tooLong = { title: "Plan", slides: [slide(1), slide(2, { notes: "n".repeat(2100) })] };
    const fixed = { title: "Plan", slides: [slide(1), slide(2)] };
    const seen = gateway((request) =>
      request === 1 ? deckCall(tooLong, 1) : request === 2 ? deckCall(fixed, 2) : textStream("Your deck is ready."),
    );

    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    const [refusal, made] = toolOutputs(events);
    expect(refusal).toMatchObject({ ok: false, reason: "limits" });
    const message = String((refusal as { message: string }).message);
    expect(message).toContain("slides[1].notes");
    expect(message).toContain("2000");
    expect(message).toContain("2100");
    expect(made).toMatchObject({ ok: true, filename: "plan.pptx", slideCount: 3 });
    // The model saw the refusal as the first call's result, then the deck's answer.
    expect(seen).toHaveLength(3);
    expect(toolMessages(seen[1] as Captured)[0]).toEqual(refusal);
    expect(artifactStore().list(tenant, "presentations")).toHaveLength(before + 1);
  });

  it("is told about thirteen bullets and a deck of fifteen slides in one answer, not one at a time", async () => {
    const wide = { title: "Plan", slides: [slide(1, { bullets: Array.from({ length: 13 }, (_, i) => `b${i}`) })] };
    gateway((request) => (request === 1 ? deckCall(wide, 1) : textStream("Trying again.")));

    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    const [refusal] = toolOutputs(events);
    expect(refusal).toMatchObject({ ok: false, reason: "limits" });
    expect(String((refusal as { message: string }).message)).toContain("slides[0].bullets");
  });

  it("is refused, not failed, when the outline is missing its slides or its title is empty", async () => {
    gateway((request) => (request === 1 ? deckCall({ title: "", slides: [] }, 1) : textStream("Sorry.")));

    const { events, failed } = await run();

    expect(failed).toBeUndefined();
    expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
    expect(toolOutputs(events)[0]).toMatchObject({ ok: false });
  });
});
