import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import type { FileAuthor } from "@agentforge/core/tools/files";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * Who a Chat tool call writes as. A file tool records an author on every version it saves. Chat sets
 * only the thread-scoped run context, so the author used to be the THREAD id: every file the agent
 * wrote in a conversation looked as if one run wrote them all. The run id is the author, and Chat has
 * one for every turn.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-tool-run-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type Seen = {
  readonly runId: string;
  readonly toolRun: { runId: string; mode: string } | undefined;
  readonly threadId: string | undefined;
  readonly author: FileAuthor;
};
const seen: Seen[] = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        // What a tool body sees while the model is running: the ambient contexts, not the input.
        const { currentToolRun } = await import("./tool-run-context");
        const { getRunContext } = await import("./run-context");
        const { currentAgentAuthor } = await import("./file-roots");
        const toolRun = currentToolRun();
        seen.push({
          runId: input.runId,
          toolRun: toolRun ? { runId: toolRun.runId, mode: toolRun.mode } : undefined,
          threadId: getRunContext()?.threadId,
          author: currentAgentAuthor(),
        });
        await input.onEvent({ type: "assistant.delta", text: "hello" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let threadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function postRun(body: Record<string, unknown>): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  for await (const _frame of result.events) {
    // Drain the stream: the run only finishes once its frames have been read.
  }
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await dispatch(request(method, path, { body }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a Chat run and the author of the files its tools write", () => {
  it("runs the model inside the tool-run context, keyed by the run id and not the thread id", async () => {
    await postRun({ content: "hello" });
    expect(seen).toHaveLength(1);
    const [only] = seen;
    expect(only?.threadId).toBe(threadId);
    expect(only?.runId).not.toBe(threadId);
    expect(only?.toolRun).toEqual({ runId: only?.runId, mode: "chat" });
  });

  it("makes the run id the author of a file written from Chat", async () => {
    await postRun({ content: "hello" });
    const [only] = seen;
    expect(only?.author).toEqual({ kind: "agent", runId: only?.runId, mode: "chat" });
    expect(only?.author).not.toMatchObject({ runId: threadId });
  });

  it("gives each turn of one conversation its own author", async () => {
    await postRun({ content: "first" });
    await postRun({ content: "second" });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.author).not.toEqual(seen[1]?.author);
  });
});
