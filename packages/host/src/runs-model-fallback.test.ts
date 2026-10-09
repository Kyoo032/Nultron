import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * A Chat turn whose default model cannot be reached, before it said a word, is answered once by the
 * next live model, the way a job is. The runtime is scripted, so what is read is the host's own
 * decision: which model each attempt ran on, the frames the screen received, and what was saved.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-model-fallback-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
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

const DEFAULT = "gpt-6-sol";
const STAND_IN = "gpt-6-luna";
const OTHER = "claude-sonnet-5-5";

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  const row = (id: string) => ({ id, label: id, provider: "openai", inputModalities: ["text"] });
  return {
    ...actual,
    listSelectableModels: () => [row(DEFAULT), row(STAND_IN), row(OTHER)],
    defaultSelectableModel: () => DEFAULT,
  };
});

const UNREACHABLE = `Could not reach ${DEFAULT}: the gateway answered 503 (no available channel).`;

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
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

type Frame = { event: string; data: Record<string, unknown> };

async function postTurn(extra: Record<string, unknown> = {}): Promise<Frame[]> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, {
      params: { threadId },
      body: { content: "hello", ...extra },
    }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  let raw = "";
  for await (const frame of result.events) {
    raw += frame;
  }
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
      const data = JSON.parse((lines.find((line) => line.startsWith("data:")) ?? "data: {}").slice(5)) as Record<
        string,
        unknown
      >;
      return { event, data };
    });
}

/** What the real runtime does when a model call fails: say so, then throw the same sentence. */
async function failWith(input: ExecuteInput, message: string): Promise<never> {
  await input.onEvent({ type: "run.failed", message });
  throw new Error(message);
}

async function answer(input: ExecuteInput, text: string): Promise<void> {
  await input.onEvent({ type: "assistant.delta", text });
  await input.onEvent({ type: "run.completed", runId: input.runId });
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(async () => {
  executed.length = 0;
  const { resetJobModelCircuit } = await import("./job-model-fallback");
  resetJobModelCircuit();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Chat model fallback", () => {
  it("answers on the next live model when the default cannot be reached before it spoke", async () => {
    script = async (input, attempt) => {
      if (attempt === 1) {
        await failWith(input, UNREACHABLE);
      }
      await answer(input, "from the stand-in");
    };
    const frames = await postTurn({ model: DEFAULT });
    expect(executed.map((run) => run.version.model)).toEqual([DEFAULT, STAND_IN]);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(false);
    const notice = frames.find((frame) => frame.event === "run.model_fallback");
    expect(notice?.data).toMatchObject({ from: DEFAULT, to: STAND_IN });
    expect(typeof notice?.data.message).toBe("string");
    expect(frames.filter((frame) => frame.event === "run.completed")).toHaveLength(1);
    const { listMessages } = await import("./threads");
    const rows = (await listMessages(tenant, threadId)).filter((row) => row.role === "assistant");
    expect(JSON.stringify(rows[rows.length - 1]?.content)).toContain("from the stand-in");
  });

  it("treats a request with no model at all as nobody's pick", async () => {
    script = async (input, attempt) => {
      if (attempt === 1) {
        await failWith(input, UNREACHABLE);
      }
      await answer(input, "ok");
    };
    await postTurn();
    expect(executed.map((run) => run.version.model)).toEqual([DEFAULT, STAND_IN]);
  });

  it("starts the next turn on the stand-in while the default is marked down", async () => {
    script = async (input, attempt) => {
      if (attempt === 1) {
        await failWith(input, UNREACHABLE);
      }
      await answer(input, "ok");
    };
    await postTurn({ model: DEFAULT });
    executed.length = 0;
    script = async (input) => answer(input, "second");
    const frames = await postTurn({ model: DEFAULT });
    expect(executed.map((run) => run.version.model)).toEqual([STAND_IN]);
    expect(frames.find((frame) => frame.event === "run.model_fallback")?.data).toMatchObject({
      from: DEFAULT,
      to: STAND_IN,
    });
  });

  it("returns the error when the person picked another model", async () => {
    script = async (input) => failWith(input, UNREACHABLE);
    const frames = await postTurn({ model: OTHER });
    expect(executed).toHaveLength(1);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(true);
    expect(frames.some((frame) => frame.event === "run.model_fallback")).toBe(false);
  });

  it("returns the error when the picker was changed back to the default (modelPinned)", async () => {
    script = async (input) => failWith(input, UNREACHABLE);
    const frames = await postTurn({ model: DEFAULT, modelPinned: true });
    expect(executed).toHaveLength(1);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(true);
  });

  it("does not retry once the model has streamed a word", async () => {
    script = async (input) => {
      await input.onEvent({ type: "assistant.delta", text: "half an ans" });
      await failWith(input, UNREACHABLE);
    };
    const frames = await postTurn({ model: DEFAULT });
    expect(executed).toHaveLength(1);
    expect(frames.some((frame) => frame.event === "run.model_fallback")).toBe(false);
  });

  it("does not retry once a tool has started", async () => {
    script = async (input) => {
      await input.onEvent({ type: "tool.started", toolKey: "calculator", input: {} });
      await failWith(input, UNREACHABLE);
    };
    await postTurn({ model: DEFAULT });
    expect(executed).toHaveLength(1);
  });

  it("does not retry a failure that is not the gateway being down (a rejected key)", async () => {
    script = async (input) => failWith(input, "The gateway answered 401: invalid api key.");
    const frames = await postTurn({ model: DEFAULT });
    expect(executed).toHaveLength(1);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(true);
  });

  it("tells the person the stand-in's failure too, and stops after one retry", async () => {
    script = async (input) => failWith(input, UNREACHABLE);
    const frames = await postTurn({ model: DEFAULT });
    expect(executed.map((run) => run.version.model)).toEqual([DEFAULT, STAND_IN]);
    expect(frames.filter((frame) => frame.event === "run.failed")).toHaveLength(1);
    expect(frames.filter((frame) => frame.event === "run.completed")).toHaveLength(1);
  });
});
