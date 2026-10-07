/**
 * SR-138 through the real router: how many chat runs one tenant may have in flight on the hosted server.
 *
 * Real router, real sessions, real threads and a throwaway data dir; two people in two companies. The
 * one stand-in is the runtime, which holds every run open until the test lets it go, so "in flight" is
 * a state the test controls rather than a race it hopes to win. The runtime also honours the run's
 * abort signal the way the real one does, so a client that goes away really ends the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-limits-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "5d1b9e3a7c0f42688a1d3e5f7b9c0a2d4e6f8091a3b5c7d9e1f30415263748a9";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;

import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

/** A run the fake runtime has accepted and is holding open. */
type Held = { readonly input: ExecuteInput; readonly finish: () => void; finished: boolean };
const held: Held[] = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        await new Promise<void>((resolve) => {
          const entry: Held = {
            input,
            finished: false,
            finish: () => {
              entry.finished = true;
              resolve();
            },
          };
          held.push(entry);
          // What the real runtime does: a cancelled model call ends the run.
          input.signal?.addEventListener("abort", () => entry.finish(), { once: true });
        });
        if (input.signal?.aborted) {
          return;
        }
        await input.onEvent({ type: "assistant.delta", text: "hello" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

/** Research jobs the stand-in below is holding open; the test lets each one go. */
const jobs = vi.hoisted(() => ({ held: [] as Array<{ finish: () => void }> }));

vi.mock("./research-generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./research-generate")>();
  return {
    ...actual,
    // A job that never finishes by itself, so "in flight" is a state the test controls.
    generateResearchNotes: () =>
      new Promise((resolve) => {
        jobs.held.push({ finish: () => resolve({ title: "notes" }) });
      }),
  };
});

const { dispatch } = await import("./router");
const { activeRuns } = await import("./run-limits");

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const PEOPLE = {
  a: { tenantId: "limits-tenant-a", orgId: "limits-org-a", userId: "limits-user-a" },
  b: { tenantId: "limits-tenant-b", orgId: "limits-org-b", userId: "limits-user-b" },
} as const;
type Person = keyof typeof PEOPLE;

const THREADS_PER_PERSON = 5;

let sessionStore: ReturnType<typeof createMemorySessionStore>;
const sessions = {} as Record<Person, ReturnType<typeof createSession>>;
const threads = {} as Record<Person, string[]>;
const open: Array<Promise<unknown>> = [];

function hostedRequest(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${sessions[person].id}` },
    ...over,
  };
}

async function json<T>(request: HostRequest): Promise<T> {
  const result: HostResult = await dispatch(request, { serverMode: true, sessionStore, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return ((result as HostJsonResult).body ?? {}) as T;
}

function postRun(
  person: Person,
  thread: number,
  options: { abortSignal?: AbortSignal; route?: "text" | "image" | "video"; threadId?: string } = {},
): Promise<HostResult> {
  const threadId = options.threadId ?? (threads[person][thread] as string);
  return dispatch(
    hostedRequest(person, "POST", `/api/v1/threads/${threadId}/runs/${options.route ?? "text"}`, {
      params: { threadId },
      body: { content: "hello" },
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    }),
    { serverMode: true, sessionStore, now: () => T0 },
  );
}

/** Reads a stream to its end in the background, as the HTTP adapter does, and remembers it for cleanup. */
function consume(result: HostResult): Promise<string[]> {
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  const frames: string[] = [];
  const drained = (async () => {
    for await (const frame of result.events) {
      frames.push(frame);
    }
    return frames;
  })();
  open.push(drained);
  return drained;
}

/**
 * A run that was admitted: its stream is being read and the runtime holds it open. `frames` settles
 * when the stream ends; it is wrapped in an object because an async function would otherwise await it.
 */
async function startRun(
  person: Person,
  thread: number,
  abortSignal?: AbortSignal,
): Promise<{ readonly frames: Promise<string[]> }> {
  const before = held.length;
  const result = await postRun(person, thread, { abortSignal });
  const frames = consume(result);
  await until(() => held.length > before, "the runtime to accept the run");
  return { frames };
}

function refusedWith(result: HostResult): { status: number; code: string } {
  if (result.type !== "json") {
    throw new Error(`expected a refusal, got ${result.type}`);
  }
  const body = result.body as { error?: { code?: string } };
  return { status: result.status, code: body.error?.code ?? "" };
}

async function until(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets the runtime's oldest still-open run of `person` finish normally. */
function finishOldestRunOf(person: Person): void {
  const entry = held.find(
    (candidate) => !candidate.finished && candidate.input.tenant.userId === PEOPLE[person].userId,
  );
  if (!entry) {
    throw new Error(`${person} has no run in flight`);
  }
  entry.finish();
}

beforeAll(async () => {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  sessionStore = createMemorySessionStore();
  vi.stubGlobal("fetch", async (url: unknown) => {
    const text = String(url);
    if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  process.env.AGENTFORGE_SERVER = "1";
  for (const [person, identity] of Object.entries(PEOPLE) as Array<[Person, (typeof PEOPLE)[Person]]>) {
    await ensurePortalOwner(db, { ...identity, role: "owner" });
    sessions[person] = createSession({ ...identity, now: T0 });
    await sessionStore.create(sessions[person]);
    // A hosted tenant calls a model only with a key the gateway accepted; the gateway is a stub that
    // lists no models and says yes. The key reaches no network and nothing else is faked.
    const saved = await json<{ gateway: { allowed: boolean } }>(
      hostedRequest(person, "POST", "/api/v1/settings", {
        body: { openaiApiKey: `sk-limits-test-${person}-aaaaaaaaaaaa` },
      }),
    );
    expect(saved.gateway, person).toMatchObject({ allowed: true });
    const chat = await json<{ agent: { id: string } }>(hostedRequest(person, "GET", "/api/v1/chat"));
    threads[person] = [];
    for (let i = 0; i < THREADS_PER_PERSON; i += 1) {
      const created = await json<{ thread: { id: string } }>(
        hostedRequest(person, "POST", "/api/v1/threads", { body: { agentId: chat.agent.id } }),
      );
      threads[person].push(created.thread.id);
    }
  }
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  held.length = 0;
  jobs.held.length = 0;
  open.length = 0;
  process.env.AGENTFORGE_SERVER = "1";
  process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "2";
  delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;
});

afterEach(async () => {
  // Whatever a case left running is let go, every stream is read to its end, and then the counter must
  // be back at zero: a slot that survives its run is a leak, and this is where it would show.
  for (const entry of held) {
    entry.finish();
  }
  for (const job of jobs.held) {
    job.finish();
  }
  await Promise.all(open);
  expect(activeRuns(), "a slot outlived its run").toBe(0);
  delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
  delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("hosted chat runs: the per-tenant cap", () => {
  it("refuses a third concurrent run of the same tenant with 429 too_many_runs, before any stream starts", async () => {
    await startRun("a", 0);
    await startRun("a", 1);
    expect(activeRuns()).toBe(2);

    const third = await postRun("a", 2);
    expect(third.type).toBe("json");
    expect(refusedWith(third)).toEqual({ status: 429, code: "too_many_runs" });
    const body = (third as HostJsonResult).body as { error: { message: string } };
    expect(body.error.message.length).toBeGreaterThan(0);

    // The refusal took nothing and started nothing.
    expect(activeRuns()).toBe(2);
    expect(held).toHaveLength(2);
  });

  it("refuses an image and a video run the same way: they share the one door", async () => {
    await startRun("a", 0);
    await startRun("a", 1);
    expect(refusedWith(await postRun("a", 2, { route: "image" }))).toEqual({ status: 429, code: "too_many_runs" });
    expect(refusedWith(await postRun("a", 2, { route: "video" }))).toEqual({ status: 429, code: "too_many_runs" });
    expect(activeRuns()).toBe(2);
  });

  it("lets another tenant in while the first is at its cap", async () => {
    await startRun("a", 0);
    await startRun("a", 1);
    expect(refusedWith(await postRun("a", 2)).code).toBe("too_many_runs");

    await startRun("b", 0);
    expect(activeRuns()).toBe(3);
    await startRun("b", 1);
    expect(refusedWith(await postRun("b", 2)).code).toBe("too_many_runs");
  });

  it("admits a new run as soon as one finishes", async () => {
    const first = await startRun("a", 0);
    await startRun("a", 1);
    expect(refusedWith(await postRun("a", 2)).code).toBe("too_many_runs");

    finishOldestRunOf("a");
    const frames = await first.frames;
    expect(frames.join("")).toContain("run.completed");
    expect(activeRuns()).toBe(1);

    await startRun("a", 2);
    expect(activeRuns()).toBe(2);
  });

  it("frees the slot of a run the client aborted", async () => {
    const abort = new AbortController();
    const aborted = await startRun("a", 0, abort.signal);
    await startRun("a", 1);
    expect(refusedWith(await postRun("a", 2)).code).toBe("too_many_runs");

    abort.abort(new Error("client_disconnected"));
    const frames = await aborted.frames;
    expect(frames.join("")).toContain("run.failed");
    expect(activeRuns()).toBe(1);

    await startRun("a", 2);
    expect(activeRuns()).toBe(2);
  });

  it("frees the slot when the consumer walks away from the stream", async () => {
    const result = await postRun("a", 0);
    if (result.type !== "stream") {
      throw new Error("expected a stream");
    }
    await until(() => held.length === 1, "the runtime to accept the run");
    expect(activeRuns()).toBe(1);
    for await (const _frame of result.events) {
      break;
    }
    expect(activeRuns()).toBe(0);
  });

  it("frees the slot of a run that fails before its first event", async () => {
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
    // A thread that does not exist: the run is refused with a 404 after admission and before the stream.
    const missing = await postRun("a", 0, { threadId: "00000000-0000-4000-8000-000000000000" });
    expect(missing.type).toBe("json");
    expect(missing.status).toBe(404);
    expect(activeRuns()).toBe(0);

    await startRun("a", 0);
    expect(activeRuns()).toBe(1);
  });

  it("frees the slot of a run on another tenant's thread, which tenancy refuses with a 404", async () => {
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
    const foreign = await postRun("a", 0, { threadId: threads.b[0] });
    expect(foreign.status).toBe(404);
    expect(activeRuns()).toBe(0);
    await startRun("a", 0);
  });
});

describe("hosted chat runs: the whole-server cap", () => {
  it("refuses with 503 server_busy once the server is full, though the tenant is under its own cap", async () => {
    process.env.AGENTFORGE_MAX_RUNS_TOTAL = "3";
    await startRun("a", 0);
    await startRun("a", 1);
    await startRun("b", 0);

    const refused = await postRun("b", 1);
    expect(refusedWith(refused)).toEqual({ status: 503, code: "server_busy" });
    expect(activeRuns()).toBe(3);

    // The account that is over its own cap is told that first.
    expect(refusedWith(await postRun("a", 2)).code).toBe("too_many_runs");

    finishOldestRunOf("b");
    await until(() => activeRuns() === 2, "b's run to end");
    await startRun("b", 1);
  });

  it("has no whole-server cap unless the variable is set", async () => {
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "off";
    for (let i = 0; i < THREADS_PER_PERSON; i += 1) {
      await startRun("a", i);
    }
    expect(activeRuns()).toBe(THREADS_PER_PERSON);
  });
});

describe("hosted chat runs: a stream that never gets going", () => {
  it("frees the slot when the consumer returns before reading a single frame", async () => {
    const result = await postRun("a", 0);
    if (result.type !== "stream") {
      throw new Error("expected a stream");
    }
    expect(activeRuns()).toBe(1);
    // What a transport does when the connection is gone before its first write: it stops the iterator
    // without ever calling next(). An async generator would swallow this and keep the slot.
    await result.events[Symbol.asyncIterator]().return?.();
    expect(activeRuns()).toBe(0);
  });

  it("ends a run whose client was already gone, and frees its slot, without calling the model", async () => {
    // A disconnect that lands while the host is still loading the thread: the signal is aborted before
    // the run has registered its abort listener, and an already-aborted signal never fires one.
    const abort = new AbortController();
    abort.abort(new Error("client_disconnected"));
    const result = await postRun("a", 0, { abortSignal: abort.signal });
    if (result.type !== "stream") {
      throw new Error("expected a stream");
    }
    const frames = await Promise.race([
      consume(result),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the run ignored the disconnect")), 5_000)),
    ]);
    expect(frames.join("")).toContain("run.failed");
    expect(held, "a model call was made for a client that had already left").toHaveLength(0);
    expect(activeRuns()).toBe(0);
  });
});

describe("a streaming job through the router", () => {
  const postJob = (person: Person, abortSignal?: AbortSignal): Promise<HostResult> =>
    dispatch(
      hostedRequest(person, "POST", "/api/v1/research/stream", {
        body: {},
        ...(abortSignal ? { abortSignal } : {}),
      }),
      { serverMode: true, sessionStore, now: () => T0 },
    );

  it("holds a slot while it streams, refuses one past the cap, and frees the slot when the job is done", async () => {
    const first = consume(await postJob("a"));
    consume(await postJob("a"));
    await until(() => jobs.held.length === 2, "both jobs to start");
    expect(activeRuns()).toBe(2);

    expect(refusedWith(await postJob("a"))).toEqual({ status: 429, code: "too_many_runs" });
    expect(jobs.held, "a refused job was started anyway").toHaveLength(2);

    // Another tenant is not held up by it.
    consume(await postJob("b"));
    await until(() => jobs.held.length === 3, "the other tenant's job to start");
    expect(activeRuns()).toBe(3);

    jobs.held[0]?.finish();
    expect((await first).join("")).toContain("job.done");
    expect(activeRuns()).toBe(2);
    consume(await postJob("a"));
    await until(() => jobs.held.length === 4, "the replacement job to start");
  });

  it("frees the slot when the client goes away, though the job has not noticed yet", async () => {
    const abort = new AbortController();
    const frames = consume(await postJob("a", abort.signal));
    await until(() => jobs.held.length === 1, "the job to start");
    expect(activeRuns()).toBe(1);
    abort.abort(new Error("client_disconnected"));
    await frames;
    expect(activeRuns()).toBe(0);
  });
});

describe("Personal and webdev", () => {
  it("never cap a run, whatever the variables say", async () => {
    delete process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_RUNTIME = "stub";
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
    process.env.AGENTFORGE_MAX_RUNS_TOTAL = "1";
    try {
      const local = async (method: string, path: string, body?: unknown): Promise<HostResult> =>
        dispatch({ method, path, query: {}, params: {}, headers: {}, body }, { serverMode: false });
      const chat = (await local("GET", "/api/v1/chat")) as HostJsonResult;
      const agentId = (chat.body as { agent: { id: string } }).agent.id;
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const created = (await local("POST", "/api/v1/threads", { agentId })) as HostJsonResult;
        ids.push((created.body as { thread: { id: string } }).thread.id);
      }
      const before = held.length;
      for (const threadId of ids) {
        const result = await dispatch(
          {
            method: "POST",
            path: `/api/v1/threads/${threadId}/runs/text`,
            query: {},
            params: { threadId },
            headers: {},
            body: { content: "hello" },
          },
          { serverMode: false },
        );
        consume(result);
      }
      await until(() => held.length === before + 3, "all three runs to be accepted");
      expect(activeRuns()).toBe(0);
    } finally {
      delete process.env.AGENTFORGE_RUNTIME;
    }
  });
});
