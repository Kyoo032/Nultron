import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessSpecFor, listChatModels, type AgentRuntime, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-prompt-made-budget-"));
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
let dataThreadId = "";
let legacyThreadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function postRun(threadId: string): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content: "hello" } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  for await (const _frame of result.events) {
    void _frame;
  }
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant, agentService } = await import("./tenant");
  const { createThread } = await import("./threads");
  const { promptMadeConfig } = await import("./prompt-made-agent");
  tenant = await getTenant();
  const models = listChatModels();

  const made = await agentService.createPromptMade(
    tenant,
    {
      name: "Data helper",
      systemPrompt: "You answer briefly.",
      model: models[0].id,
      productModes: ["chat"],
      config: promptMadeConfig("data"),
    },
    ["run_sql"],
    models,
  );
  await agentService.publish(tenant, made.agent.id, made.version.id);
  dataThreadId = (await createThread(tenant, made.agent.id, "Data helper")).id;

  const legacy = await agentService.create(
    tenant,
    { name: "Legacy probe", systemPrompt: "You answer briefly.", model: models[0].id },
    models,
  );
  await agentService.publish(tenant, legacy.agent.id, legacy.version.id);
  legacyThreadId = (await createThread(tenant, legacy.agent.id, "Legacy probe")).id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the run budget of an agent made from a prompt (SR-182)", () => {
  it("runs under its base mode's declared budget, with the mode's per-tool caps", async () => {
    await postRun(dataThreadId);
    expect(executed).toHaveLength(1);
    const budget = executed[0]?.budget;
    const declared = harnessSpecFor("data").budget;
    expect(budget).toBe(declared);
    expect(budget?.perTool).toMatchObject({ run_sql: 8, run_code: 4 });
  });

  it("leaves an agent that is not prompt-made on the runtime's default budget", async () => {
    await postRun(legacyThreadId);
    expect(executed).toHaveLength(1);
    expect(executed[0]).not.toHaveProperty("budget");
  });
});
