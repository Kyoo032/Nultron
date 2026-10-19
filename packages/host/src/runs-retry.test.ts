import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { GATEWAY_PROVIDER_ID } from "@agentforge/core";
import { MODEL_TIERS, TIER_DEFINITIONS } from "@agentforge/core/tiers";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { SelectableModel } from "./selectable-models";
import type { HostRequest, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-retry-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const state = vi.hoisted(() => ({ fail: false, catalog: [] as SelectableModel[] }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        if (state.fail) {
          throw new Error("upstream closed the connection");
        }
        await input.onEvent({ type: "assistant.delta", text: "an answer" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => state.catalog };
});

function fullCatalog(): SelectableModel[] {
  const ids = [...new Set(MODEL_TIERS.flatMap((tier) => TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? []))];
  return ids.map((id) => ({
    id,
    label: id,
    provider: "openai",
    inputModalities: ["text"],
    friendlyLabel: id,
    bestFor: "Fast drafts",
    tier: "everyday",
  }));
}

let dispatch: (request: HostRequest) => Promise<HostResult>;

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

async function run(threadId: string, body: Record<string, unknown>): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}`);
  }
  for await (const _frame of result.events) {
  }
}

async function roles(threadId: string): Promise<string[]> {
  const payload = await json<{ messages: { role: string }[] }>("GET", `/api/v1/threads/${threadId}`);
  return payload.messages.map((message) => message.role);
}

let agentId = "";

beforeAll(async () => {
  state.catalog = fullCatalog();
  ({ dispatch } = await import("./router"));
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  agentId = chat.agent.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  state.fail = false;
  state.catalog = fullCatalog();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function newThread(): Promise<string> {
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId });
  return created.thread.id;
}

describe("Try again after a failed text turn", () => {
  it("answers the stored turn without storing it a second time", async () => {
    const threadId = await newThread();
    state.fail = true;
    await run(threadId, { content: "hello", tier: "daily" });
    expect(await roles(threadId)).toEqual(["user"]);

    state.fail = false;
    await run(threadId, { content: "hello", tier: "daily", retry: true });
    expect(await roles(threadId)).toEqual(["user", "assistant"]);
  });

  it("stores the turn again when the same words are sent without retry", async () => {
    const threadId = await newThread();
    state.fail = true;
    await run(threadId, { content: "hello", tier: "daily" });
    state.fail = false;
    await run(threadId, { content: "hello", tier: "daily" });
    expect(await roles(threadId)).toEqual(["user", "user", "assistant"]);
  });

  it("stores a retry whose words differ from the newest stored turn", async () => {
    const threadId = await newThread();
    state.fail = true;
    await run(threadId, { content: "hello", tier: "daily" });
    state.fail = false;
    await run(threadId, { content: "something else", tier: "daily", retry: true });
    expect(await roles(threadId)).toEqual(["user", "user", "assistant"]);
  });
});
