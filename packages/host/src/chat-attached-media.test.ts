import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import { SESSION_COOKIE_SECURE } from "./auth/session";
import type { HostJsonResult, HostResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-chat-attached-media-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const PARTNER = "chat-attached-media-partner";
const ORG = "chat-attached-media-org";
const OWNER = "chat-attached-media-owner";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GENERATE_TOOLS = ["image_generate", "video_generate"];

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
type Seen = { modality: string; keys: string[]; output?: Record<string, unknown>; fetchCalls?: number };
type Person = { readonly tenant: TenantContext; readonly sessionId: string };
type Send = (method: string, path: string, body?: unknown) => Promise<HostResult>;

const swap = vi.hoisted(() => ({ runtime: null as AgentRuntime | null, probeGenerate: false }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (settings: Parameters<typeof actual.createRuntime>[0]) =>
      swap.runtime ?? actual.createRuntime(settings),
  };
});

vi.mock("./gateway-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-gate")>();
  return {
    ...actual,
    requireGatewayAllowedFor: () =>
      ({
        status: "ok",
        allowed: true,
        grace: false,
        endpoint: "",
        endpointLocked: true,
        checkedAt: 0,
        lastOkAt: 0,
      }) as never,
  };
});

const seen: Seen[] = [];
let router: typeof import("./router");
let sessionStore: import("./auth/session-store").SessionStore;
let getTool: typeof import("@agentforge/core").getTool;
let ensureToolsRegistered: typeof import("./register-tools").ensureToolsRegistered;
let owner: Person;

function recordingRuntime(): AgentRuntime {
  return {
    async execute(input: ExecuteInput) {
      const entry: Seen = {
        modality: input.modality,
        keys: input.bindings.map((binding) => binding.toolKey).sort(),
      };
      if (input.modality === "image" && swap.probeGenerate) {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const tool = getTool("image_generate");
        entry.output = (await tool?.execute({ prompt: "fix this picture" }, input.tenant)) as Record<string, unknown>;
        entry.fetchCalls = fetchSpy.mock.calls.length;
      }
      seen.push(entry);
      await input.onEvent({ type: "assistant.delta", text: "ok" });
      await input.onEvent({ type: "run.completed", runId: input.runId });
    },
  };
}

function personalSend(): Send {
  return (method, path, body) =>
    router.dispatch({ method, path, query: {}, params: {}, headers: {}, ...(body === undefined ? {} : { body }) }, {});
}

function hostedSend(person: Person): Send {
  return (method, path, body) =>
    router.dispatch(
      {
        method,
        path,
        query: {},
        params: {},
        headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
        ...(body === undefined ? {} : { body }),
      },
      { serverMode: true, sessionStore },
    );
}

function jsonOf(result: HostResult): { status: number; body: Record<string, unknown> } {
  expect(result.type).toBe("json");
  const json = result as HostJsonResult;
  return { status: json.status, body: (json.body ?? {}) as Record<string, unknown> };
}

async function chatThread(send: Send): Promise<string> {
  const chat = jsonOf(await send("GET", "/api/v1/chat"));
  expect(chat.status, JSON.stringify(chat.body)).toBe(200);
  const agent = chat.body.agent as { id: string };
  const created = jsonOf(await send("POST", "/api/v1/threads", { agentId: agent.id }));
  expect(created.status).toBe(201);
  return (created.body.thread as { id: string }).id;
}

async function turn(send: Send, threadId: string, modality: "text" | "image"): Promise<Seen> {
  const body =
    modality === "text"
      ? { content: "hello" }
      : {
          content: [
            { type: "text", text: "Fix this picture" },
            { type: "image_url", image_url: { url: TINY_PNG } },
          ],
        };
  const before = seen.length;
  const result = await send("POST", `/api/v1/threads/${threadId}/runs/${modality}`, body);
  expect(result.type, JSON.stringify((result as HostJsonResult).body ?? null)).toBe("stream");
  if (result.type === "stream") {
    let raw = "";
    for await (const chunk of result.events) {
      raw += chunk;
    }
    expect(raw).not.toContain("run.failed");
  }
  expect(seen).toHaveLength(before + 1);
  return seen[before];
}

function clearGateEnv(): void {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_SHELL;
}

beforeAll(async () => {
  router = await import("./router");
  ({ getTool } = await import("@agentforge/core"));
  ({ ensureToolsRegistered } = await import("./register-tools"));
  ensureToolsRegistered();
  const sessions = await import("./auth/session-store");
  sessionStore = sessions.createMemorySessionStore();
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const { createSession } = await import("./auth/session");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId: ORG, userId: OWNER, role: "owner" });
  const session = createSession({ tenantId: PARTNER, orgId: ORG, userId: OWNER, now: Date.now() });
  await sessionStore.create(session);
  owner = { tenant, sessionId: session.id };
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  seen.length = 0;
  swap.runtime = recordingRuntime();
  swap.probeGenerate = false;
  clearGateEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  swap.runtime = null;
  swap.probeGenerate = false;
  clearGateEnv();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("an attached picture on a chat turn, by shell", () => {
  it("keeps both generate tools on a hosted enterprise turn, and a generate call waits for approval", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_SHELL = "enterprise";
    swap.probeGenerate = true;
    const send = hostedSend(owner);
    const threadId = await chatThread(send);

    const text = await turn(send, threadId, "text");
    const attached = await turn(send, threadId, "image");

    expect(text.keys).toEqual(expect.arrayContaining(GENERATE_TOOLS));
    expect(attached.keys).toEqual(text.keys);
    expect(attached.output).toMatchObject({ ok: true, status: "pending_approval", kind: "image" });
    expect(typeof attached.output?.proposalId).toBe("string");
    expect(attached.fetchCalls).toBe(0);

    const proposalId = String(attached.output?.proposalId);
    const read = jsonOf(await send("GET", `/api/v1/media/proposals/${proposalId}`));
    expect(read.status).toBe(200);
    expect(read.body.proposal).toMatchObject({ id: proposalId, kind: "image", status: "pending", threadId });
  });

  it("drops both generate tools on a hosted turn when the shell is not enterprise", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const send = hostedSend(owner);
    const threadId = await chatThread(send);

    const text = await turn(send, threadId, "text");
    const attached = await turn(send, threadId, "image");

    expect(text.keys).toEqual(expect.arrayContaining(GENERATE_TOOLS));
    expect(attached.keys).toEqual(text.keys.filter((key) => !GENERATE_TOOLS.includes(key)));
    expect(attached.output).toBeUndefined();
  });

  it("drops both generate tools on a Personal turn, as before", async () => {
    const send = personalSend();
    const threadId = await chatThread(send);

    const text = await turn(send, threadId, "text");
    const attached = await turn(send, threadId, "image");

    expect(text.keys).toEqual(expect.arrayContaining(GENERATE_TOOLS));
    expect(attached.keys).toEqual(text.keys.filter((key) => !GENERATE_TOOLS.includes(key)));
    expect(attached.output).toBeUndefined();
  });
});
