import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * A model call that finishes just after the person was told the run failed.
 *
 * The watchdog and a client that left both send `run.failed`, close the stream and mark the run row
 * `failed`. A gateway answer that lands a moment later used to fall through the `run.completed`
 * branch and be saved as an assistant message on a run the person had already seen fail. The answer
 * is dropped now, but the call really reached the gateway, so its tokens are still metered.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-settled-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const USAGE = { model: "gpt-5.6-sol", inputTokens: 120, outputTokens: 45 };

type Script = { waitForAbort: boolean };
let script: Script = { waitForAbort: true };
let executed = 0;
/** Set once the runtime has handed the host every event and the host has finished handling them. */
let eventsHandled = false;
const stallCallbacks: Array<(message: string) => void> = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed += 1;
        if (script.waitForAbort) {
          await new Promise<void>((resolve) =>
            input.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        // A model call that was already past its last byte when the cancel arrived: it still answers.
        await input.onEvent({ type: "assistant.delta", text: "late answer" });
        await input.onEvent({ type: "run.completed", runId: input.runId, usage: USAGE });
        eventsHandled = true;
      },
    }),
  };
});

vi.mock("./run-stall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-stall")>();
  return {
    ...actual,
    armRunStallGuard: (options: { onStall: (message: string) => void }) => {
      stallCallbacks.push(options.onStall);
      return { touch: () => {}, touchOutput: () => {}, close: () => {} };
    },
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let agentId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await dispatch(request(method, path, { body }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

async function newThread(): Promise<string> {
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId });
  return created.thread.id;
}

async function openRun(threadId: string, abortSignal?: AbortSignal): Promise<AsyncIterable<string>> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, {
      params: { threadId },
      body: { content: "hello" },
      ...(abortSignal ? { abortSignal } : {}),
    }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  return result.events;
}

async function drain(events: AsyncIterable<string>): Promise<Array<{ type: string; message?: string }>> {
  const seen: Array<{ type: string; message?: string }> = [];
  for await (const frame of events) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (line) {
      seen.push(JSON.parse(line.slice("data:".length).trim()) as { type: string; message?: string });
    }
  }
  return seen;
}

async function runsOf(threadId: string) {
  const { db, runs } = await import("@agentforge/db");
  return db.select().from(runs).where(eq(runs.threadId, threadId));
}

async function assistantMessages(threadId: string) {
  const { listMessages } = await import("./threads");
  return (await listMessages(tenant, threadId)).filter((row) => row.role === "assistant");
}

async function chatUsageRows(runId: string) {
  const { listTenantUsage } = await import("./tenant-usage");
  return listTenantUsage(tenant).filter((row) => row.mode === "chat" && row.runId === runId);
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  agentId = chat.agent.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  script = { waitForAbort: true };
  executed = 0;
  eventsHandled = false;
  stallCallbacks.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a model answer that lands after the run was reported failed", () => {
  it("saves no assistant message, keeps the run failed and still meters the call when the client left", async () => {
    const threadId = await newThread();
    const client = new AbortController();
    const events = await openRun(threadId, client.signal);
    await vi.waitFor(() => expect(executed).toBe(1));

    client.abort(new Error("client left"));
    const seen = await drain(events);
    await vi.waitFor(() => expect(eventsHandled).toBe(true));

    expect(seen.filter((event) => event.type === "run.failed")).toHaveLength(1);
    const [run] = await runsOf(threadId);
    expect(run?.status).toBe("failed");
    expect(await assistantMessages(threadId)).toEqual([]);
    await vi.waitFor(async () => expect(await chatUsageRows(run?.id ?? "")).toHaveLength(1));
    expect((await chatUsageRows(run?.id ?? ""))[0]).toMatchObject({ unit: "tokens", quantity: 165 });
  });

  it("does the same when the stall guard gave up on the model", async () => {
    const threadId = await newThread();
    const events = await openRun(threadId);
    await vi.waitFor(() => expect(executed).toBe(1));
    expect(stallCallbacks).toHaveLength(1);

    stallCallbacks[0]?.("No first token from the model within 120s");
    await drain(events);
    await vi.waitFor(() => expect(eventsHandled).toBe(true));

    const [run] = await runsOf(threadId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("No first token from the model within 120s");
    expect(await assistantMessages(threadId)).toEqual([]);
    await vi.waitFor(async () => expect(await chatUsageRows(run?.id ?? "")).toHaveLength(1));
  });

  it("still saves the answer and meters once for a run nobody cancelled", async () => {
    script = { waitForAbort: false };
    const threadId = await newThread();
    const seen = await drain(await openRun(threadId));
    await vi.waitFor(() => expect(eventsHandled).toBe(true));

    expect(seen.some((event) => event.type === "run.failed")).toBe(false);
    const [run] = await runsOf(threadId);
    await vi.waitFor(async () => expect((await runsOf(threadId))[0]?.status).toBe("completed"));
    const saved = await assistantMessages(threadId);
    expect(saved).toHaveLength(1);
    await vi.waitFor(async () => expect(await chatUsageRows(run?.id ?? "")).toHaveLength(1));
  });
});
