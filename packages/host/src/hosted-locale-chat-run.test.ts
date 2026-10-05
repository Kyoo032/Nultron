/**
 * L9, the Chat half: a hosted person who never chose a language is answered in their browser's.
 *
 * Chat keeps its own locale for a run (`startModalityRun`, `./runs.ts`), taken from the person's stored
 * language and carried through `withRunContext`, which `localeForRun()` reads before it looks at the
 * request. So the request-level default (`./hosted-locale-negotiation.test.ts`) would reach every job
 * mode and miss Chat unless Chat takes it too: the screen would be Indonesian and the reply English.
 *
 * Real router, real sessions and threads, throwaway data dir. The one stand-in is the runtime, which
 * records what the run was handed instead of calling a model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-hosted-locale-chat-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "3b7f1e0c9a5d42868f0b1c7e4a9d2f6513c8e0a7b4d9f1256c3a8e0f7b1d4c92";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;

import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

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

const { dispatch } = await import("./router");
const bootLocale = await import("./locale-boot");

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const PEOPLE = {
  fresh: { tenantId: "chat-locale-a", orgId: "chat-locale-org-a", userId: "chat-fresh" },
  choseEn: { tenantId: "chat-locale-b", orgId: "chat-locale-org-b", userId: "chat-chose-en" },
} as const;
type Person = keyof typeof PEOPLE;

const ID_BROWSER = "id-ID,id;q=0.9,en;q=0.8";
const BAHASA_RULE = "Write every user-facing reply in Bahasa Indonesia";

let sessionStore: ReturnType<typeof createMemorySessionStore>;
const sessions = {} as Record<Person, ReturnType<typeof createSession>>;
const threads = {} as Record<Person, string>;

function hostedRequest(person: Person, method: string, path: string, over: Partial<HostRequest> = {}, header?: string): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: {
      cookie: `${SESSION_COOKIE_SECURE}=${sessions[person].id}`,
      ...(header === undefined ? {} : { "accept-language": header }),
    },
    ...over,
  };
}

async function json<T>(request: HostRequest, serverMode = true): Promise<T> {
  const result: HostResult = await dispatch(request, { serverMode, sessionStore, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return ((result as HostJsonResult).body ?? {}) as T;
}

/** Posts one Chat message as `person` and drains the stream, so the run has handed itself to the runtime. */
async function chatAs(person: Person, header?: string): Promise<ExecuteInput> {
  executed.length = 0;
  const result = await dispatch(
    hostedRequest(person, "POST", `/api/v1/threads/${threads[person]}/runs/text`, {
      params: { threadId: threads[person] },
      body: { content: "hello" },
    }, header),
    { serverMode: true, sessionStore, now: () => T0 },
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  for await (const _frame of result.events) {
    // Drain: the run reaches the runtime only as its frames are read.
  }
  expect(executed).toHaveLength(1);
  return executed[0] as ExecuteInput;
}

beforeAll(async () => {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  sessionStore = createMemorySessionStore();
  vi.stubGlobal("fetch", async (url: unknown) => {
    const text = String(url);
    if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
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
      hostedRequest(person, "POST", "/api/v1/settings", { body: { openaiApiKey: `sk-locale-test-${person}-aaaaaaaaaaaa` } }),
    );
    expect(saved.gateway, person).toMatchObject({ allowed: true });
    const chat = await json<{ agent: { id: string } }>(hostedRequest(person, "GET", "/api/v1/chat"));
    const created = await json<{ thread: { id: string } }>(
      hostedRequest(person, "POST", "/api/v1/threads", { body: { agentId: chat.agent.id } }),
    );
    threads[person] = created.thread.id;
  }
  await json(hostedRequest("choseEn", "POST", "/api/v1/settings", { body: { locale: "en" } }));
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_RUNTIME;
  bootLocale.resetBootLocaleForTests();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("hosted Chat, a person who never chose a language", () => {
  it("answers in the browser's language: the run's locale and the model's instruction agree with the screen", async () => {
    const input = await chatAs("fresh", ID_BROWSER);
    expect(input.locale).toBe("id");
    expect(input.version.systemPrompt).toContain(BAHASA_RULE);
  });

  it("answers in English with no header, or one it does not serve", async () => {
    for (const header of [undefined, "fr-FR,fr;q=0.9", "garbage;;;"]) {
      const input = await chatAs("fresh", header);
      expect(input.locale, String(header)).toBe("en");
      expect(input.version.systemPrompt, String(header)).not.toContain(BAHASA_RULE);
    }
  });
});

describe("hosted Chat, a person who chose", () => {
  it("keeps their explicit English when the browser asks for Indonesian", async () => {
    const input = await chatAs("choseEn", ID_BROWSER);
    expect(input.locale).toBe("en");
    expect(input.version.systemPrompt).not.toContain(BAHASA_RULE);
  });
});

describe("Personal Chat", () => {
  it("never reads the header: the run's locale is the saved one, whatever the browser asks", async () => {
    delete process.env.AGENTFORGE_SERVER;
    // A desk with no key runs on the stub runtime, which is what opens its gate here.
    process.env.AGENTFORGE_RUNTIME = "stub";
    const chat = await json<{ agent: { id: string } }>(
      { method: "GET", path: "/api/v1/chat", query: {}, params: {}, headers: { "accept-language": ID_BROWSER } },
      false,
    );
    const created = await json<{ thread: { id: string } }>(
      { method: "POST", path: "/api/v1/threads", query: {}, params: {}, headers: {}, body: { agentId: chat.agent.id } },
      false,
    );
    executed.length = 0;
    const result = await dispatch(
      {
        method: "POST",
        path: `/api/v1/threads/${created.thread.id}/runs/text`,
        query: {},
        params: { threadId: created.thread.id },
        headers: { "accept-language": ID_BROWSER },
        body: { content: "hello" },
      },
      { serverMode: false },
    );
    if (result.type !== "stream") {
      throw new Error(`expected a stream, got ${result.type}`);
    }
    for await (const _frame of result.events) {
      // Drain.
    }
    expect(executed).toHaveLength(1);
    expect(executed[0]?.locale).toBe("en");
    expect(executed[0]?.version.systemPrompt).not.toContain(BAHASA_RULE);
  });
});
