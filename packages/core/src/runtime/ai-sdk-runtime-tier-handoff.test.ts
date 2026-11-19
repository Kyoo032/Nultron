import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVersionRecord } from "../agents/service";
import type { ContentPart } from "../content/types";
import { GATEWAY_PROVIDER_ID } from "../providers/gateway-id";
import { TIER_DEFINITIONS, type ModelTierId } from "../models/tiers";
import type { TenantContext } from "../tenancy/types";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import type { RuntimeEvent } from "./types";

/**
 * One conversation, three vendors. A person can switch tier between two turns of the same thread, so
 * the Reasoning model (Claude, Messages wire) receives an answer the Fastest model (DeepSeek,
 * Completions wire) wrote, and the Daily model (GPT, Responses wire) receives both. The host hands the
 * runtime history as plain text (`toModelMessages` keeps only the text of an assistant turn), so no
 * vendor's thinking block, signature or reasoning item can travel with it. This file proves that
 * offline: the real `AiSdkRuntime` and the real AI SDK run against a stubbed `fetch` that answers each
 * wire with a valid successful stream, and what the stub sees is the request the gateway would get.
 *
 * Not driven live: there is no gateway key here, and nothing in this file calls the real gateway.
 *
 * The inputs per tier are the ones the host builds from `REASONING_BY_THINKING`
 * (`packages/host/src/tier-resolve.ts:42-46`): Fastest is Off (`none`, chosen), Reasoning is Deep
 * (`high`, chosen), Daily is the model's own default (`medium`, not chosen).
 */

const BASE_URL = "https://api.tokotokenai.com/v1";
const SYSTEM_PROMPT = "You are the tier handoff test assistant.";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

type TierSetup = {
  /** The head of the tier's gateway list, as `tiers.ts` seeds it. */
  model: string;
  /** The path the AI SDK posts to for this model's wire, after the base URL. */
  path: "/chat/completions" | "/messages" | "/responses";
  /** What the host passes the runtime for this tier. */
  input: { thinking: boolean; reasoningEffort: "none" | "medium" | "high"; reasoningEffortExplicit: boolean };
};

const TIERS: Record<ModelTierId, TierSetup> = {
  fast: {
    model: "deepseek-v4-1-flash",
    path: "/chat/completions",
    input: { thinking: false, reasoningEffort: "none", reasoningEffortExplicit: true },
  },
  reasoning: {
    model: "claude-opus-5-5",
    path: "/messages",
    input: { thinking: true, reasoningEffort: "high", reasoningEffortExplicit: true },
  },
  daily: {
    model: "gpt-6-luna",
    path: "/responses",
    input: { thinking: true, reasoningEffort: "medium", reasoningEffortExplicit: false },
  },
};

/* ------------------------------------------------------------------------------------------------ */
/* Stub gateway: one valid streaming answer per wire, routed by request URL.                          */
/* ------------------------------------------------------------------------------------------------ */

const encoder = new TextEncoder();

type Captured = { url: string; body: Record<string, unknown> };

function sse(frames: Array<{ event?: string; data: unknown }>, done = false): Response {
  const text =
    frames.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  return new Response(encoder.encode(text), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function completionsAnswer(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) => ({
    data: {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: TIERS.fast.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    },
  });
  return sse(
    [
      chunk({ role: "assistant", content: text }),
      chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
    ],
    true,
  );
}

function messagesAnswer(text: string): Response {
  const frame = (event: string, data: Record<string, unknown>) => ({ event, data: { type: event, ...data } });
  return sse([
    frame("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: TIERS.reasoning.model,
        content: [],
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
    frame("message_stop", {}),
  ]);
}

function responsesAnswer(text: string): Response {
  const frame = (event: string, data: Record<string, unknown>) => ({ event, data: { type: event, ...data } });
  return sse([
    frame("response.created", {
      response: { id: "resp_1", object: "response", created_at: 1, model: TIERS.daily.model, status: "in_progress" },
    }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
    }),
    frame("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: text }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    frame("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: TIERS.daily.model,
        status: "completed",
        incomplete_details: null,
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    }),
  ]);
}

/** The text the stub's next answer carries, whichever wire is asked. */
let nextAnswer = "";
let seen: Captured[] = [];

function stubGateway(): void {
  seen = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    seen.push({ url: target, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (target.endsWith("/chat/completions")) {
      return completionsAnswer(nextAnswer);
    }
    if (target.endsWith("/messages")) {
      return messagesAnswer(nextAnswer);
    }
    if (target.endsWith("/responses")) {
      return responsesAnswer(nextAnswer);
    }
    throw new Error(`the stub gateway has no answer for ${target}`);
  });
}

beforeEach(() => {
  resetLearnedEffortLimits();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  stubGateway();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLearnedEffortLimits();
});

/* ------------------------------------------------------------------------------------------------ */
/* Running turns                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

type Turn = { role: "user" | "assistant"; text: string };

function versionFor(model: string): AgentVersionRecord {
  return {
    id: `v-${model}`,
    agentId: "chat",
    organizationId: "org",
    version: 1,
    systemPrompt: SYSTEM_PROMPT,
    model,
    inputModalities: ["text"],
    config: {},
    createdAt: new Date(),
  };
}

function toHistory(turns: Turn[]): Array<{ role: "user" | "assistant"; parts: ContentPart[] }> {
  return turns.map((turn) => ({ role: turn.role, parts: [{ type: "text" as const, text: turn.text }] }));
}

type TurnResult = {
  tier: ModelTierId;
  /** The one request the turn made. */
  request: Captured;
  /** What the person saw: the assistant text the run streamed. */
  answer: string;
  events: RuntimeEvent[];
  /** The history this turn was sent, last user message included. */
  sent: Turn[];
};

/** Runs one turn on `tier` with `history` and returns the request it made. */
async function runTurn(tier: ModelTierId, history: Turn[], answer: string): Promise<TurnResult> {
  const setup = TIERS[tier];
  nextAnswer = answer;
  seen = [];
  const events: RuntimeEvent[] = [];
  await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: BASE_URL }).execute({
    tenant,
    runId: `run-${tier}`,
    modality: "text",
    version: versionFor(setup.model),
    bindings: [],
    history: toHistory(history),
    ...setup.input,
    onEvent: (event) => {
      events.push(event);
    },
  });
  expect(
    events.find((event) => event.type === "run.failed"),
    `${tier}: run.failed`,
  ).toBeUndefined();
  expect(
    events.filter((event) => event.type === "run.completed"),
    `${tier}: run.completed`,
  ).toHaveLength(1);
  expect(seen, `${tier}: one request`).toHaveLength(1);
  const request = seen[0] as Captured;
  return {
    tier,
    request,
    answer: events.map((event) => (event.type === "assistant.delta" ? event.text : "")).join(""),
    events,
    sent: history,
  };
}

/**
 * One conversation: a user question, then an answer from the tier whose turn it is, three times over.
 * Turn n is sent `[u1, A1, ..., un]`, where each earlier answer was written by an earlier tier's model.
 */
async function converse(order: readonly [ModelTierId, ModelTierId, ModelTierId]): Promise<TurnResult[]> {
  const history: Turn[] = [];
  const turns: TurnResult[] = [];
  for (const [index, tier] of order.entries()) {
    history.push({ role: "user", text: `Question ${index + 1}: say your marker.` });
    const turn = await runTurn(tier, [...history], `A${index + 1}-ok`);
    expect(turn.answer, `${tier}: the streamed answer`).toBe(`A${index + 1}-ok`);
    turns.push(turn);
    history.push({ role: "assistant", text: turn.answer });
  }
  return turns;
}

function turnAt(turns: TurnResult[], index: number): TurnResult {
  const turn = turns[index];
  if (!turn) {
    throw new Error(`the conversation has no turn ${index + 1}`);
  }
  return turn;
}

/* ------------------------------------------------------------------------------------------------ */
/* Reading what each wire carried                                                                     */
/* ------------------------------------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every key that appears anywhere in the body, at any depth. */
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      allKeys(item, into);
    }
  } else if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      allKeys(inner, into);
    }
  }
  return into;
}

/** A message `content`, which is a string or a list of blocks, as `[type, text]` pairs for the text-bearing ones. */
function textBlocks(content: unknown): Array<{ type: string; text: string }> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) =>
    isRecord(block) && typeof block.text === "string" ? [{ type: String(block.type), text: block.text }] : [],
  );
}

/** The conversation a wire carried, without the system prompt: `[role, joined text]` per message. */
function transcriptOf(messages: unknown): Turn[] {
  const list = Array.isArray(messages) ? messages : [];
  return list.flatMap((message) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    return [
      {
        role: message.role,
        text: textBlocks(message.content)
          .map((block) => block.text)
          .join("\n"),
      },
    ];
  });
}

/** Keys the other wires own. None of them belongs on this wire. */
const OPENAI_ONLY_KEYS = [
  "reasoning_effort",
  "reasoning_content",
  "input",
  "reasoning",
  "previous_response_id",
  "store",
];
const ANTHROPIC_ONLY_KEYS = ["thinking", "output_config", "system", "max_tokens", "anthropic_version"];

function expectNoKeys(body: Record<string, unknown>, keys: readonly string[], where: string): void {
  const present = allKeys(body);
  for (const key of keys) {
    expect(present.has(key), `${where}: ${key} is on the wire`).toBe(false);
  }
}

function expectAlternating(transcript: Turn[], where: string): void {
  expect(transcript.length, `${where}: some messages`).toBeGreaterThan(0);
  transcript.forEach((message, index) => {
    expect(message.role, `${where}: message ${index}`).toBe(index % 2 === 0 ? "user" : "assistant");
  });
  expect(transcript.at(-1)?.role, `${where}: last message`).toBe("user");
}

/** The history `sent`, as the wire must carry it: the same roles and the same text, in order. */
function expectCarries(request: Captured, tier: ModelTierId, sent: Turn[]): void {
  const setup = TIERS[tier];
  expect(request.url, `${tier}: url`).toBe(`${BASE_URL}${setup.path}`);
  expect(request.body.model, `${tier}: model`).toBe(setup.model);
  expect(request.body.stream, `${tier}: stream`).toBe(true);

  if (tier === "fast") {
    // Completions: the system prompt is the first message, the rest is the conversation.
    const messages = request.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role, "fast: first message").toBe("system");
    expect(messages[0]?.content, "fast: system prompt").toBe(SYSTEM_PROMPT);
    const transcript = transcriptOf(messages);
    expect(transcript, "fast: transcript").toEqual(sent);
    expectAlternating(transcript, "fast");
    // Off is `reasoning_effort: none`, which is this wire's own spelling of it.
    expect(request.body.reasoning_effort, "fast: thinking off").toBe("none");
    expectNoKeys(
      request.body,
      [...ANTHROPIC_ONLY_KEYS.filter((key) => key !== "max_tokens"), "input", "reasoning"],
      "fast",
    );
    return;
  }

  if (tier === "reasoning") {
    // Messages: the system prompt is top-level `system`, never a message.
    const system = textBlocks(request.body.system)
      .map((block) => block.text)
      .join("\n");
    expect(system, "reasoning: system prompt").toContain(SYSTEM_PROMPT);
    const messages = request.body.messages as Array<Record<string, unknown>>;
    expect(
      messages.map((message) => message.role),
      "reasoning: roles",
    ).toEqual(sent.map((turn) => turn.role));
    const transcript = transcriptOf(messages);
    expect(transcript, "reasoning: transcript").toEqual(sent);
    expectAlternating(transcript, "reasoning");
    for (const message of messages) {
      for (const block of textBlocks(message.content)) {
        expect(block.text.trim().length, `reasoning: a ${message.role} text block is blank`).toBeGreaterThan(0);
      }
    }
    // Thinking on at Deep is `adaptive` plus `output_config.effort: high`.
    expect(request.body.thinking, "reasoning: thinking").toEqual({ type: "adaptive" });
    expect(request.body.output_config, "reasoning: effort").toEqual({ effort: "high" });
    expectNoKeys(request.body, OPENAI_ONLY_KEYS, "reasoning");
    return;
  }

  // Responses: the system prompt is the first item, the rest is the conversation.
  const input = request.body.input as Array<Record<string, unknown>>;
  expect(["system", "developer"], "daily: first item").toContain(input[0]?.role);
  expect(
    textBlocks(input[0]?.content)
      .map((block) => block.text)
      .join("\n"),
    "daily: system prompt",
  ).toBe(SYSTEM_PROMPT);
  const transcript = transcriptOf(input);
  expect(transcript, "daily: transcript").toEqual(sent);
  expectAlternating(transcript, "daily");
  // The earlier answers are in `input`, in order.
  expect(
    transcript.filter((message) => message.role === "assistant").map((message) => message.text),
    "daily: earlier answers",
  ).toEqual(sent.filter((turn) => turn.role === "assistant").map((turn) => turn.text));
  expect(request.body.reasoning, "daily: reasoning block").toEqual({ effort: "medium", summary: "auto" });
  expectNoKeys(request.body, [...ANTHROPIC_ONLY_KEYS, "messages", "reasoning_effort", "reasoning_content"], "daily");
}

/* ------------------------------------------------------------------------------------------------ */
/* Tests                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

describe("tier heads", () => {
  it("are the models this file drives", () => {
    for (const tier of ["fast", "reasoning", "daily"] as const) {
      expect(TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID]?.[0], tier).toBe(TIERS[tier].model);
    }
  });
});

describe("one thread, Fastest then Reasoning then Daily", () => {
  it("turn 1: Fastest answers on Completions with the model id and Thinking off", async () => {
    const first = turnAt(await converse(["fast", "reasoning", "daily"]), 0);
    expect(first.request.url).toBe(`${BASE_URL}/chat/completions`);
    expect(first.request.body.model).toBe("deepseek-v4-1-flash");
    expect(first.sent.map((turn) => turn.role)).toEqual(["user"]);
    expectCarries(first.request, "fast", first.sent);
  });

  it("turn 2: Reasoning at Deep gets A1 from another vendor as clean text on Messages", async () => {
    const second = turnAt(await converse(["fast", "reasoning", "daily"]), 1);
    expect(second.sent.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expectCarries(second.request, "reasoning", second.sent);
    const messages = second.request.body.messages as Array<{ role: string; content: unknown }>;
    expect(textBlocks(messages[1]?.content).map((block) => block.text)).toEqual(["A1-ok"]);
  });

  it("turn 3: Daily gets A1 and A2, written by two other vendors, in order on Responses", async () => {
    const third = turnAt(await converse(["fast", "reasoning", "daily"]), 2);
    expect(third.sent.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expectCarries(third.request, "daily", third.sent);
    const answers = transcriptOf(third.request.body.input)
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.text);
    expect(answers).toEqual(["A1-ok", "A2-ok"]);
  });
});

describe("one thread, Daily then Reasoning then Fastest", () => {
  it("carries the same invariants on every wire, whichever vendor wrote the earlier turns", async () => {
    const turns = await converse(["daily", "reasoning", "fast"]);
    expect(turns.map((turn) => turn.tier)).toEqual(["daily", "reasoning", "fast"]);
    for (const turn of turns) {
      expectCarries(turn.request, turn.tier, turn.sent);
    }
    expect(turns.map((turn) => turn.request.url)).toEqual([
      `${BASE_URL}/responses`,
      `${BASE_URL}/messages`,
      `${BASE_URL}/chat/completions`,
    ]);
    // The last turn is Completions and carries both earlier answers, written on Responses and Messages.
    const last = turnAt(turns, 2);
    expect(
      transcriptOf(last.request.body.messages)
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.text),
    ).toEqual(["A1-ok", "A2-ok"]);
  });

  it("does not let a field from an earlier wire leak into the next one", async () => {
    const turns = await converse(["daily", "reasoning", "fast"]);
    const keys = turns.map((turn) => allKeys(turn.request.body));
    // Responses wrote `reasoning`, `input` and `store`; Messages must not have them.
    for (const key of ["reasoning", "input", "store"]) {
      expect(keys[1]?.has(key), `messages has ${key}`).toBe(false);
    }
    // Messages wrote `thinking`, `output_config` and `system`; Completions must not have them.
    for (const key of ["thinking", "output_config", "system"]) {
      expect(keys[2]?.has(key), `completions has ${key}`).toBe(false);
    }
  });
});

describe("a blank assistant turn that reaches the runtime", () => {
  // The runtime drops it on every wire (`toModelMessages`, `packages/core/src/runtime/ai-sdk-runtime.ts:111-123`).
  // Messages rejects a blank text block, and a thread can switch tier (vendor) between turns. The host
  // already skips such rows (`hasModelVisibleContent`, `packages/core/src/content/transcript.ts:121`, used at
  // `packages/host/src/runs.ts:416`); this is the runtime's own guard for a caller that does not.
  const TIER_LIST = ["fast", "reasoning", "daily"] as const;
  const BLANK_TEXTS: Array<[string, string]> = [
    ["whitespace only", "  \n"],
    ["tabs and newlines", "\t\n\n"],
    ["an empty string", ""],
  ];
  const question = (n: number): Turn => ({ role: "user", text: `Question ${n}` });
  /** What `runs.ts:416` hands the runtime after skipping the blank assistant row. */
  const skipped: Turn[] = [question(1), question(2)];

  type Wire = Array<{ role: string; texts: string[] }>;

  /** The conversation a request carried, system prompt left out, as each message's role and text blocks. */
  function wireMessages(tier: ModelTierId, body: Record<string, unknown>): Wire {
    const list = (tier === "daily" ? body.input : body.messages) as Array<{ role: string; content: unknown }>;
    return list
      .filter((message) => message.role !== "system" && message.role !== "developer")
      .map((message) => ({ role: message.role, texts: textBlocks(message.content).map((block) => block.text) }));
  }

  function expectNoBlankText(wire: Wire, where: string): void {
    for (const message of wire) {
      expect(message.texts.length, `${where}: a ${message.role} message with no text`).toBeGreaterThan(0);
      for (const text of message.texts) {
        expect(text.trim().length, `${where}: a blank ${message.role} text`).toBeGreaterThan(0);
      }
    }
  }

  /** The two user questions with nothing between them: one message each, or one merged message on Messages. */
  function expectTwoQuestionsOnly(tier: ModelTierId, wire: Wire): void {
    expect(wire, tier).toEqual(
      tier === "reasoning"
        ? [{ role: "user", texts: ["Question 1", "Question 2"] }]
        : [
            { role: "user", texts: ["Question 1"] },
            { role: "user", texts: ["Question 2"] },
          ],
    );
  }

  for (const tier of TIER_LIST) {
    for (const [name, text] of BLANK_TEXTS) {
      it(`${tier}: an assistant turn of ${name} is dropped, not sent`, async () => {
        const turn = await runTurn(tier, [question(1), { role: "assistant", text }, question(2)], "A2-ok");
        const wire = wireMessages(tier, turn.request.body);
        expectTwoQuestionsOnly(tier, wire);
        expectNoBlankText(wire, tier);
        // The same body the host's own skip produces, so the guard changes nothing else on the wire.
        const viaHost = await runTurn(tier, skipped, "A2-ok");
        expect(turn.request.body, tier).toEqual(viaHost.request.body);
      });
    }

    it(`${tier}: an assistant turn with no text part at all (parts: []) is dropped too`, async () => {
      nextAnswer = "A2-ok";
      seen = [];
      await new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: BASE_URL }).execute({
        tenant,
        runId: `run-no-parts-${tier}`,
        modality: "text",
        version: versionFor(TIERS[tier].model),
        bindings: [],
        history: [
          { role: "user", parts: [{ type: "text", text: "Question 1" }] },
          { role: "assistant", parts: [] },
          { role: "user", parts: [{ type: "text", text: "Question 2" }] },
        ],
        ...TIERS[tier].input,
        onEvent: () => undefined,
      });
      const wire = wireMessages(tier, (seen[0] as Captured).body);
      expectTwoQuestionsOnly(tier, wire);
      expectNoBlankText(wire, tier);
    });

    it(`${tier}: a real earlier answer stays and only the blank one goes`, async () => {
      const history: Turn[] = [
        question(1),
        { role: "assistant", text: "A1-ok" },
        question(2),
        { role: "assistant", text: " \n " },
        question(3),
      ];
      const turn = await runTurn(tier, history, "A3-ok");
      const wire = wireMessages(tier, turn.request.body);
      expectNoBlankText(wire, tier);
      expect(
        wire.map((message) => message.role),
        tier,
      ).toEqual(tier === "reasoning" ? ["user", "assistant", "user"] : ["user", "assistant", "user", "user"]);
      expect(
        wire.filter((message) => message.role === "assistant").map((message) => message.texts),
        tier,
      ).toEqual([["A1-ok"]]);
      expect(wire.at(-1)?.texts, tier).toEqual(tier === "reasoning" ? ["Question 2", "Question 3"] : ["Question 3"]);
    });

    it(`${tier}: an assistant turn with text is sent byte for byte, edge whitespace included`, async () => {
      const history: Turn[] = [question(1), { role: "assistant", text: "  A1-ok \n" }, question(2)];
      const turn = await runTurn(tier, history, "A2-ok");
      expect(wireMessages(tier, turn.request.body), tier).toEqual([
        { role: "user", texts: ["Question 1"] },
        { role: "assistant", texts: ["  A1-ok \n"] },
        { role: "user", texts: ["Question 2"] },
      ]);
    });
  }
});
