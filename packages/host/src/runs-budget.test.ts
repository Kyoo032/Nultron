import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  harnessSpecFor,
  listChatModels,
  virtualAgentFor,
  type AgentRuntime,
  type TenantContext,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * What Chat tells the runtime about its budget. The default Chat agent runs under the budget Chat's
 * harness spec declares; an agent the owner built keeps the runtime's own default, and keeps every tool
 * the owner bound to it (Chat's bindings are not cut to the spec).
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-budget-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await input.onEvent({ type: "assistant.delta", text: "hello" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let defaultChatThreadId = "";
let customThreadId = "";

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

async function postRun(threadId: string): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content: "hello" } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  for await (const _frame of result.events) {
    // Drain the stream: the run only finishes once its frames have been read.
  }
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant, agentService } = await import("./tenant");
  const { createThread } = await import("./threads");
  tenant = await getTenant();

  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  defaultChatThreadId = created.thread.id;

  const models = listChatModels();
  const custom = await agentService.create(
    tenant,
    { name: "Budget probe", systemPrompt: "You answer briefly.", model: models[0].id },
    models,
  );
  await agentService.bindTool(tenant, custom.agent.id, custom.version.id, "calculator");
  await agentService.bindTool(tenant, custom.agent.id, custom.version.id, "run_sql");
  await agentService.publish(tenant, custom.agent.id, custom.version.id);
  customThreadId = (await createThread(tenant, custom.agent.id, "Budget probe")).id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("POST /threads/:id/runs/text and the run budget", () => {
  it("runs the default Chat agent under the budget Chat's spec declares, and never a looser one", async () => {
    await postRun(defaultChatThreadId);
    expect(executed).toHaveLength(1);
    // Tester code: the default agent's budget is the registry's (`virtualAgentFor("chat")`): Chat's
    // declared budget, plus a ceiling for each worker and for paid media. Every number the published
    // spec declares is still the number the run gets.
    const budget = executed[0]?.budget;
    expect(budget).toBe(virtualAgentFor("chat").budget);
    const declared = harnessSpecFor("chat").budget;
    expect(budget?.maxSteps).toBe(declared.maxSteps);
    expect(budget?.maxToolCalls).toBe(declared.maxToolCalls);
    for (const [toolKey, cap] of Object.entries(declared.perTool ?? {})) {
      expect(budget?.perTool?.[toolKey], toolKey).toBe(cap);
    }
    expect(budget?.perTool).toMatchObject({
      research_dossier: 2,
      finance_task: 2,
      image_generate: 4,
      video_generate: 1,
    });
  });

  it("leaves an agent the owner built on the runtime's default budget", async () => {
    await postRun(customThreadId);
    expect(executed).toHaveLength(1);
    expect(executed[0]).not.toHaveProperty("budget");
  });

  it("does not cut the owner's bindings on a custom agent to the Chat spec", async () => {
    await postRun(customThreadId);
    // `run_sql` is a Data tool, outside Chat's spec: it stays because the owner bound it. The
    // `past_sessions` binding is the one the run adds to every agent.
    expect((executed[0]?.bindings ?? []).map((binding) => binding.toolKey).sort()).toEqual([
      "calculator",
      "past_sessions",
      "run_sql",
    ]);
  });
});
