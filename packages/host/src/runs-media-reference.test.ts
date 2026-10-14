import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * A picture made by `image_generate` in one turn is named by its stored reference in the next turn's
 * model input, so "make it brighter" has an id to pass back. The runtime is scripted; what is read is the
 * history the host built for turn 2.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-media-ref-"));
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

/** A 1x1 PNG, as the data URL a generator returns. The host stores it in the media table. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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

describe("Chat history after an image_generate turn", () => {
  it("names the stored reference of the picture in the next turn's model input", async () => {
    script = async (input) => {
      await input.onEvent({ type: "tool.started", toolKey: "image_generate", input: { prompt: "a red bicycle" } });
      await input.onEvent({
        type: "tool.completed",
        toolKey: "image_generate",
        output: { success: true, image: PNG_DATA_URL },
      });
      await input.onEvent({ type: "assistant.delta", text: "Here is the bicycle." });
      await input.onEvent({ type: "run.completed", runId: input.runId });
    };
    await postTurn("draw a red bicycle");

    executed.length = 0;
    script = async (input) => {
      await input.onEvent({ type: "assistant.delta", text: "ok" });
      await input.onEvent({ type: "run.completed", runId: input.runId });
    };
    await postTurn("make it brighter");

    const history = executed[0]?.history ?? [];
    const seen = JSON.stringify(history);
    const reference = seen.match(/reference: \/api\/v1\/media\/([0-9a-f-]{36})\/file/i);
    expect(reference).not.toBeNull();
    // The id names the row the run stored, and the reply's own media part points at the same file.
    expect(seen).toContain(`"url":"/api/v1/media/${reference?.[1]}/file"`);
  });
});
