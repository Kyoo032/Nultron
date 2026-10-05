import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * The Chat context chip's Sources row, and what it costs to read it.
 *
 * `GET /api/v1/knowledge/context?query=` embeds the query through the gateway, and Chat used to ask
 * it with the last user message every time a thread with messages came on screen, so merely opening
 * an old thread on a keyed desk was a paid embedding call (found driving webdev, 2026-10-01). Chat
 * now asks with the thread alone. The route answers that from what the thread's last completed run
 * was recorded as retrieving (`knowledge_retrievals`), with no retrieval of its own: the send already
 * paid for it once. `?query=` still retrieves, for the harness that wants the exact text a turn
 * would be handed.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-context-route-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        await input.onEvent({ type: "assistant.delta", text: "noted" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

// The one door to retrieval. Counting it is how this file proves a read costs nothing: a retrieval
// is what embeds the query.
vi.mock("./knowledge/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge/registry")>();
  return { ...actual, retrieveThroughBackend: vi.fn(actual.retrieveThroughBackend) };
});

type Part = { label: string; detail: string; tokens: number };

let dispatch: (request: HostRequest) => Promise<HostResult>;
let retrievals: () => number;
let chatAgentId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function json<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
  const result = await dispatch(request(method, path, { body, query }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

async function newThread(): Promise<string> {
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chatAgentId });
  return created.thread.id;
}

async function send(threadId: string, content: string): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}`);
  }
  for await (const _frame of result.events) {
    // Drain: the run records its retrievals only once its stream has been read to the end.
  }
}

async function context(query: Record<string, string>): Promise<{ prompt: string; parts: Part[] }> {
  return json("GET", "/api/v1/knowledge/context", undefined, query);
}

function sources(parts: Part[]): Part {
  const row = parts.find((part) => part.label === "Sources");
  if (!row) {
    throw new Error("no Sources row");
  }
  return row;
}

async function addSource(name: string, text: string): Promise<string> {
  const created = await json<{ source?: { id: string }; id?: string }>("POST", "/api/v1/knowledge/sources", {
    name,
    text,
  });
  return created.source?.id ?? created.id ?? "";
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const registry = await import("./knowledge/registry");
  retrievals = () => vi.mocked(registry.retrieveThroughBackend).mock.calls.length;
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  chatAgentId = chat.agent.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(async () => {
  const registry = await import("./knowledge/registry");
  vi.mocked(registry.retrieveThroughBackend).mockClear();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The chunk count a Sources detail line states: "3 chunks" or "3 chunks · hybrid". */
function countOf(part: Part): number {
  const match = /^(\d+) chunks/.exec(part.detail);
  if (!match) {
    throw new Error(`not a Sources line: ${part.detail}`);
  }
  return Number(match[1]);
}

/** What the next run in this thread retrieves: nothing, whatever the knowledge base holds. */
async function retrieveNothingNextTime(): Promise<void> {
  const registry = await import("./knowledge/registry");
  vi.mocked(registry.retrieveThroughBackend).mockResolvedValueOnce({
    chunks: [],
    mode: "none",
    backend: "builtin",
    vectorModel: null,
  });
}

describe("GET /knowledge/context with a thread and no query", () => {
  it("answers a thread nothing was retrieved for with an empty Sources row, and still the Soul and Memories", async () => {
    const threadId = await newThread();
    const answer = await context({ threadId });

    expect(answer.parts.map((part) => part.label)).toEqual(["Soul", "Memories", "Sources"]);
    expect(sources(answer.parts)).toMatchObject({ detail: "0 chunks", tokens: 0 });
    expect(retrievals()).toBe(0);
  });

  it("reports what the thread's last completed run was handed, without retrieving again", async () => {
    await addSource("Vendor policy", "The zebracorn clause caps vendor concentration at thirty percent of spend.");
    const threadId = await newThread();
    await send(threadId, "What does the zebracorn clause say?");
    const retrievedBySend = retrievals();
    expect(retrievedBySend).toBeGreaterThan(0);

    const answer = await context({ threadId });

    expect(countOf(sources(answer.parts))).toBeGreaterThanOrEqual(1);
    expect(countOf(sources(answer.parts))).toBeLessThanOrEqual(4);
    expect(sources(answer.parts).tokens).toBeGreaterThan(0);
    // Reading it costs nothing: no retrieval ran for the read, so no query was embedded.
    expect(retrievals()).toBe(retrievedBySend);
    // The prompt is still only what a turn with nothing to search for is handed.
    expect(answer.prompt).not.toContain("zebracorn");
  });

  it("answers the same on every read, however many times the thread is opened", async () => {
    await addSource("Harbour tariffs", "The quokkamar tariff schedule lists berth fees by vessel length.");
    const threadId = await newThread();
    await send(threadId, "Summarise the quokkamar tariff schedule");
    const afterSend = retrievals();

    const first = await context({ threadId });
    const second = await context({ threadId });
    const third = await context({ threadId });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(retrievals()).toBe(afterSend);
  });

  it("follows the last completed run: a later turn that was handed nothing empties the row", async () => {
    await addSource("Crew rota", "The fennimore rota assigns night watch by seniority.");
    const threadId = await newThread();
    await send(threadId, "Who is on the fennimore rota?");
    expect(countOf(sources((await context({ threadId })).parts))).toBeGreaterThanOrEqual(1);

    await retrieveNothingNextTime();
    await send(threadId, "And on Thursday?");

    expect(sources((await context({ threadId })).parts)).toMatchObject({ detail: "0 chunks", tokens: 0 });
  });

  it("keeps threads apart: one thread's retrieval is not another's", async () => {
    await addSource("Berth map", "The ostrelle berth map marks tide limits.");
    const asked = await newThread();
    const idle = await newThread();
    await send(asked, "Where is the ostrelle berth map?");

    expect(countOf(sources((await context({ threadId: asked })).parts))).toBeGreaterThanOrEqual(1);
    expect(sources((await context({ threadId: idle })).parts).detail).toBe("0 chunks");
  });

  it("does not count another desk's rows, and does not read a thread that does not exist", async () => {
    const { sql } = await import("@agentforge/db");
    await addSource("Pier plan", "The wendlow pier plan fixes mooring bollards every ten metres.");
    const threadId = await newThread();
    await send(threadId, "Describe the wendlow pier plan");
    const before = countOf(sources((await context({ threadId })).parts));
    expect(before).toBeGreaterThanOrEqual(1);
    // A row of another desk that carries this thread's id and its last run's id: it must not count.
    const run = sql
      .prepare("SELECT id FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as {
      id: string;
    };
    sql
      .prepare(
        "INSERT INTO knowledge_retrievals (id, workspace_id, thread_id, run_id, source_id, chunk_index, score, backend, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(crypto.randomUUID(), "ws-another-desk", threadId, run.id, "src-elsewhere", 0, 1, "builtin", Date.now());

    const mine = await context({ threadId });
    const stranger = await context({ threadId: "00000000-0000-4000-8000-000000000000" });

    expect(countOf(sources(mine.parts))).toBe(before);
    expect(sources(stranger.parts)).toMatchObject({ detail: "0 chunks", tokens: 0 });
  });

  it("forgets a source when it is deleted", async () => {
    const threadId = await newThread();
    await addSource("Dock log", "The halcyonne dock log lists every berthing.");
    await send(threadId, "Read me the halcyonne dock log");
    expect(countOf(sources((await context({ threadId })).parts))).toBeGreaterThanOrEqual(1);

    const listed = await json<{ sources: Array<{ id: string }> }>("GET", "/api/v1/knowledge");
    for (const source of listed.sources) {
      await json("DELETE", `/api/v1/knowledge/sources/${source.id}`);
    }

    expect(sources((await context({ threadId })).parts)).toMatchObject({ detail: "0 chunks", tokens: 0 });
  });
});

describe("GET /knowledge/context with a query", () => {
  it("still retrieves for the query, for the harness that wants the exact text a turn would get", async () => {
    await addSource("Dock safety", "The pellucid dock rule bans open flames on the quay.");

    const answer = await context({ query: "pellucid dock rule" });

    expect(retrievals()).toBe(1);
    expect(answer.prompt).toContain("pellucid");
    expect(countOf(sources(answer.parts))).toBeGreaterThanOrEqual(1);
    expect(sources(answer.parts).detail).toMatch(/ · (hybrid|rag|fts)$/);
  });

  it("asks for nothing at all when it has neither a query nor a thread", async () => {
    const answer = await context({});

    expect(retrievals()).toBe(0);
    expect(sources(answer.parts)).toMatchObject({ detail: "0 chunks", tokens: 0 });
  });
});
