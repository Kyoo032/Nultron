import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_EXCLUDED_TOOLS,
  DELEGATE_TOOL_KEY,
  FULL_CHAT_TOOLS,
  GENERALIST_WORKER_TOOLS,
  delegateToolKeys,
  virtualAgentFor,
  type AgentRuntime,
  type TenantContext,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";
import { VOICE_READ_TOOLS, VOICE_TAP_TOOLS } from "../voice/ask-tools";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-delegation-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const swap = vi.hoisted(() => ({ runtime: null as null | { execute: (input: unknown) => Promise<void> } }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (...args: Parameters<typeof actual.createRuntime>) =>
      (swap.runtime as AgentRuntime | null) ?? actual.createRuntime(...args),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let chatAgentId = "";
let parentThreadId = "";

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

async function newThread(agentId: string, title?: string): Promise<string> {
  const created = await call<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId, title });
  expect(created.status).toBe(201);
  return created.body.thread.id;
}

async function delegateFrom(
  args: { agent: string; task: string; context?: string },
  options: { voice?: boolean } = {},
): Promise<Awaited<ReturnType<typeof import("./run-delegation").runDelegation>>> {
  const { runDelegation } = await import("./run-delegation");
  const { withRunContext } = await import("../run-context");
  const { withWorkerChannel } = await import("../workers/worker-channel");
  return withRunContext(
    {
      threadId: parentThreadId,
      agentId: chatAgentId,
      locale: "en",
      ...(options.voice ? { voice: true } : {}),
    },
    () => withWorkerChannel({ emit: () => undefined }, () => runDelegation(args, tenant)),
  );
}

function answeringRuntime(seen: ExecuteInput[], answer = "Done reading the files."): void {
  swap.runtime = {
    async execute(input) {
      const run = input as ExecuteInput;
      seen.push(run);
      await run.onEvent({ type: "assistant.delta", text: answer });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    },
  };
}

async function deskFilesSnapshot(): Promise<Array<{ path: string; head_version: number; deleted_at: number | null }>> {
  const { sql } = await import("@agentforge/db");
  return sql
    .prepare("SELECT path, head_version, deleted_at FROM desk_files WHERE workspace_id = ? ORDER BY path")
    .all(tenant.workspaceId) as Array<{ path: string; head_version: number; deleted_at: number | null }>;
}

beforeAll(async () => {
  ({ dispatch } = await import("../router"));
  const { getTenant } = await import("../tenant");
  tenant = await getTenant();
  const hire = await call<{ modes: string[]; bots: Array<{ slug: string; name: string }> }>(
    "POST",
    "/api/v1/team/hire",
    {
      modes: ["documents", "research"],
      bots: [
        {
          name: "Ops Bot",
          role: "Desk operations helper",
          prompt: "You help the owner inspect desk notes and schedules.",
        },
      ],
    },
  );
  expect(hire.status).toBe(200);
  expect(hire.body.bots.map((bot) => bot.slug)).toContain("tb-ops-bot");
  const agents = await call<{ agents: Array<{ id: string; agentId: string | null }> }>("GET", "/api/v1/virtual-agents");
  chatAgentId = agents.body.agents.find((agent) => agent.id === "chat")?.agentId ?? "";
  expect(chatAgentId).not.toBe("");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(async () => {
  swap.runtime = null;
  parentThreadId = await newThread(chatAgentId, "Voice delegation parent");
  const { insertMessage } = await import("../threads");
  await insertMessage(tenant, parentThreadId, "user", [{ type: "text", text: "Check the Q4 notes for me." }]);
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("voiceDelegateToolKeys", () => {
  it("strips every VOICE_TAP_TOOLS key, delegate, and unknown tools while keeping VOICE_READ_TOOLS", async () => {
    const { voiceDelegateToolKeys } = await import("./run-delegation");
    const keys = voiceDelegateToolKeys([...FULL_CHAT_TOOLS, "brand_new_write_tool"]);

    for (const tapTool of VOICE_TAP_TOOLS) {
      expect(keys, tapTool).not.toContain(tapTool);
    }
    for (const writeOrLong of [
      "write_file",
      "edit_file",
      "delete_file",
      "run_code",
      "build_deck",
      "image_generate",
      "video_generate",
      ...GENERALIST_WORKER_TOOLS,
    ]) {
      expect(keys, writeOrLong).not.toContain(writeOrLong);
    }
    expect(keys).not.toContain(DELEGATE_TOOL_KEY);
    expect(keys).not.toContain("brand_new_write_tool");
    expect([...keys].sort()).toEqual([...VOICE_READ_TOOLS].sort());
  });
});

describe("voice-started delegation cannot reopen tap-only tools", () => {
  it("excludes every VOICE_TAP_TOOLS key for a tb- bot and changes no desk files", async () => {
    const { VOICE_DELEGATED_RUN_RULES } = await import("./run-delegation");
    const beforeFiles = await deskFilesSnapshot();

    const seen: ExecuteInput[] = [];
    answeringRuntime(seen);

    const result = await delegateFrom(
      { agent: "tb-ops-bot", task: "Summarize the schedule and save a new file on the desk." },
      { voice: true },
    );

    expect(result).toMatchObject({ ok: true, agent: "tb-ops-bot" });
    expect(seen).toHaveLength(1);
    const run = seen[0] as ExecuteInput;
    const boundKeys = run.bindings.map((binding) => binding.toolKey);

    for (const tapTool of VOICE_TAP_TOOLS) {
      expect(boundKeys, tapTool).not.toContain(tapTool);
    }
    for (const forbidden of [
      "write_file",
      "edit_file",
      "delete_file",
      "run_code",
      "build_deck",
      "image_generate",
      "video_generate",
      DELEGATE_TOOL_KEY,
      ...GENERALIST_WORKER_TOOLS,
    ]) {
      expect(boundKeys, forbidden).not.toContain(forbidden);
    }
    expect([...boundKeys].sort()).toEqual([...VOICE_READ_TOOLS].sort());
    expect(run.version.systemPrompt).toContain(VOICE_DELEGATED_RUN_RULES);
    expect(await deskFilesSnapshot()).toEqual(beforeFiles);
  });

  it("excludes every VOICE_TAP_TOOLS key for a mode agent (documents and research)", async () => {
    const { VOICE_DELEGATED_RUN_RULES } = await import("./run-delegation");
    for (const mode of ["documents", "research"] as const) {
      const seen: ExecuteInput[] = [];
      answeringRuntime(seen);

      const result = await delegateFrom(
        { agent: mode, task: `Run a ${mode} task from voice.` },
        { voice: true },
      );

      expect(result).toMatchObject({ ok: true, agent: mode });
      expect(seen).toHaveLength(1);
      const run = seen[0] as ExecuteInput;
      const boundKeys = run.bindings.map((binding) => binding.toolKey);

      for (const tapTool of VOICE_TAP_TOOLS) {
        expect(boundKeys, `${mode}:${tapTool}`).not.toContain(tapTool);
      }
      for (const worker of GENERALIST_WORKER_TOOLS) {
        expect(boundKeys, `${mode}:${worker}`).not.toContain(worker);
      }
      expect(boundKeys, `${mode}:delegate`).not.toContain(DELEGATE_TOOL_KEY);
      expect([...boundKeys].sort()).toEqual([...VOICE_READ_TOOLS].sort());
      expect(run.version.systemPrompt).toContain(VOICE_DELEGATED_RUN_RULES);
    }
  });

  it("keeps today's exact delegated tool set for typed Chat delegations (both mode agent and tb- bot)", async () => {
    const { VOICE_DELEGATED_RUN_RULES } = await import("./run-delegation");
    const expectedDocuments = delegateToolKeys(virtualAgentFor("documents"));
    const expectedBot = delegateToolKeys({ tools: FULL_CHAT_TOOLS });

    const modeSeen: ExecuteInput[] = [];
    answeringRuntime(modeSeen);
    const modeResult = await delegateFrom({ agent: "documents", task: "Draft a short memo." });
    expect(modeResult).toMatchObject({ ok: true, agent: "documents" });
    expect((modeSeen[0] as ExecuteInput).bindings.map((b) => b.toolKey)).toEqual(expectedDocuments);
    expect((modeSeen[0] as ExecuteInput).version.systemPrompt).not.toContain(VOICE_DELEGATED_RUN_RULES);

    const botSeen: ExecuteInput[] = [];
    answeringRuntime(botSeen);
    const botResult = await delegateFrom({ agent: "tb-ops-bot", task: "Update the desk checklist." });
    expect(botResult).toMatchObject({ ok: true, agent: "tb-ops-bot" });
    expect((botSeen[0] as ExecuteInput).bindings.map((b) => b.toolKey)).toEqual(expectedBot);
    expect((botSeen[0] as ExecuteInput).version.systemPrompt).not.toContain(VOICE_DELEGATED_RUN_RULES);

    for (const kept of ["write_file", "edit_file", "delete_file", "run_code", "build_deck", ...GENERALIST_WORKER_TOOLS]) {
      expect((botSeen[0] as ExecuteInput).bindings.map((b) => b.toolKey), kept).toContain(kept);
    }
    for (const dropped of DELEGATE_EXCLUDED_TOOLS) {
      expect((botSeen[0] as ExecuteInput).bindings.map((b) => b.toolKey), dropped).not.toContain(dropped);
    }
  });

  it("guards that run-delegation filters voice bindings against VOICE_TAP_TOOLS, not only DELEGATE_EXCLUDED_TOOLS", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-delegation.ts"), "utf8");
    expect(source).toContain("VOICE_TAP_TOOLS");
    expect(source).toContain("voiceDelegateToolKeys(");
    expect(source).toContain("asking.voice === true");
    expect(source).toContain("delegateToolKeys(");
  });
});
