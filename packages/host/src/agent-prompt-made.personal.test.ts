import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listChatModels, type AgentRuntime, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-prompt-made-personal-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SERVER;
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

async function json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const result = await dispatch({ method, path, query: {}, params: {}, headers: {}, body });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as T };
}

async function postRun(threadId: string): Promise<void> {
  const result = await dispatch({
    method: "POST",
    path: `/api/v1/threads/${threadId}/runs/text`,
    query: {},
    params: { threadId },
    headers: {},
    body: { content: "hello" },
  });
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}`);
  }
  for await (const _frame of result.events) {
    // The run only finishes once its frames have been read.
  }
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const DRAFT = {
  name: "Personal probe",
  description: "Reads things",
  instructions: "You read things.",
  baseMode: "chat",
  tools: ["calculator"],
};

describe("Personal: the owner still sees and edits every agent row on the desk", () => {
  it("opens, lists, edits and deletes a private agent another person made, as before", async () => {
    const { agentService } = await import("./tenant");
    const colleague: TenantContext = { ...tenant, userId: "colleague-1", role: "member" };
    const models = listChatModels();
    const theirs = await agentService.createPromptMade(
      colleague,
      {
        name: "Colleague private",
        systemPrompt: "Help",
        model: models[0].id,
        config: { baseMode: "chat", madeFromPrompt: true },
      },
      [],
      models,
    );
    expect(theirs.agent.createdByUserId).toBe("colleague-1");
    expect(theirs.agent.visibility).toBe("private");

    expect((await agentService.get(tenant, theirs.agent.id))?.id).toBe(theirs.agent.id);
    expect((await agentService.list(tenant)).map((agent) => agent.id)).toContain(theirs.agent.id);

    const opened = await json("GET", `/api/v1/agents/${theirs.agent.id}`);
    expect(opened.status).toBe(200);
    expect((await json("GET", `/api/v1/agents/${theirs.agent.id}/capabilities`)).status).toBe(200);
    expect((await json("GET", `/api/v1/agents/${theirs.agent.id}/threads`)).status).toBe(200);
    const edited = await json("POST", `/api/v1/agents/${theirs.agent.id}/tools`, { toolKey: "calculator" });
    expect(edited.status).toBe(201);
    const published = await json("POST", `/api/v1/agents/${theirs.agent.id}/publish`, { versionId: theirs.version.id });
    expect(published.status).toBe(200);

    const listed = await json("GET", `/api/v1/workspaces/${tenant.workspaceId}/agents`);
    expect(listed.body.agents.find((agent: { id: string }) => agent.id === theirs.agent.id)).toMatchObject({
      deletable: true,
      madeFromPrompt: true,
    });

    const removed = await json("DELETE", `/api/v1/agents/${theirs.agent.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true, agentId: theirs.agent.id, chatsDeleted: 0, workspacesRemoved: 0 });
  });
});

describe("Personal: POST /api/v1/agents/draft without a key", () => {
  it("makes a local draft from the prompt and calls no model", async () => {
    const answer = await json("POST", "/api/v1/agents/draft", { prompt: "An agent that checks my invoices" });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      draft: {
        name: "An agent that checks my invoices",
        description: "An agent that checks my invoices",
        instructions: "An agent that checks my invoices",
        baseMode: "chat",
        tools: [],
      },
      source: "stub",
    });
    expect(executed).toHaveLength(0);
  });
});

describe("a prompt-made agent runs with exactly its own tools", () => {
  it("adds no past_sessions binding to a prompt-made agent, and still adds it to an older one", async () => {
    const { agentService } = await import("./tenant");
    const { createThread } = await import("./threads");

    const made = await json("POST", "/api/v1/agents", DRAFT);
    expect(made.status).toBe(201);
    const madeThread = await createThread(tenant, made.body.agent.id, "Prompt made");
    await postRun(madeThread.id);
    expect(executed).toHaveLength(1);
    expect((executed[0]?.bindings ?? []).map((binding) => binding.toolKey)).toEqual(["calculator"]);

    executed.length = 0;
    const emptyMade = await json("POST", "/api/v1/agents", { ...DRAFT, name: "No tools", tools: [] });
    const emptyThread = await createThread(tenant, emptyMade.body.agent.id, "No tools");
    await postRun(emptyThread.id);
    expect(executed[0]?.bindings ?? []).toEqual([]);

    executed.length = 0;
    const models = listChatModels();
    const older = await agentService.create(
      tenant,
      { name: "Older agent", systemPrompt: "Help", model: models[0].id },
      models,
    );
    await agentService.bindTool(tenant, older.agent.id, older.version.id, "calculator");
    await agentService.publish(tenant, older.agent.id, older.version.id);
    const olderThread = await createThread(tenant, older.agent.id, "Older");
    await postRun(olderThread.id);
    expect((executed[0]?.bindings ?? []).map((binding) => binding.toolKey).sort()).toEqual([
      "calculator",
      "past_sessions",
    ]);
  });

  it("marks the agent madeFromPrompt on both lists", async () => {
    const made = await json("POST", "/api/v1/agents", { ...DRAFT, name: "Flag probe" });
    const list = await json("GET", `/api/v1/workspaces/${tenant.workspaceId}/agents`);
    expect(list.body.agents.find((agent: { id: string }) => agent.id === made.body.agent.id)).toMatchObject({
      madeFromPrompt: true,
      deletable: true,
    });
    const chat = await json("GET", "/api/v1/chat");
    expect(chat.body.specialists.find((agent: { id: string }) => agent.id === made.body.agent.id)).toMatchObject({
      madeFromPrompt: true,
      deletable: true,
    });
  });
});
