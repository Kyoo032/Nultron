import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * A Chat run whose client left, or whose model went quiet, stops the model call.
 *
 * Both paths already told the person the run failed and closed the stream; neither stopped the request
 * in flight, so the gateway kept answering, and billing, for nobody. The runtime is the one stand-in:
 * its call stays open until the signal it was handed fires, as a slow gateway's would.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-cancel-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
/** What each in-flight call saw on its signal when it woke. */
const observedAborted: boolean[] = [];
/** The stall guard's callback for each run, so a test can fire the watchdog without waiting two minutes. */
const stallCallbacks: Array<(message: string) => void> = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await input.onEvent({ type: "assistant.delta", text: "partial" });
        await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
        observedAborted.push(input.signal?.aborted === true);
        throw input.signal?.reason;
      },
    }),
  };
});

vi.mock("./run-stall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-stall")>();
  return {
    ...actual,
    armRunStallGuard: (options: { onStall: (message: string) => void }) => {
      stallCallbacks.push(options.onStall);
      return { touch: () => {}, touchOutput: () => {}, close: () => {} };
    },
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

/** Opens a run and returns the stream; the run reaches the runtime without the stream being read. */
async function openRun(abortSignal?: AbortSignal): Promise<AsyncIterable<string>> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, {
      params: { threadId },
      body: { content: "hello" },
      ...(abortSignal ? { abortSignal } : {}),
    }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  return result.events;
}

/** The events the person saw, in order. */
async function drain(events: AsyncIterable<string>): Promise<Array<{ type: string; message?: string }>> {
  const seen: Array<{ type: string; message?: string }> = [];
  for await (const frame of events) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (line) {
      seen.push(JSON.parse(line.slice("data:".length).trim()) as { type: string; message?: string });
    }
  }
  return seen;
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  // The first visit creates the local owner and the default chat agent, like opening Chat does.
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
  observedAborted.length = 0;
  stallCallbacks.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Chat and a run that nobody is waiting for", () => {
  it("hands the runtime a signal of its own, not yet fired, while the client is connected", async () => {
    const client = new AbortController();
    const events = await openRun(client.signal);
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(executed[0]?.signal?.aborted).toBe(false);

    client.abort(new Error("client left"));
    await drain(events);
  });

  it("aborts the request in flight when the client leaves, and tells the person once", async () => {
    const client = new AbortController();
    const events = await openRun(client.signal);
    await vi.waitFor(() => expect(executed).toHaveLength(1));

    client.abort(new Error("client left"));
    const seen = await drain(events);

    await vi.waitFor(() => expect(observedAborted).toEqual([true]));
    expect(executed[0]?.signal?.reason).toMatchObject({ message: "client left" });
    expect(seen.filter((event) => event.type === "run.failed")).toEqual([
      { type: "run.failed", message: "client left" },
    ]);
    expect(seen.at(-1)).toMatchObject({ type: "run.completed" });
    // One model call, and the cancel did not start a second.
    expect(executed).toHaveLength(1);
  });

  it("aborts the request in flight when the stall guard gives up on the model", async () => {
    const events = await openRun();
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(stallCallbacks).toHaveLength(1);

    stallCallbacks[0]?.("No first token from the model within 120s");
    const seen = await drain(events);

    await vi.waitFor(() => expect(observedAborted).toEqual([true]));
    expect(seen.filter((event) => event.type === "run.failed")).toEqual([
      { type: "run.failed", message: "No first token from the model within 120s" },
    ]);
  });
});
