/**
 * SR-138 through the real HTTP adapter and the real router, hosted.
 *
 * Two things the router-level tests cannot show:
 *   - a client that goes away mid-run (the response is destroyed) ends the run and frees its slot,
 *     and so does a response that throws on write;
 *   - the 503 `server_busy` refusal survives the adapter's error masking with its code, so the
 *     renderer can show its own sentence, while a 429 keeps the host's text.
 *
 * Only the runtime is a stand-in: it holds every run open and honours the run's abort signal. The
 * session is a real row in the host's own session store, and CSRF and Origin are the real rules.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-limits-adapter-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "4c8e0a2b6d1f43579a3c5e7092b4d6f8a1c3e5072b9d4f6a8c0e2a4b6d8f0132";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;

import { CSRF_COOKIE_SECURE, CSRF_HEADER, mintCsrfTokenFor } from "./csrf";
import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
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

const { handleNodeRequest, INTERNAL_ERROR_MESSAGE } = await import("./http-adapter");
const { dispatch } = await import("./router");
const { activeRuns, admitRun } = await import("./run-limits");
const { hostSessionStore, resetHostAuthForTests } = await import("./auth");

const ORIGIN = "https://app.nultron.test";
const HOST = "app.nultron.test";
const IDENTITY = { tenantId: "adapter-tenant", orgId: "adapter-org", userId: "adapter-user" } as const;
const OTHER = { tenantId: "adapter-other", organizationId: "adapter-other-org" } as const;

let sessionId = "";
let threadIds: string[] = [];

type FakeResponse = {
  readonly res: ServerResponse;
  readonly written: string[];
  status(): number;
  json(): { error?: { code?: string; message?: string } };
  /** The socket going away: marks the response destroyed and fires its `close` listeners. */
  destroy(): void;
  /** Every later write throws, as a socket that fell over under the writer. */
  breakWrites(): void;
};

function fakeResponse(): FakeResponse {
  const listeners = new Map<string, Array<() => void>>();
  const written: string[] = [];
  let breakWrites = false;
  const sink = {
    statusCode: 200,
    writableFinished: false,
    destroyed: false,
    headersSent: false,
    setHeader(): void {},
    removeHeader(): void {},
    getHeader(): undefined {
      return undefined;
    },
    flushHeaders(): void {
      sink.headersSent = true;
    },
    on(event: string, callback: () => void): unknown {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return sink;
    },
    write(chunk: unknown): boolean {
      if (breakWrites) {
        throw new Error("EPIPE");
      }
      if (sink.destroyed) {
        return false;
      }
      written.push(String(chunk));
      return true;
    },
    end(chunk?: unknown): void {
      if (chunk !== undefined) {
        written.push(String(chunk));
      }
      sink.writableFinished = true;
    },
  };
  return {
    res: sink as unknown as ServerResponse,
    written,
    status: () => sink.statusCode,
    json: () => {
      try {
        return JSON.parse(written.join(""));
      } catch {
        return {};
      }
    },
    destroy: () => {
      sink.destroyed = true;
      for (const callback of listeners.get("close") ?? []) {
        callback();
      }
    },
    breakWrites: () => {
      breakWrites = true;
    },
  };
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const token = mintCsrfTokenFor(sessionId);
  const stream = new PassThrough();
  stream.end(body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8"));
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    "x-forwarded-proto": "https",
    host: HOST,
    origin: ORIGIN,
    cookie: `${SESSION_COOKIE_SECURE}=${sessionId}; ${CSRF_COOKIE_SECURE}=${token}`,
    [CSRF_HEADER]: token,
    "x-agentforge-transport": "web",
    "content-type": "application/json",
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.50" }, configurable: true });
  return req;
}

/** Straight through the router, as the signed-in person, for the set-up calls. */
async function viaRouter<T>(method: string, path: string, body?: unknown): Promise<T> {
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${sessionId}` },
    body,
  };
  const result: HostResult = await dispatch(request);
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return ((result as HostJsonResult).body ?? {}) as T;
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

beforeAll(async () => {
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
  process.env.AGENTFORGE_TRUSTED_ORIGINS = ORIGIN;
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  await ensurePortalOwner(db, { ...IDENTITY, role: "owner" });
  const session = createSession({ ...IDENTITY, now: Date.now() });
  await hostSessionStore().create(session);
  sessionId = session.id;
  const saved = await viaRouter<{ gateway: { allowed: boolean } }>("POST", "/api/v1/settings", {
    openaiApiKey: "sk-adapter-test-aaaaaaaaaaaaaaaa",
  });
  expect(saved.gateway, "the gate did not open").toMatchObject({ allowed: true });
  const chat = await viaRouter<{ agent: { id: string } }>("GET", "/api/v1/chat");
  threadIds = [];
  for (let i = 0; i < 3; i += 1) {
    const created = await viaRouter<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
    threadIds.push(created.thread.id);
  }
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  held.length = 0;
  process.env.AGENTFORGE_SERVER = "1";
  process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
  delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;
});

afterEach(async () => {
  await vi.waitFor(
    () => {
      for (const entry of held) {
        entry.finish();
      }
      expect(activeRuns(), "a slot outlived its run").toBe(0);
    },
    { timeout: 20_000 },
  );
  delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
  delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_TRUSTED_ORIGINS;
  resetHostAuthForTests();
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const runPath = (index: number) => `/api/v1/threads/${threadIds[index]}/runs/text`;

describe("a chat run through the HTTP adapter", () => {
  it("is admitted, holds one slot, and answers as a stream", async () => {
    const response = fakeResponse();
    const handled = handleNodeRequest(fakeRequest("POST", runPath(0), { content: "hello" }), response.res);
    await until(() => held.length === 1, "the runtime to accept the run");
    expect(activeRuns()).toBe(1);
    response.destroy();
    await handled;
  });

  it("ends the run and frees its slot when the client goes away and the response is destroyed", async () => {
    const response = fakeResponse();
    const handled = handleNodeRequest(fakeRequest("POST", runPath(0), { content: "hello" }), response.res);
    await until(() => held.length === 1, "the runtime to accept the run");
    expect(activeRuns()).toBe(1);

    response.destroy();
    await Promise.race([
      handled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the adapter never finished")), 10_000)),
    ]);

    expect(held[0]?.input.signal?.aborted, "the model call was not cancelled").toBe(true);
    expect(activeRuns()).toBe(0);
    // And the next run is admitted, which is what the slot was for.
    const next = fakeResponse();
    const nextHandled = handleNodeRequest(fakeRequest("POST", runPath(1), { content: "again" }), next.res);
    await until(() => held.length === 2, "the second run to start");
    expect(activeRuns()).toBe(1);
    next.destroy();
    await nextHandled;
  });

  it("frees the slot when a write to the response throws, as a socket that fell over under the writer", async () => {
    const response = fakeResponse();
    response.breakWrites();
    const handled = handleNodeRequest(fakeRequest("POST", runPath(0), { content: "hello" }), response.res);
    await handled.catch(() => undefined);
    expect(activeRuns()).toBe(0);
  });

  it("refuses a second concurrent run of the same tenant with a 429 that keeps the host's own text", async () => {
    const first = fakeResponse();
    const firstHandled = handleNodeRequest(fakeRequest("POST", runPath(0), { content: "one" }), first.res);
    await until(() => held.length === 1, "the first run to start");

    const second = fakeResponse();
    await handleNodeRequest(fakeRequest("POST", runPath(1), { content: "two" }), second.res);
    expect(second.status()).toBe(429);
    const body = second.json();
    expect(body.error?.code).toBe("too_many_runs");
    expect(body.error?.message).toMatch(/runs in progress/);

    first.destroy();
    await firstHandled;
  });
});

describe("the 503 server_busy refusal through the adapter's error masking", () => {
  it("keeps its code and replaces the text, like every 5xx, so the renderer can show its own sentence", async () => {
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "off";
    process.env.AGENTFORGE_MAX_RUNS_TOTAL = "1";
    const someoneElse = admitRun(OTHER);
    try {
      const response = fakeResponse();
      await handleNodeRequest(fakeRequest("POST", runPath(0), { content: "hello" }), response.res);
      expect(response.status()).toBe(503);
      expect(response.json()).toEqual({ error: { code: "server_busy", message: INTERNAL_ERROR_MESSAGE } });
    } finally {
      someoneElse();
    }
  });

  it("answers 503 server_busy for every run while an operator has set a cap of 0", async () => {
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "0";
    const response = fakeResponse();
    await handleNodeRequest(fakeRequest("POST", runPath(0), { content: "hello" }), response.res);
    expect(response.status()).toBe(503);
    expect(response.json().error?.code).toBe("server_busy");
    expect(held).toHaveLength(0);
    expect(activeRuns()).toBe(0);
  });
});
