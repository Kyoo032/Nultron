/**
 * F7a AC-4: a run past its wall-clock or output cap ends with a clear reason, not silence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-caps-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        // The stub speaks slowly forever: nothing ends this run unless the host's caps do.
        await input.onEvent({ type: "assistant.delta", text: "still talking and talking" });
        await new Promise<void>(() => undefined);
      },
    }),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let threadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function collectStream(): Promise<string[]> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, {
      params: { threadId },
      body: { content: "hello" },
    }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}`);
  }
  const frames: string[] = [];
  for await (const frame of result.events) {
    frames.push(frame);
  }
  return frames;
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  const tenant: TenantContext = await getTenant();
  void tenant;
  const chat = await dispatch(request("GET", "/api/v1/chat"));
  const agentId = (chat.body as { agent: { id: string } }).agent.id;
  const created = await dispatch(request("POST", "/api/v1/threads", { body: { agentId } }));
  threadId = (created.body as { thread: { id: string } }).thread.id;
});

afterEach(() => {
  delete process.env.AGENTFORGE_RUN_MAX_SECONDS;
  delete process.env.AGENTFORGE_RUN_MAX_OUTPUT_BYTES;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("run execution caps", () => {
  it("a run past its wall-clock cap ends failed with the reason", async () => {
    process.env.AGENTFORGE_RUN_MAX_SECONDS = "0";
    const frames = await collectStream();
    expect(frames.some((frame) => frame.includes("time limit"))).toBe(true);
  });

  it("a run past its output cap ends failed with the reason", async () => {
    process.env.AGENTFORGE_RUN_MAX_OUTPUT_BYTES = "5";
    const frames = await collectStream();
    expect(frames.some((frame) => frame.includes("more output than allowed"))).toBe(true);
  });
});
