import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * "continue" after a turn that read a private file. The next run starts untainted (the egress guard sees
 * only the earlier turn's text), so the model's history must say that `read_file` ran and must not carry
 * what it returned. The runtime is scripted; what is read is the history the host built for turn 2.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-tool-note-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "f".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
let script: (input: ExecuteInput, attempt: number) => Promise<void> = async () => undefined;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await script(input, executed.length);
      },
    }),
  };
});

const SECRET = "PRIVATE-LEDGER-ROW-20817";

let dispatch: (request: HostRequest) => Promise<HostResult>;
let threadId = "";

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

async function postTurn(content: string): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}`);
  }
  for await (const _frame of result.events) {
    // Read to the end: the host saves the turn before it closes the stream.
  }
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Chat history after a turn that used tools", () => {
  it("tells the model the private read ran, without what it returned, and still quotes an internal tool", async () => {
    const { ensureToolsRegistered } = await import("./register-tools");
    const { getTool } = await import("@agentforge/core");
    ensureToolsRegistered();
    expect(getTool("read_file")?.trust).toBe("user_content");
    expect(getTool("calculator")?.trust).toBe("internal");

    script = async (input) => {
      await input.onEvent({ type: "tool.started", toolKey: "read_file", input: { path: "ledger.csv" } });
      await input.onEvent({ type: "tool.completed", toolKey: "read_file", output: { content: SECRET } });
      await input.onEvent({ type: "tool.started", toolKey: "calculator", input: { expression: "2 + 3" } });
      await input.onEvent({ type: "tool.completed", toolKey: "calculator", output: { result: 5 } });
      await input.onEvent({ type: "assistant.delta", text: "I read the ledger." });
      await input.onEvent({ type: "run.completed", runId: input.runId });
    };
    await postTurn("read my ledger");

    executed.length = 0;
    script = async (input) => {
      await input.onEvent({ type: "assistant.delta", text: "ok" });
      await input.onEvent({ type: "run.completed", runId: input.runId });
    };
    await postTurn("continue");

    const history = executed[0]?.history ?? [];
    const assistant = [...history].reverse().find((turn) => turn.role === "assistant");
    const seen = JSON.stringify(assistant?.parts ?? []);
    expect(seen).toContain("read_file ran, output withheld");
    expect(seen).toContain('calculator: {\\"result\\":5}');
    expect(JSON.stringify(history)).not.toContain(SECRET);
  });
});
