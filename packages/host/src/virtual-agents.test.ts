import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHAT_SLUG,
  FIRST_RUN_MODES,
  PRODUCT_MODE_IDS,
  VIRTUAL_AGENTS,
  virtualAgentFor,
  type AgentRuntime,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import { WORKER_STREAM_IDLE_MS } from "./workers/worker-channel";
import type { HostRequest, HostResult } from "./types";

/**
 * Virtual agents on the host (tester code, `docs/internal/chat-first-plan.md` track B), through the
 * real router on a fresh data dir.
 *
 * What is proven: the catalog a first desk gets (the first-desk rule carries over from
 * `FIRST_RUN_MODES`), that a mode agent owns exactly one row and its threads, that the prompt never
 * reaches the renderer, and that a run of a mode agent's conversation takes its prompt, tools and
 * budget from the registry in code. Runs use the stub runtime; one case swaps in a runtime that
 * records what the run was handed, because the stub does not say which tools it was offered.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-virtual-agents-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

/** A 1x1 PNG, so an image reaches the run without a web link (which the host refuses). */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const swap = vi.hoisted(() => ({ runtime: null as null | { execute: (input: unknown) => Promise<void> } }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    // The real stub runtime unless a case sets `swap.runtime`.
    createRuntime: (settings: Parameters<typeof actual.createRuntime>[0]) =>
      (swap.runtime as AgentRuntime | null) ?? actual.createRuntime(settings),
  };
});

type View = {
  id: string;
  generalist: boolean;
  conversation: string;
  agentId: string | null;
  tools: string[];
  budget: { maxSteps: number; maxToolCalls: number };
  [key: string]: unknown;
};
type Catalog = { agents: View[]; available: View[] };
type ThreadRow = { id: string; title: string; agentId: string; isDefaultChat: boolean };

let dispatch: (request: HostRequest) => Promise<HostResult>;
let runPolicyFor: typeof import("./virtual-agents").runPolicyFor;
let runWithWorkerProgress: typeof import("./workers/worker-channel").runWithWorkerProgress;
let chatAgentId = "";
let researchAgentId = "";
let imagesAgentId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const result = await dispatch(request(method, path, { body, query }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as T };
}

async function catalog(): Promise<Catalog> {
  const answer = await call<Catalog>("GET", "/api/v1/virtual-agents");
  expect(answer.status).toBe(200);
  return answer.body;
}

async function threadsOf(query: Record<string, string>): Promise<ThreadRow[]> {
  const answer = await call<{ threads: ThreadRow[] }>("GET", "/api/v1/threads", undefined, query);
  expect(answer.status).toBe(200);
  return answer.body.threads;
}

async function newThread(agentId: string, title?: string): Promise<string> {
  const created = await call<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId, title });
  expect(created.status).toBe(201);
  return created.body.thread.id;
}

/** Posts one message and reads the stream to its end. Returns the SSE event names in order and the frames. */
async function send(
  threadId: string,
  content: string,
): Promise<{ types: string[]; frames: Array<Record<string, unknown>> }> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  let raw = "";
  for await (const chunk of result.events) {
    raw += chunk;
  }
  const frames: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    if (data) {
      frames.push(JSON.parse(data.slice("data: ".length)) as Record<string, unknown>);
    }
  }
  return { types: frames.map((frame) => String(frame.type)), frames };
}

let countRows: (slug: string) => number;

function rowsWithSlug(slug: string): number {
  return countRows(slug);
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  ({ runPolicyFor } = await import("./virtual-agents"));
  ({ runWithWorkerProgress } = await import("./workers/worker-channel"));
  const { sql } = await import("@agentforge/db");
  countRows = (slug) => (sql.prepare("SELECT count(*) AS n FROM agents WHERE slug = ?").get(slug) as { n: number }).n;
  // The generalist's row and the desk exist before the catalog is asked for, so the first case below
  // races only the row of the Research agent.
  const chat = await call<{ agent: { id: string } }>("GET", "/api/v1/chat");
  chatAgentId = chat.body.agent.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  swap.runtime = null;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("GET /api/v1/virtual-agents on a fresh desk", () => {
  it("makes one Research row even when two first requests arrive together", async () => {
    expect(rowsWithSlug("va-research")).toBe(0);

    const [first, second] = await Promise.all([catalog(), catalog()]);

    const idOf = (data: Catalog) => data.agents.find((agent) => agent.id === "research")?.agentId;
    expect(idOf(first)).toBeTruthy();
    expect(idOf(second)).toBe(idOf(first));
    expect(rowsWithSlug("va-research")).toBe(1);
    researchAgentId = idOf(first) as string;
    imagesAgentId = first.agents.find((agent) => agent.id === "images")?.agentId as string;
  });

  it("lists exactly the first-desk agents, in order", async () => {
    const data = await catalog();

    expect([...FIRST_RUN_MODES]).toEqual(["chat", "research", "images", "videos", "presentations"]);
    expect(data.agents.map((agent) => agent.id)).toEqual(["chat", "research", "images", "videos", "presentations"]);
  });

  it("offers every other mode as available, and none of the five on the desk", async () => {
    const data = await catalog();
    const onDesk = new Set(data.agents.map((agent) => agent.id));

    expect(data.available.some((agent) => onDesk.has(agent.id))).toBe(false);
    expect(data.available.map((agent) => agent.id).sort()).toEqual(
      PRODUCT_MODE_IDS.filter((id) => !onDesk.has(id)).sort(),
    );
    // The registry has one agent per mode, so nothing is lost between the two lists.
    expect(data.agents.length + data.available.length).toBe(VIRTUAL_AGENTS.length);
    // No row is made for an agent the desk has not hired.
    for (const agent of data.available) {
      expect(agent.agentId).toBeNull();
    }
  });

  it("gives all five desk agents a row of their own, each different", async () => {
    const data = await catalog();
    const ids = data.agents.map((agent) => agent.agentId);

    expect(ids).toHaveLength(5);
    for (const id of ids) {
      expect(typeof id === "string" && id.length > 0).toBe(true);
    }
    expect(new Set(ids).size).toBe(5);
  });

  it("makes no second row for any agent on a later call", async () => {
    const first = await catalog();
    const second = await catalog();

    expect(second.agents.map((agent) => agent.agentId)).toEqual(first.agents.map((agent) => agent.agentId));
    for (const agent of VIRTUAL_AGENTS.filter(
      (entry) => !entry.generalist && first.agents.some((view) => view.id === entry.id),
    )) {
      expect(rowsWithSlug(agent.slug), agent.slug).toBe(1);
    }
  });

  it("describes Chat as the generalist whose conversation is its default chat row", async () => {
    const data = await catalog();
    const chat = data.agents.find((agent) => agent.id === "chat");

    expect(chat).toMatchObject({ generalist: true, conversation: "harness" });
    expect(chat?.agentId).toBeTruthy();
    expect(chat?.agentId).toBe(chatAgentId);
  });

  it("describes Research as a harness agent with the full tool set, Chat's budget and its own row", async () => {
    const data = await catalog();
    const research = data.agents.find((agent) => agent.id === "research");
    const full = virtualAgentFor("chat");

    expect(research).toMatchObject({
      generalist: false,
      conversation: "harness",
      tools: [...full.tools],
      budget: { maxSteps: full.budget.maxSteps, maxToolCalls: full.budget.maxToolCalls },
    });
    expect(research?.tools).toContain("research_dossier");
    expect(research?.agentId).toBeTruthy();
    expect(research?.agentId).not.toBe(chatAgentId);
  });

  it("describes Images, Videos and Presentations as studio agents that still have a row and the full tools", async () => {
    const data = await catalog();
    const full = [...virtualAgentFor("chat").tools];

    for (const id of ["images", "videos", "presentations"]) {
      const agent = data.agents.find((entry) => entry.id === id);
      expect(agent, id).toMatchObject({ conversation: "studio", tools: full });
      expect(agent?.agentId, id).toBeTruthy();
    }
  });

  it("never sends a prompt to the renderer", async () => {
    const data = await catalog();

    for (const agent of [...data.agents, ...data.available]) {
      expect(Object.keys(agent), agent.id).not.toContain("prompt");
      expect(Object.keys(agent), agent.id).not.toContain("systemPrompt");
    }
    const text = JSON.stringify(data);
    expect(text).not.toContain("You are the Research agent");
  });

  it("returns the same Research row on every later request", async () => {
    const again = await catalog();
    const once = again.agents.find((agent) => agent.id === "research")?.agentId;
    const twice = (await catalog()).agents.find((agent) => agent.id === "research")?.agentId;

    expect(once).toBe(researchAgentId);
    expect(twice).toBe(researchAgentId);
    expect(rowsWithSlug("va-research")).toBe(1);
  });
});

describe("GET /api/v1/chat", () => {
  it("lists no mode agent among the specialists", async () => {
    const chat = await call<{ agent: { id: string; slug: string }; specialists: Array<{ id: string; name: string }> }>(
      "GET",
      "/api/v1/chat",
    );

    expect(chat.status).toBe(200);
    expect(chat.body.agent.id).toBe(chatAgentId);
    expect(chat.body.specialists.map((agent) => agent.id)).not.toContain(researchAgentId);
    expect(chat.body.specialists).toEqual([]);
  });
});

describe("threads of a mode agent", () => {
  it("creates a thread on the Research row and lists it by agent, never under Chat", async () => {
    const threadId = await newThread(researchAgentId, "E-invoicing dossier");

    const ofResearch = await threadsOf({ scope: "agent", agentId: researchAgentId });
    const ofChat = await threadsOf({ scope: "chat" });

    expect(ofResearch.map((thread) => thread.id)).toContain(threadId);
    expect(ofResearch.every((thread) => thread.agentId === researchAgentId)).toBe(true);
    expect(ofResearch.find((thread) => thread.id === threadId)).toMatchObject({
      title: "E-invoicing dossier",
      isDefaultChat: false,
    });
    expect(ofChat.map((thread) => thread.id)).not.toContain(threadId);
  });

  it("keeps Chat's threads out of the Research list", async () => {
    const chatThread = await newThread(chatAgentId, "A plain chat");

    const ofChat = await threadsOf({ scope: "chat" });
    const ofResearch = await threadsOf({ scope: "agent", agentId: researchAgentId });

    expect(ofChat.map((thread) => thread.id)).toContain(chatThread);
    expect(ofResearch.map((thread) => thread.id)).not.toContain(chatThread);
  });

  it("does not list a thread that still has the default title, in either scope", async () => {
    const untitled = await newThread(researchAgentId);

    const ofResearch = await threadsOf({ scope: "agent", agentId: researchAgentId });
    const everything = await threadsOf({});

    expect(ofResearch.map((thread) => thread.id)).not.toContain(untitled);
    expect(everything.map((thread) => thread.id)).not.toContain(untitled);
  });

  it("answers 404 for a thread list asked for an agent that does not exist", async () => {
    const answer = await call("GET", "/api/v1/threads", undefined, { scope: "agent", agentId: "no-such-agent" });

    expect(answer.status).toBe(404);
  });

  it("answers 404 for a thread created on an agent that does not exist", async () => {
    const answer = await call("POST", "/api/v1/threads", { agentId: "no-such-agent", title: "x" });

    expect(answer.status).toBe(404);
  });
});

describe("runPolicyFor", () => {
  const version = { id: "v1", organizationId: "o1" };

  it("gives a published Research row the full registry tools, all enabled, the full budget and its prompt", () => {
    const policy = runPolicyFor({ agent: { slug: "va-research" }, version });
    const research = VIRTUAL_AGENTS.find((agent) => agent.id === "research");
    const full = virtualAgentFor("chat");

    expect(policy).not.toBeNull();
    expect(policy?.bindings.map((binding) => binding.toolKey)).toEqual([...full.tools]);
    expect(policy?.bindings.every((binding) => binding.enabled)).toBe(true);
    expect(
      policy?.bindings.every((binding) => binding.agentVersionId === "v1" && binding.organizationId === "o1"),
    ).toBe(true);
    expect(policy?.budget).toEqual(full.budget);
    expect(policy?.budget.perTool?.research_dossier).toBe(2);
    expect(policy?.systemPrompt).toBe(research?.prompt);
    expect(policy?.systemPrompt.startsWith("You are the Research agent on the owner's desk.")).toBe(true);
    expect(policy?.closingPrompt).toBe(research?.closing);
    expect(policy?.agent.id).toBe("research");
  });

  it("returns null for the generalist, whose run keeps its own path", () => {
    expect(runPolicyFor({ agent: { slug: DEFAULT_CHAT_SLUG }, version })).toBeNull();
    expect(runPolicyFor({ agent: { slug: "quick-chat" }, version })).toBeNull();
  });

  it("returns null for an agent a person built, whatever its name", () => {
    expect(runPolicyFor({ agent: { slug: "my-own-agent" }, version })).toBeNull();
    // The prefix alone does not make a mode agent: the slug must be in the registry.
    expect(runPolicyFor({ agent: { slug: "va-not-a-mode" }, version })).toBeNull();
  });

  it("gives a studio agent the same full bindings and budget as Chat, under its own identity", () => {
    const policy = runPolicyFor({ agent: { slug: "va-legal" }, version });
    const full = virtualAgentFor("chat");

    expect(policy).not.toBeNull();
    expect(policy?.bindings.map((binding) => binding.toolKey)).toEqual([...full.tools]);
    expect(policy?.budget).toEqual(full.budget);
    expect(policy?.systemPrompt.startsWith("You are the Legal agent on the owner's desk.")).toBe(true);
    expect(policy?.agent.conversation).toBe("studio");
  });
});

describe("a run on the Research agent's thread", () => {
  it("completes on the stub runtime, with no failure and no tool outside the agent's list", async () => {
    const threadId = await newThread(researchAgentId, "Stub run");

    const { types, frames } = await send(threadId, "hello");

    expect(types).toContain("run.completed");
    expect(types).not.toContain("run.failed");
    const named = frames.filter((frame) => frame.type === "tool.started").map((frame) => String(frame.toolKey));
    for (const toolKey of named) {
      expect(virtualAgentFor("research").tools).toContain(toolKey);
    }
  });

  it("hands the runtime the registry's prompt, tools and budget, not the row's", async () => {
    const seen: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        seen.push(run);
        await run.onEvent({ type: "assistant.delta", text: "ok" });
        await run.onEvent({ type: "run.completed", runId: run.runId });
      },
    };
    const threadId = await newThread(researchAgentId, "Recorded run");

    const { types } = await send(threadId, "hello");

    expect(types).toContain("run.completed");
    expect(seen).toHaveLength(1);
    const input = seen[0] as ExecuteInput;
    const full = virtualAgentFor("chat");
    expect(input.bindings.map((binding) => binding.toolKey)).toEqual([...full.tools]);
    expect(input.bindings.every((binding) => binding.enabled)).toBe(true);
    expect(input.budget).toEqual(full.budget);
    expect(input.version.systemPrompt).toContain("You are the Research agent");
  });

  it("gives a mode agent the desk's Soul block, with who is speaking said after it", async () => {
    const seen: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        seen.push(run);
        await run.onEvent({ type: "assistant.delta", text: "ok" });
        await run.onEvent({ type: "run.completed", runId: run.runId });
      },
    };
    const threadId = await newThread(imagesAgentId, "Images run");

    const { types } = await send(threadId, "hello");

    expect(types).toContain("run.completed");
    expect(seen).toHaveLength(1);
    const input = seen[0] as ExecuteInput;
    const keys = input.bindings.map((binding) => binding.toolKey);
    expect(keys).toContain("image_generate");
    expect(keys).toContain("research_dossier");
    // A tool that runs for minutes must not read as a dead stream.
    expect(input.streamWatchdog?.idleMs).toBe(WORKER_STREAM_IDLE_MS);
    const prompt = input.version.systemPrompt;
    expect(prompt.startsWith("You are the Images agent")).toBe(true);
    const soul = prompt.indexOf("Name:");
    const speaking = prompt.indexOf("Who is speaking: in this chat you are the Images agent.");
    expect(soul).toBeGreaterThan(-1);
    expect(speaking).toBeGreaterThan(soul);
  });

  it("accepts an image sent to a mode agent's thread, as Chat does", async () => {
    const seen: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        seen.push(run);
        await run.onEvent({ type: "assistant.delta", text: "ok" });
        await run.onEvent({ type: "run.completed", runId: run.runId });
      },
    };
    const threadId = await newThread(imagesAgentId, "Image input");

    const result = await dispatch(
      request("POST", `/api/v1/threads/${threadId}/runs/image`, {
        params: { threadId },
        body: {
          content: [
            { type: "text", text: "What is on this slide?" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ],
        },
      }),
    );

    expect(result.type).toBe("stream");
    let raw = "";
    if (result.type === "stream") {
      for await (const chunk of result.events) {
        raw += chunk;
      }
    }
    expect(raw).not.toContain("run.failed");
    expect(seen).toHaveLength(1);
  });

  it("carries a worker's progress to the thread as tool.progress frames", async () => {
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        await run.onEvent({ type: "tool.started", toolKey: "research_dossier", input: { question: "x" } });
        await runWithWorkerProgress("research_dossier", async (emit) => {
          emit({ type: "job.phase", phase: "searching", label: "Searching the web" });
          emit({ type: "job.delta", text: "not for the thread" });
          emit({ type: "job.done", result: {} });
        });
        await run.onEvent({ type: "tool.completed", toolKey: "research_dossier", output: { ok: true } });
        await run.onEvent({ type: "assistant.delta", text: "done" });
        await run.onEvent({ type: "run.completed", runId: run.runId });
      },
    };
    const threadId = await newThread(researchAgentId, "Progress run");

    const { frames, types } = await send(threadId, "Research the effects of the new tariff schedule");

    const progress = frames.filter((frame) => frame.type === "tool.progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      toolKey: "research_dossier",
      job: { type: "job.phase", label: "Searching the web" },
    });
    expect(types).toContain("run.completed");
    expect(types).not.toContain("run.failed");
  });

  it("lets the default agent do it all in its own chat: research, pictures, clips and decks, with nobody hired", async () => {
    const seen: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        seen.push(run);
        await run.onEvent({ type: "assistant.delta", text: "ok" });
        await run.onEvent({ type: "run.completed", runId: run.runId });
      },
    };
    const threadId = await newThread(chatAgentId, "Chat run");

    await send(threadId, "hello");

    expect(seen).toHaveLength(1);
    const run = seen[0] as ExecuteInput;
    expect(run.streamWatchdog?.idleMs).toBe(WORKER_STREAM_IDLE_MS);
    const keys = run.bindings.map((binding) => binding.toolKey);
    // Owner, 2026-10-09: the chat agent does anything inside its chat; hiring an agent is never required.
    for (const key of ["research_dossier", "image_generate", "video_generate", "build_deck", "web_search"]) {
      expect(keys, key).toContain(key);
    }
    expect(keys.filter((key) => key === "research_dossier")).toHaveLength(1);
    // It is told about the worker, bounded per turn, and is still the general assistant.
    expect(run.version.systemPrompt).toContain("research_dossier researches one question");
    expect(run.version.systemPrompt).toContain("You are the general assistant");
    expect(run.version.systemPrompt).not.toContain("You are the Research agent");
    // The default agent keeps its own name from the Soul block, so nothing overrides who is speaking.
    expect(run.version.systemPrompt).toContain("Name:");
    expect(run.version.systemPrompt).not.toContain("Who is speaking");
    expect(run.budget?.perTool?.research_dossier).toBe(2);
    expect(run.budget?.maxSteps).toBe(12);
    expect(run.budget?.perTool?.build_deck).toBe(4);
  });
});
