/**
 * `ask_nultron`, the read-only thinker (plan W3, W5), driven through the real code: `prepareChatRun`
 * (the agent, model, prompt and Knowledge Base a typed turn has), the real AI SDK runtime and the real
 * wire body, the real tools, the real thread and usage stores. The only stand-in is `fetch`, which
 * records what the gateway would have received and answers like one. Nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { DELEGATE_PER_TURN, DELEGATE_TOOL_KEY, GENERALIST_WORKER_TOOLS, getTool } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { ASK_COPY } from "./ask-speech";
import { REQUEST_TAP_TOOL_KEY, VOICE_DELEGATE_TOOLS, VOICE_READ_TOOLS } from "./ask-tools";
import type { VoiceLocale } from "./turns";

delete process.env.OPENAI_API_KEY;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => {
      const runtime = new actual.AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" });
      // The default Chat model speaks the Responses wire; the stand-in gateway speaks chat completions, so
      // the wire is pinned here. Everything else is the run exactly as the host built it.
      return {
        execute: (input) => runtime.execute(actual.maskOutboundRunInput({ ...input, wire: "chat_completions" })),
      };
    },
  };
});

type Captured = { url: string; body: Record<string, unknown>; signal: AbortSignal | undefined };
type Responder = (request: Captured) => Response | Promise<Response>;

let seen: Captured[] = [];
/** One responder per gateway call, in order. A call past the end gets a short plain answer. */
let script: Responder[] = [];
/** Resolved each time the stand-in gateway receives a call. */
let onCall: (() => void) | null = null;

const encoder = new TextEncoder();
const USAGE = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

function sse(frames: unknown[]): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: typeof USAGE) {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

function says(text: string): Responder {
  return () => sse([chunk({ role: "assistant", content: text }, null), chunk({}, "stop", USAGE)]);
}

function calls(name: string, args: Record<string, unknown>): Responder {
  return () =>
    sse([
      chunk(
        {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        null,
      ),
      chunk({}, "tool_calls", USAGE),
    ]);
}

function refusedWith(status: number): Responder {
  return () =>
    new Response(JSON.stringify({ error: { message: "nope", type: "invalid_request_error" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Never answers; ends only when the request is cancelled, like a real socket would. */
const hangs: Responder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    request.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      {
        once: true,
      },
    );
  });

function nextCall(): Promise<void> {
  return new Promise<void>((resolve) => {
    onCall = resolve;
  });
}

type WireMessage = { role: string; content: unknown };

function messagesOf(request: Captured): WireMessage[] {
  return (request.body.messages ?? []) as WireMessage[];
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) =>
          typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "",
        )
        .join("\n")
    : "";
}

function toolNames(request: Captured): string[] {
  const tools = (request.body.tools ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((tool) => tool.function?.name ?? "");
}

let tenant: TenantContext;
let agentId = "";
let ask: typeof import("./ask").askNultron;
let threads: typeof import("../threads");
let usage: typeof import("../tenant-usage");

async function newThread(): Promise<string> {
  return (await threads.createThread(tenant, agentId, "Voice thread")).id;
}

async function ask1(
  threadId: string,
  question: string,
  extra: {
    locale?: VoiceLocale;
    signal?: AbortSignal;
    timeoutMs?: number;
    delegateTimeoutMs?: number;
    onProgress?: (label: string) => void;
  } = {},
) {
  return ask(
    {
      tenant,
      threadId,
      question,
      locale: extra.locale ?? "en",
      signal: extra.signal ?? new AbortController().signal,
      ...(extra.onProgress ? { onProgress: extra.onProgress } : {}),
    },
    {
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
      ...(extra.delegateTimeoutMs === undefined ? {} : { delegateTimeoutMs: extra.delegateTimeoutMs }),
    },
  );
}

/** Waits until the stand-in gateway has seen `count` calls (the delegated run's call is not the first). */
async function untilSeen(count: number): Promise<void> {
  const start = Date.now();
  while (seen.length < count) {
    if (Date.now() - start > 5_000) {
      throw new Error(`timed out waiting for gateway call ${count}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function voiceUsageRows() {
  return usage.listTenantUsage(tenant).filter((row) => row.runId?.startsWith("voice-ask-"));
}

beforeAll(async () => {
  const { agentService, getTenant } = await import("../tenant");
  tenant = await getTenant();
  agentId = (await agentService.ensureDefaultChat(tenant)).agent.id;
  ({ askNultron: ask } = await import("./ask"));
  threads = await import("../threads");
  usage = await import("../tenant-usage");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  seen = [];
  script = [];
  onCall = null;
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const request: Captured = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    seen.push(request);
    onCall?.();
    const responder = script.shift() ?? says("Okay.");
    return responder(request);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.AGENTFORGE_RUNTIME = "stub";
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("an answer", () => {
  it("comes back as plain speech, with the markdown a model still wrote stripped", async () => {
    script = [
      says("**Revenue** was 1,200 dollars [1].\n\n- It rose five percent.\n- See [the report](https://example.com/r)."),
    ];
    const threadId = await newThread();
    const result = await ask1(threadId, "How was revenue?");
    expect(result).toEqual({
      kind: "answer",
      text: "Revenue was 1,200 dollars. It rose five percent. See the report.",
      toolCalls: [],
    });
  });

  it("reaches the gateway once, on the chat wire, with no thinking and the voice note last", async () => {
    script = [says("Fine.")];
    const threadId = await newThread();
    await ask1(threadId, "How are you?");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/chat/completions");
    const system = textOfContent(messagesOf(seen[0] as Captured)[0]?.content);
    // Newer OpenAI models are given the lead turn as `developer`, the older ones as `system`.
    expect(messagesOf(seen[0] as Captured)[0]?.role).toMatch(/^(system|developer)$/);
    expect(system.trim().endsWith("do not do it yourself.")).toBe(true);
    expect(system).toContain("spoken aloud, in English");
    expect(system).toContain("at most three short sentences");
    expect(system).toContain("You are the general assistant on the owner's desk");
    const effort = ((seen[0] as Captured).body as { reasoning_effort?: unknown }).reasoning_effort;
    expect(effort === undefined || effort === "none").toBe(true);
  });

  it("tells the model the session's language, whatever the person's screen language is", async () => {
    script = [says("Baik.")];
    const threadId = await newThread();
    await ask1(threadId, "Apa kabar?", { locale: "id" });
    const system = textOfContent(messagesOf(seen[0] as Captured)[0]?.content);
    expect(system).toContain("spoken aloud, in Indonesian (Bahasa Indonesia)");
  });
});

describe("what the model is given", () => {
  it("is the thread's earlier messages, then the question as the last user turn", async () => {
    const threadId = await newThread();
    await threads.insertMessage(tenant, threadId, "user", [{ type: "text", text: "earlier question alpha" }]);
    await threads.insertMessage(tenant, threadId, "assistant", [{ type: "text", text: "earlier answer beta" }]);
    script = [says("Gamma.")];
    await ask1(threadId, "the new question gamma?");

    const messages = messagesOf(seen[0] as Captured).filter(
      (message) => message.role !== "system" && message.role !== "developer",
    );
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(textOfContent(messages[0]?.content)).toContain("earlier question alpha");
    expect(textOfContent(messages[1]?.content)).toContain("earlier answer beta");
    expect(textOfContent(messages[2]?.content)).toContain("the new question gamma?");
  });

  it("does not send the question twice when the relay already saved it as the last row", async () => {
    const threadId = await newThread();
    await threads.insertMessage(tenant, threadId, "user", [{ type: "text", text: "what is the plan?" }]);
    script = [says("The plan.")];
    await ask1(threadId, "what is the plan?");
    const users = messagesOf(seen[0] as Captured).filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
  });

  it("still sends a question the person repeats after an answer", async () => {
    const threadId = await newThread();
    await threads.insertMessage(tenant, threadId, "user", [{ type: "text", text: "what is the plan?" }]);
    await threads.insertMessage(tenant, threadId, "assistant", [{ type: "text", text: "A plan." }]);
    script = [says("The plan again.")];
    await ask1(threadId, "what is the plan?");
    const users = messagesOf(seen[0] as Captured).filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
  });

  it("offers a Knowledge Base read tool and request_tap, and no tool that writes, sends or spends", async () => {
    script = [says("Fine.")];
    const threadId = await newThread();
    await ask1(threadId, "Anything in my notes?");
    const names = toolNames(seen[0] as Captured);
    expect(names).toContain("knowledge_search");
    expect(names).toContain(REQUEST_TAP_TOOL_KEY);
    // `delegate` is the one long-work tool voice runs itself; the generalist workers stay tap-only.
    expect(names).toContain(DELEGATE_TOOL_KEY);
    for (const name of [
      "write_file",
      "edit_file",
      "delete_file",
      "image_generate",
      "video_generate",
      "build_deck",
      "run_code",
      ...GENERALIST_WORKER_TOOLS,
    ]) {
      expect(names, name).not.toContain(name);
    }
    const allowed = new Set<string>([...VOICE_READ_TOOLS, ...VOICE_DELEGATE_TOOLS, REQUEST_TAP_TOOL_KEY]);
    expect(names.filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("runs a read tool and answers from its result", async () => {
    script = [calls("knowledge_search", { query: "revenue" }), says("Nothing in the notes yet.")];
    const threadId = await newThread();
    const result = await ask1(threadId, "What do my notes say about revenue?");
    expect(result).toEqual({ kind: "answer", text: "Nothing in the notes yet.", toolCalls: [] });
    expect(seen).toHaveLength(2);
    expect(messagesOf(seen[1] as Captured).some((message) => message.role === "tool")).toBe(true);
  });

  it("never runs a write tool a model asks for anyway", async () => {
    const write = getTool("write_file");
    expect(write).toBeDefined();
    const spy = vi.spyOn(write as NonNullable<typeof write>, "execute");
    script = [calls("write_file", { path: "x.txt", content: "hi" }), says("I can't write files by voice.")];
    const threadId = await newThread();
    const result = await ask1(threadId, "Write x.txt for me");
    expect(spy).not.toHaveBeenCalled();
    expect(result.kind).toBe("answer");
  });
});

describe("a request that needs a tap", () => {
  it("stops the run at request_tap and returns the card, with the person's own words as the prompt", async () => {
    script = [calls(REQUEST_TAP_TOOL_KEY, { summary: "Make a deck about the third quarter" })];
    const threadId = await newThread();
    const question = "make me a deck about Q3";
    const result = await ask1(threadId, question);
    expect(result).toEqual({
      kind: "needs_tap",
      text: ASK_COPY.en.needsTap,
      card: { prompt: question, summary: "Make a deck about the third quarter" },
    });
    // The run stopped: no second model call went out to finish the turn.
    expect(seen).toHaveLength(1);
  });

  it("falls back to the person's words when the model gave no summary", async () => {
    script = [calls(REQUEST_TAP_TOOL_KEY, {})];
    const threadId = await newThread();
    const result = await ask1(threadId, "edit my notes file");
    expect(result).toMatchObject({
      kind: "needs_tap",
      card: { prompt: "edit my notes file", summary: "edit my notes file" },
    });
  });

  it("speaks the fixed sentence in the session's language", async () => {
    script = [calls(REQUEST_TAP_TOOL_KEY, { summary: "Buat deck" })];
    const threadId = await newThread();
    const result = await ask1(threadId, "buatkan deck", { locale: "id" });
    expect(result).toMatchObject({ kind: "needs_tap", text: ASK_COPY.id.needsTap });
  });
});

describe("a refusal", () => {
  it("is gateway_blocked when the key is missing, before any model call", async () => {
    process.env.AGENTFORGE_RUNTIME = "ai";
    const threadId = await newThread();
    const result = await ask1(threadId, "Hello?");
    expect(result).toEqual({ kind: "refused", reason: "gateway_blocked", text: ASK_COPY.en.gatewayBlocked });
    expect(seen).toHaveLength(0);
  });

  it("is timeout when nothing comes back in time, and the call in flight is cancelled", async () => {
    script = [hangs];
    const threadId = await newThread();
    const started = Date.now();
    const result = await ask1(threadId, "Hello?", { timeoutMs: 150 });
    expect(result).toEqual({ kind: "refused", reason: "timeout", text: ASK_COPY.en.timeout });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  it("is failed, at once, when the person cuts in, and the call in flight is cancelled", async () => {
    script = [hangs];
    const threadId = await newThread();
    const abort = new AbortController();
    const called = nextCall();
    const pending = ask1(threadId, "Hello?", { signal: abort.signal });
    await called;
    const started = Date.now();
    abort.abort();
    const result = await pending;
    expect(result).toEqual({ kind: "refused", reason: "failed", text: ASK_COPY.en.failed });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  it("does not start at all for a signal that was already aborted", async () => {
    const threadId = await newThread();
    const abort = new AbortController();
    abort.abort();
    const result = await ask1(threadId, "Hello?", { signal: abort.signal });
    expect(result).toMatchObject({ kind: "refused", reason: "failed" });
    expect(seen).toHaveLength(0);
  });

  it("is busy for a second ask on a thread that already has one running, and only that thread", async () => {
    script = [hangs];
    const threadId = await newThread();
    const other = await newThread();
    const abort = new AbortController();
    const called = nextCall();
    const first = ask1(threadId, "First?", { signal: abort.signal });
    await called;

    const second = await ask1(threadId, "Second?");
    expect(second).toEqual({ kind: "refused", reason: "busy", text: ASK_COPY.en.busy });
    expect(seen).toHaveLength(1);

    // Another thread is not blocked by it.
    script = [says("Fine.")];
    expect(await ask1(other, "Elsewhere?")).toMatchObject({ kind: "answer" });

    abort.abort();
    await first;
    // The thread is free again once the first ask has ended.
    script = [says("Free.")];
    expect(await ask1(threadId, "Third?")).toMatchObject({ kind: "answer", text: "Free." });
  });

  it("is failed, never a throw, for a gateway error", async () => {
    script = [refusedWith(400)];
    const threadId = await newThread();
    await expect(ask1(threadId, "Hello?")).resolves.toEqual({
      kind: "refused",
      reason: "failed",
      text: ASK_COPY.en.failed,
    });
  });

  it("is a refusal, never a throw, for a gateway 500", async () => {
    script = [refusedWith(500), refusedWith(500), refusedWith(500), refusedWith(500)];
    const threadId = await newThread();
    const result = await ask1(threadId, "Hello?", { timeoutMs: 8_000 });
    expect(result.kind).toBe("refused");
    expect(["failed", "timeout"]).toContain((result as { reason: string }).reason);
  });

  it("is a refusal, never a throw, for a stream that breaks", async () => {
    script = [
      () =>
        new Response(encoder.encode('data: {"choices":[{"delta":{"content":"Par'), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      () =>
        new Response(encoder.encode("data: {not json}\n\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ];
    const threadId = await newThread();
    const result = await ask1(threadId, "Hello?", { timeoutMs: 8_000 });
    expect(result.kind).toBe("refused");
  });

  it("is failed for a thread that does not exist, and for an empty question", async () => {
    await expect(ask1("no-such-thread", "Hello?")).resolves.toMatchObject({ kind: "refused", reason: "failed" });
    const threadId = await newThread();
    await expect(ask1(threadId, "   ")).resolves.toMatchObject({ kind: "refused", reason: "failed" });
    expect(seen).toHaveLength(0);
  });

  it("is failed when the answer was only markup", async () => {
    script = [says("![x](y)")];
    const threadId = await newThread();
    expect(await ask1(threadId, "Hello?")).toMatchObject({ kind: "refused", reason: "failed" });
  });
});

describe("every fixed sentence, in both languages", () => {
  for (const locale of ["en", "id"] as const) {
    it(`speaks the ${locale} sentence for each refusal and for the tap`, async () => {
      const copy = ASK_COPY[locale];
      const threadId = await newThread();

      process.env.AGENTFORGE_RUNTIME = "ai";
      expect(await ask1(threadId, "x?", { locale })).toEqual({
        kind: "refused",
        reason: "gateway_blocked",
        text: copy.gatewayBlocked,
      });
      process.env.AGENTFORGE_RUNTIME = "stub";

      script = [hangs];
      expect(await ask1(threadId, "x?", { locale, timeoutMs: 100 })).toEqual({
        kind: "refused",
        reason: "timeout",
        text: copy.timeout,
      });

      script = [refusedWith(400)];
      expect(await ask1(threadId, "x?", { locale })).toEqual({ kind: "refused", reason: "failed", text: copy.failed });

      script = [hangs];
      const abort = new AbortController();
      const called = nextCall();
      const first = ask1(threadId, "x?", { locale, signal: abort.signal });
      await called;
      expect(await ask1(threadId, "y?", { locale })).toEqual({ kind: "refused", reason: "busy", text: copy.busy });
      abort.abort();
      await first;

      script = [calls(REQUEST_TAP_TOOL_KEY, { summary: "Start it" })];
      expect(await ask1(threadId, "x?", { locale })).toMatchObject({ kind: "needs_tap", text: copy.needsTap });
    });
  }
});

describe("the thread", () => {
  async function snapshot(threadId: string) {
    const rows = await threads.listMessages(tenant, threadId);
    const runs = await threads.listRunUsage(tenant);
    const thread = await threads.getThread(tenant, threadId);
    return { messages: rows.length, runs: runs.length, title: thread?.title };
  }

  it("gets no message, run row or title from an answer, a tap or a refusal", async () => {
    const threadId = await newThread();
    await threads.insertMessage(tenant, threadId, "user", [{ type: "text", text: "earlier" }]);
    await threads.insertMessage(tenant, threadId, "assistant", [{ type: "text", text: "reply" }]);
    const before = await snapshot(threadId);
    expect(before.messages).toBe(2);

    script = [says("An answer.")];
    expect(await ask1(threadId, "A question that would name the thread?")).toMatchObject({ kind: "answer" });
    expect(await snapshot(threadId)).toEqual(before);

    script = [calls("knowledge_search", { query: "x" }), says("After a tool.")];
    expect(await ask1(threadId, "Another?")).toMatchObject({ kind: "answer" });
    expect(await snapshot(threadId)).toEqual(before);

    script = [calls(REQUEST_TAP_TOOL_KEY, { summary: "Do it" })];
    expect(await ask1(threadId, "Make a deck")).toMatchObject({ kind: "needs_tap" });
    expect(await snapshot(threadId)).toEqual(before);

    script = [refusedWith(400)];
    expect(await ask1(threadId, "A failure")).toMatchObject({ kind: "refused" });
    expect(await snapshot(threadId)).toEqual(before);
  });
});

describe("usage", () => {
  it("records the run's model tokens once, as a Chat run, under the voice ask's own id", async () => {
    script = [says("Fine.")];
    const threadId = await newThread();
    const before = voiceUsageRows().length;
    await ask1(threadId, "How are you?");
    const rows = voiceUsageRows();
    expect(rows).toHaveLength(before + 1);
    const row = rows[0];
    expect(row).toMatchObject({ mode: "chat", unit: "tokens", inputTokens: 7, outputTokens: 3, quantity: 10 });
    expect(row?.runId).toMatch(/^voice-ask-/);
  });

  it("records a run that was stopped after it reached the model as a call of unknown size", async () => {
    script = [calls(REQUEST_TAP_TOOL_KEY, { summary: "Make a deck" })];
    const threadId = await newThread();
    const before = voiceUsageRows().length;
    await ask1(threadId, "Make a deck");
    const rows = voiceUsageRows();
    expect(rows).toHaveLength(before + 1);
    // No tokens to count and no price: the row says a call happened, not how big it was.
    expect(rows[0]).toMatchObject({
      mode: "chat",
      unit: "tokens",
      inputTokens: 0,
      outputTokens: 0,
      quantity: 0,
      costUsdMicros: null,
    });
  });

  it("records nothing for a refusal that never reached the model", async () => {
    const threadId = await newThread();
    const before = voiceUsageRows().length;
    process.env.AGENTFORGE_RUNTIME = "ai";
    await ask1(threadId, "Hello?");
    process.env.AGENTFORGE_RUNTIME = "stub";
    await ask1("no-such-thread", "Hello?");
    expect(voiceUsageRows()).toHaveLength(before);
  });
});

describe("the run cap", () => {
  const hosted = (cap: string) => ({ AGENTFORGE_SERVER: "1", AGENTFORGE_MAX_RUNS_PER_TENANT: cap });
  let admit: typeof import("./ask").admitVoiceSlot;
  let limits: typeof import("../run-limits");

  beforeAll(async () => {
    ({ admitVoiceSlot: admit } = await import("./ask"));
    limits = await import("../run-limits");
  }, ROUTER_IMPORT_BUDGET_MS);

  it("takes a slot, answers at once, and leaves the last one for typed Chat", () => {
    const env = hosted("3");
    const held = [limits.admitRun(tenant, env), limits.admitRun(tenant, env)];
    expect(limits.activeRuns(tenant)).toBe(2);

    // Two of three are in use: voice is told busy, and does not wait.
    expect(admit(tenant, env)).toBeNull();
    expect(limits.activeRuns(tenant)).toBe(2);

    held.pop()?.();
    const voice = admit(tenant, env);
    expect(voice).not.toBeNull();
    expect(limits.activeRuns(tenant)).toBe(2);

    // The slot voice left is still there for a typed turn.
    const typed = limits.admitRun(tenant, env);
    expect(limits.activeRuns(tenant)).toBe(3);
    typed();
    voice?.();
    held.pop()?.();
    expect(limits.activeRuns(tenant)).toBe(0);
  });

  it("gives its slot back once, however often release is called", () => {
    const env = hosted("3");
    const voice = admit(tenant, env);
    expect(limits.activeRuns(tenant)).toBe(1);
    voice?.();
    voice?.();
    expect(limits.activeRuns(tenant)).toBe(0);
  });

  it("uses the only slot of a cap of one, and is refused by a cap of zero", () => {
    const one = admit(tenant, hosted("1"));
    expect(one).not.toBeNull();
    one?.();
    expect(admit(tenant, hosted("0"))).toBeNull();
    expect(limits.activeRuns(tenant)).toBe(0);
  });

  it("takes no slot on a desk, where there is no cap", () => {
    const release = admit(tenant, {});
    expect(release).not.toBeNull();
    expect(limits.activeRuns(tenant)).toBe(0);
    release?.();
  });
});

describe("delegation from voice", () => {
  let createTeamBot: typeof import("../team-bots").createTeamBot;
  let releaseTeamBot: typeof import("../team-bots").releaseTeamBot;

  beforeAll(async () => {
    ({ createTeamBot, releaseTeamBot } = await import("../team-bots"));
    await createTeamBot(tenant, {
      name: "Tide bot",
      role: "tide times",
      prompt: "You answer tide questions in one short sentence.",
    });
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    await releaseTeamBot(tenant, "Tide bot");
  });

  it("offers delegate Chat's per-turn ceiling inside the voice budget", async () => {
    const { VOICE_BUDGET, ASK_DELEGATE_TIMEOUT_MS, ASK_TIMEOUT_MS } = await import("./ask");
    expect(VOICE_BUDGET.perTool?.[DELEGATE_TOOL_KEY]).toBe(DELEGATE_PER_TURN);
    expect(ASK_DELEGATE_TIMEOUT_MS).toBe(180_000);
    expect(ASK_DELEGATE_TIMEOUT_MS).toBeGreaterThan(ASK_TIMEOUT_MS);
  });

  it("runs delegate to a desk bot, reports its progress, and returns the call for the card", async () => {
    const progress: string[] = [];
    script = [
      calls(DELEGATE_TOOL_KEY, {
        agent: "Tide bot",
        task: "Find the tide times for Surabaya on Friday.",
      }),
      says("The tide is at 06:10."),
      says("Tide bot found the tide at 06:10."),
    ];
    const threadId = await newThread();
    const result = await ask1(threadId, "Ask Tide bot for the Surabaya tide times", {
      onProgress: (label) => progress.push(label),
    });
    if (result.kind !== "answer") {
      throw new Error(`expected an answer, got ${result.kind}`);
    }
    expect(result.text).toBe("Tide bot found the tide at 06:10.");
    // Three gateway calls: the asker, the delegated run, the asker's answer.
    expect(seen).toHaveLength(3);
    expect(progress.some((label) => label.includes("Tide"))).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    const part = result.toolCalls[0];
    expect(part).toMatchObject({
      type: "tool_call",
      toolKey: DELEGATE_TOOL_KEY,
      status: "completed",
    });
    expect(part?.input).toMatchObject({ agent: "Tide bot" });
    expect(part?.output).toMatchObject({ ok: true, agentName: "Tide bot" });
    expect((part?.output as { summary?: string } | undefined)?.summary).toContain("06:10");
  });

  it("keeps a refused delegation as a completed call, so the card can say why", async () => {
    script = [
      calls(DELEGATE_TOOL_KEY, { agent: "nobody-here", task: "Find the tide times for Surabaya." }),
      says("Nobody by that name is on the desk."),
    ];
    const threadId = await newThread();
    const result = await ask1(threadId, "Ask nobody-here for the tide");
    if (result.kind !== "answer") {
      throw new Error(`expected an answer, got ${result.kind}`);
    }
    expect(seen).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.output).toMatchObject({ ok: false, reason: "not_hired" });
  });

  it("holds the ask to the delegation clock once delegate starts, and still ends there", async () => {
    script = [
      calls(DELEGATE_TOOL_KEY, { agent: "Tide bot", task: "Find the tide times for Surabaya on Friday." }),
      hangs,
    ];
    const threadId = await newThread();
    const started = Date.now();
    const result = await ask1(threadId, "Ask Tide bot for the tide", {
      timeoutMs: 80,
      delegateTimeoutMs: 600,
    });
    expect(result).toMatchObject({ kind: "refused", reason: "timeout" });
    const elapsed = Date.now() - started;
    // The 80 ms clock would have ended it almost at once; the delegation clock holds it to ~600 ms.
    expect(elapsed).toBeGreaterThan(200);
    expect(elapsed).toBeLessThan(3_000);
    // The delegated run's call in flight was cancelled with the ask.
    expect(seen[1]?.signal?.aborted).toBe(true);
  });

  it("passes the caller's abort through the worker channel to the delegated run", async () => {
    script = [
      calls(DELEGATE_TOOL_KEY, { agent: "Tide bot", task: "Find the tide times for Surabaya on Friday." }),
      hangs,
    ];
    const threadId = await newThread();
    const abort = new AbortController();
    const pending = ask1(threadId, "Ask Tide bot for the tide", { signal: abort.signal });
    await untilSeen(2);
    abort.abort();
    const result = await pending;
    expect(result).toMatchObject({ kind: "refused", reason: "failed" });
    // The second gateway call is the delegated run's: its socket was cancelled by the caller's abort.
    expect(seen[1]?.signal?.aborted).toBe(true);
  });
});
