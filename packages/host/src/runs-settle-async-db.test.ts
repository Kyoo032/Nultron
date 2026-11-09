import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-settle-async-db-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "f".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const USAGE = { model: "gpt-5.6-sol", inputTokens: 120, outputTokens: 45 };

type Script = "answer" | "partialThenFail";
type HeldWrite = "assistantSave" | "completedFinish" | null;

let script: Script = "answer";
const stallCallbacks: Array<(message: string) => void> = [];

function holdFor(write: HeldWrite) {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { write, reached: false, passed: false, release, opened };
}

let hold = holdFor(null);

async function heldWrite<T>(write: HeldWrite, run: () => Promise<T>): Promise<T> {
  if (hold.write !== write) {
    return run();
  }
  hold.reached = true;
  await hold.opened;
  try {
    return await run();
  } finally {
    hold.passed = true;
  }
}

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        if (script === "partialThenFail") {
          await input.onEvent({ type: "assistant.delta", text: "half an answer" });
          await input.onEvent({ type: "run.failed", message: "gateway dropped the stream" });
          throw new Error("gateway dropped the stream");
        }
        await input.onEvent({ type: "assistant.delta", text: "the answer" });
        await input.onEvent({ type: "run.completed", runId: input.runId, usage: USAGE });
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

vi.mock("./threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./threads")>();
  return {
    ...actual,
    insertMessage: (...args: Parameters<typeof actual.insertMessage>) =>
      args[2] === "assistant"
        ? heldWrite("assistantSave", () => actual.insertMessage(...args))
        : actual.insertMessage(...args),
    finishRun: (...args: Parameters<typeof actual.finishRun>) =>
      args[2] === "completed"
        ? heldWrite("completedFinish", () => actual.finishRun(...args))
        : actual.finishRun(...args),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let agentId = "";

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

async function newThread(): Promise<string> {
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId });
  return created.thread.id;
}

async function openRun(threadId: string, abortSignal?: AbortSignal): Promise<AsyncIterable<string>> {
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

async function drain(events: AsyncIterable<string>): Promise<Array<{ type: string }>> {
  const seen: Array<{ type: string }> = [];
  for await (const frame of events) {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (line) {
      seen.push(JSON.parse(line.slice("data:".length).trim()) as { type: string });
    }
  }
  return seen;
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const SLOW_DESK = { timeout: 20_000 };
const OPEN_FOR_MS = 1_000;
const WATCHDOG_TEXT = "No stream events from gpt-5.6-sol for 120s after it started (timeout).";

type Frame = { type: string; message?: string };

async function readWhileHeld(events: AsyncIterable<string>) {
  const seen: Frame[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const reading = (async () => {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        return true;
      }
      const line = step.value.split("\n").find((entry) => entry.startsWith("data:"));
      if (line) {
        seen.push(JSON.parse(line.slice("data:".length).trim()) as Frame);
      }
    }
  })();
  const open = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), OPEN_FOR_MS));
  const ended = await Promise.race([reading, open]);
  return { ended, seen, next: () => iterator.next() };
}

async function runStatus(threadId: string) {
  const { db, runs } = await import("@agentforge/db");
  const [run] = await db.select().from(runs).where(eq(runs.threadId, threadId));
  return run?.status;
}

async function heldPastWatchdog(threadId: string, events: AsyncIterable<string>, before: () => void = () => {}) {
  await vi.waitFor(() => expect(hold.reached).toBe(true), SLOW_DESK);
  before();
  stallCallbacks[0]?.(WATCHDOG_TEXT);
  const stream = await readWhileHeld(events);
  return { ...stream, passed: hold.passed, statusWhileHeld: await runStatus(threadId) };
}

async function cancelDuringHeldWrite(cancel: () => void): Promise<void> {
  await vi.waitFor(() => expect(hold.reached).toBe(true), SLOW_DESK);
  cancel();
  await nextTick();
  hold.release();
}

async function outcome(threadId: string, seen: Array<{ type: string }>) {
  await vi.waitFor(() => expect(hold.passed).toBe(true), SLOW_DESK);
  await nextTick();
  const { db, runs } = await import("@agentforge/db");
  const [run] = await db.select().from(runs).where(eq(runs.threadId, threadId));
  const { listMessages } = await import("./threads");
  const answers = (await listMessages(tenant, threadId)).filter((row) => row.role === "assistant");
  const { listTenantUsage } = await import("./tenant-usage");
  const usageRows = listTenantUsage(tenant).filter((row) => row.mode === "chat" && row.runId === run?.id);
  return {
    status: run?.status,
    answers: answers.length,
    usageRows: usageRows.length,
    failedFrames: seen.filter((event) => event.type === "run.failed").length,
  };
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  agentId = chat.agent.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  script = "answer";
  hold = holdFor(null);
  stallCallbacks.length = 0;
});

afterEach(() => {
  hold.release();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a database write that yields while a Chat run is ending", () => {
  it("keeps the answer, completes the run and meters it once when the watchdog fires while the run row is closed", async () => {
    hold = holdFor("completedFinish");
    const threadId = await newThread();
    const events = await openRun(threadId);

    await cancelDuringHeldWrite(() => stallCallbacks[0]?.("No output from the model within 120s"));
    const seen = await drain(events);

    expect(await outcome(threadId, seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 1,
      failedFrames: 0,
    });
  });

  it("keeps the answer, completes the run and meters it once when the person leaves while the answer is saved", async () => {
    hold = holdFor("assistantSave");
    const threadId = await newThread();
    const client = new AbortController();
    const events = await openRun(threadId, client.signal);

    await cancelDuringHeldWrite(() => client.abort(new Error("client left")));
    const seen = await drain(events);

    expect(await outcome(threadId, seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 1,
      failedFrames: 0,
    });
  });

  it("never marks a run failed after it saved the partial text of a model that broke mid-stream", async () => {
    script = "partialThenFail";
    hold = holdFor("assistantSave");
    const threadId = await newThread();
    const events = await openRun(threadId);

    await cancelDuringHeldWrite(() => stallCallbacks[0]?.("No output from the model within 120s"));
    const seen = await drain(events);

    expect(await outcome(threadId, seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 0,
      failedFrames: 1,
    });
  });
});

describe("a database write that outlasts the watchdog while a Chat run is ending", () => {
  it("ends the stream with a saving-too-long failure, then keeps the answer once the save lands", async () => {
    hold = holdFor("assistantSave");
    const threadId = await newThread();
    const events = await openRun(threadId);

    const held = await heldPastWatchdog(threadId, events);

    expect({ ended: held.ended, passed: held.passed, status: held.statusWhileHeld }).toEqual({
      ended: true,
      passed: false,
      status: "streaming",
    });
    expect(held.seen.slice(-2).map((frame) => frame.type)).toEqual(["run.failed", "run.completed"]);
    expect(held.seen.find((frame) => frame.type === "run.failed")?.message).toMatch(
      /^Saving this reply is taking too long\./,
    );

    hold.release();
    expect(await outcome(threadId, held.seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 1,
      failedFrames: 1,
    });
    expect(await held.next()).toEqual({ done: true, value: undefined });
  });

  it("closes the stream with no failure when the answer already went out and closing the run row hangs", async () => {
    hold = holdFor("completedFinish");
    const threadId = await newThread();
    const events = await openRun(threadId);

    const held = await heldPastWatchdog(threadId, events);

    expect({ ended: held.ended, passed: held.passed, status: held.statusWhileHeld }).toEqual({
      ended: true,
      passed: false,
      status: "streaming",
    });
    expect(held.seen.at(-1)?.type).toBe("run.completed");

    hold.release();
    expect(await outcome(threadId, held.seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 1,
      failedFrames: 0,
    });
    expect(await held.next()).toEqual({ done: true, value: undefined });
  });

  it("still ends the stream at the watchdog when the person left while the answer was being saved", async () => {
    hold = holdFor("assistantSave");
    const threadId = await newThread();
    const client = new AbortController();
    const events = await openRun(threadId, client.signal);

    const held = await heldPastWatchdog(threadId, events, () => client.abort(new Error("client left")));

    expect({ ended: held.ended, passed: held.passed, status: held.statusWhileHeld }).toEqual({
      ended: true,
      passed: false,
      status: "streaming",
    });

    hold.release();
    expect(await outcome(threadId, held.seen)).toEqual({
      status: "completed",
      answers: 1,
      usageRows: 1,
      failedFrames: 1,
    });
  });
});
