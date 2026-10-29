import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * Paid media asks first (SR-167). A turn's body carries the requests the person pressed Run on; the runtime is
 * handed them as grants, and the model is told on that turn to make exactly those. A turn with none still asks.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-paid-media-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "f".repeat(64);
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

async function postRun(body: Record<string, unknown>): Promise<void> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content: "hello", ...body } }),
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
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  executed.length = 0;
});

describe("POST /threads/:id/runs/text and paid media", () => {
  it("asks first on a turn that carries no Run", async () => {
    await postRun({});
    expect(executed).toHaveLength(1);
    expect(executed[0]?.mediaPermission).toEqual({ ask: true, grants: [] });
    expect(executed[0]?.version.systemPrompt).not.toContain("pressed Run");
  });

  it("hands the runtime the requests the person pressed Run on, and tells the model to make exactly those", async () => {
    await postRun({
      paidMedia: { grants: [{ tool: "image_generate", args: { prompt: "a red fox", aspect_ratio: "square" } }] },
    });
    expect(executed[0]?.mediaPermission).toEqual({
      ask: true,
      grants: [{ tool: "image_generate", args: { prompt: "a red fox", aspect_ratio: "square" } }],
    });
    expect(executed[0]?.version.systemPrompt).toContain(
      'image_generate with {"prompt":"a red fox","aspect_ratio":"square"}',
    );
  });

  it("does not let the body turn the question off", async () => {
    await postRun({ paidMedia: { ask: false, grants: [] } });
    expect(executed[0]?.mediaPermission?.ask).toBe(true);
  });
});
