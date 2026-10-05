/**
 * Enterprise BYOK, Phase A, fix 1 through the real router: two signed-in tenants on the hosted server
 * each see their own model list and their own probe summary, and neither sees the other's.
 *
 * `model-cache-tenancy.test.ts` proves the store and the catalogue functions with an in-memory
 * database. This drives `dispatch` with two provisioned tenants on the process's own database (the
 * idiom of `tenancy-harness.test.ts`), so it also proves the handlers pass the tenant down: the model
 * list (`GET /api/v1/models`), the Chat bootstrap (`GET /api/v1/chat`) and Settings (`probe` and the
 * per-mode `defaults`). Not a driven app: the rehearsal on the local cluster is that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-model-cache-routes-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
// Distinct-looking hex, as in the tenancy harness: `getLocalVaultKey` has a variety floor.
process.env.AGENTFORGE_SECRETS_KEY = "6c1e0d9b3a7f4285b0d19e63c4a8f7125e90d3b6a14c8f27d05b9e316a4c7f80";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import type { ChatModel } from "@agentforge/core";
import { dispatch } from "./router";
import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostResult } from "./types";

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const IDENTITY_A = { tenantId: "cache-tenant-a", orgId: "cache-org-a", userId: "cache-user-a" };
const IDENTITY_B = { tenantId: "cache-tenant-b", orgId: "cache-org-b", userId: "cache-user-b" };

const model = (id: string, provider: ChatModel["provider"] = "openai"): ChatModel => ({
  id,
  label: id,
  provider,
  inputModalities: ["text"],
});

let store: ReturnType<typeof createMemorySessionStore>;
let sessionA: ReturnType<typeof createSession>;
let sessionB: ReturnType<typeof createSession>;

async function get(path: string, sessionId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const result: HostResult = await dispatch(
    {
      method: "GET",
      path,
      query: {},
      params: {},
      // Hosted, so the cookie wears its `__Host-` name (`auth/session.ts`).
      headers: { cookie: `${SESSION_COOKIE_SECURE}=${sessionId}` },
    },
    { serverMode: true, sessionStore: store, now: () => T0 },
  );
  if (result.type !== "json") {
    throw new Error(`expected json from ${path}, got ${result.type}`);
  }
  return { status: result.status, body: ((result as HostJsonResult).body ?? {}) as Record<string, unknown> };
}

const idsOf = (list: unknown): string[] => (list as Array<{ id: string }>).map((entry) => entry.id);

beforeAll(async () => {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  await ensurePortalOwner(db, { ...IDENTITY_A, role: "owner" });
  await ensurePortalOwner(db, { ...IDENTITY_B, role: "owner" });
  store = createMemorySessionStore();
  sessionA = createSession({ ...IDENTITY_A, now: T0 });
  sessionB = createSession({ ...IDENTITY_B, now: T0 });
  await store.create(sessionA);
  await store.create(sessionB);

  // Hosted from here on: the cache is a row per tenant, and the call below says whose.
  process.env.AGENTFORGE_SERVER = "1";
  const { saveModelCache } = await import("./model-cache");
  saveModelCache(
    {
      openai: [model("alpha-only-chat"), model("alpha-second-chat")],
      openaiProbedAt: "2026-10-01T00:00:00.000Z",
      anthropic: [model("claude-alpha-only", "anthropic")],
      anthropicProbedAt: "2026-10-01T00:00:00.000Z",
    },
    { tenantId: IDENTITY_A.tenantId },
  );
  saveModelCache(
    {
      openai: [model("beta-only-chat")],
      openaiProbedAt: "2026-10-01T00:00:01.000Z",
      openaiError: "beta probe failed",
    },
    { tenantId: IDENTITY_B.tenantId },
  );
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("GET /api/v1/models on the hosted server", () => {
  it("lists tenant A's own catalogue to tenant A and no one else's", async () => {
    const { status, body } = await get("/api/v1/models", sessionA.id);
    expect(status).toBe(200);
    const ids = idsOf(body.models);
    expect(ids).toContain("alpha-only-chat");
    expect(ids).toContain("claude-alpha-only");
    expect(ids).not.toContain("beta-only-chat");
  });

  it("lists tenant B's own catalogue to tenant B and none of A's", async () => {
    const { status, body } = await get("/api/v1/models", sessionB.id);
    expect(status).toBe(200);
    const ids = idsOf(body.models);
    expect(ids).toContain("beta-only-chat");
    expect(ids).not.toContain("alpha-only-chat");
    expect(ids).not.toContain("alpha-second-chat");
    expect(ids).not.toContain("claude-alpha-only");
  });
});

describe("GET /api/v1/chat on the hosted server", () => {
  it("offers each tenant its own models and a default chosen from them", async () => {
    const a = await get("/api/v1/chat", sessionA.id);
    const b = await get("/api/v1/chat", sessionB.id);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(idsOf(a.body.models)).toContain("alpha-only-chat");
    expect(idsOf(a.body.models)).not.toContain("beta-only-chat");
    expect(idsOf(b.body.models)).toContain("beta-only-chat");
    expect(idsOf(b.body.models)).not.toContain("alpha-only-chat");
    expect(idsOf(b.body.models)).toContain(b.body.defaultModel as string);
  });
});

describe("GET /api/v1/settings on the hosted server", () => {
  it("shows each tenant its own probe summary, errors included", async () => {
    const a = await get("/api/v1/settings", sessionA.id);
    const b = await get("/api/v1/settings", sessionB.id);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.probe).toMatchObject({ openaiCount: 2, anthropicCount: 1, totalCount: 3 });
    expect((a.body.probe as { openaiError?: string }).openaiError).toBeUndefined();
    expect(b.body.probe).toMatchObject({ openaiCount: 1, anthropicCount: 0, totalCount: 1, openaiError: "beta probe failed" });
  });

  it("never carries one tenant's catalogue ids or probe error into the other's answer", async () => {
    const a = JSON.stringify((await get("/api/v1/settings", sessionA.id)).body);
    const b = JSON.stringify((await get("/api/v1/settings", sessionB.id)).body);
    expect(a).not.toContain("beta probe failed");
    expect(a).not.toContain("beta-only-chat");
    expect(b).not.toContain("alpha-only-chat");
  });

  it("answers the same shape it always did, with a stored provider URL no longer echoed", async () => {
    const { body } = await get("/api/v1/settings", sessionA.id);
    for (const field of ["probe", "defaults", "gateway", "runtime", "workspaceId", "hasOpenai", "toolCatalog"]) {
      expect(body, field).toHaveProperty(field);
    }
    expect(body.googleBaseUrl).toBeUndefined();
    expect(body.anthropicBaseUrl).toBeUndefined();
    expect(body.volcengineBaseUrl).toBeUndefined();
  });
});

/**
 * A tenant that saved its key before the model cache became a per-tenant row has a key and no row.
 * Nothing refilled it, so Chat listed static ids until somebody saved Settings again. The first
 * catalogue read now starts one background refresh for such a tenant; the second read is live.
 */
describe("a hosted tenant that upgraded with a key and no cache row", () => {
  const IDENTITY_C = { tenantId: "cache-tenant-c", orgId: "cache-org-c", userId: "cache-user-c" };
  const IDENTITY_D = { tenantId: "cache-tenant-d", orgId: "cache-org-d", userId: "cache-user-d" };
  const KEY_C = "sk-upgrade-cccccccccccccccccccccc";
  let sessionC: ReturnType<typeof createSession>;
  let sessionD: ReturnType<typeof createSession>;
  let listed: string[] = [];
  let probeCount = 0;

  const rowFor = async (tenantId: string): Promise<boolean> => {
    const { db } = await import("@agentforge/db");
    return Boolean(
      db.$client.prepare("SELECT 1 FROM tenant_state WHERE tenant_id = ? AND key = ?").get(tenantId, "model_cache"),
    );
  };

  beforeAll(async () => {
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    await ensurePortalOwner(db, { ...IDENTITY_C, role: "owner" });
    await ensurePortalOwner(db, { ...IDENTITY_D, role: "owner" });
    sessionC = createSession({ ...IDENTITY_C, now: T0 });
    sessionD = createSession({ ...IDENTITY_D, now: T0 });
    await store.create(sessionC);
    await store.create(sessionD);

    // A gateway that lists whatever `listed` says, and counts how often it was asked.
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        probeCount += 1;
        return new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });

    // Tenant C pastes its key through the real route, as it did before the upgrade...
    listed = ["pre-upgrade-chat"];
    const saved: HostResult = await dispatch(
      {
        method: "POST",
        path: "/api/v1/settings",
        query: {},
        params: {},
        headers: { cookie: `${SESSION_COOKIE_SECURE}=${sessionC.id}` },
        body: { openaiApiKey: KEY_C },
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    expect((saved as HostJsonResult).status).toBe(200);
    // ...and then the server upgrades: the key is on disk and the per-tenant cache row is not.
    db.$client.prepare("DELETE FROM tenant_state WHERE tenant_id = ? AND key = ?").run(IDENTITY_C.tenantId, "model_cache");
    probeCount = 0;
    listed = ["upgrade-live-chat"];
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("answers the first read at once, then lists live models on the next, with no Settings save between", async () => {
    expect(await rowFor(IDENTITY_C.tenantId)).toBe(false);

    const first = await get("/api/v1/models", sessionC.id);
    expect(first.status).toBe(200);
    expect(idsOf(first.body.models)).not.toContain("upgrade-live-chat");

    await vi.waitFor(async () => expect(await rowFor(IDENTITY_C.tenantId)).toBe(true));
    const second = await get("/api/v1/models", sessionC.id);
    expect(idsOf(second.body.models)).toContain("upgrade-live-chat");
    // Images, Meeting and Edit read the same cache, so they stop seeing "none" too.
    expect((await get("/api/v1/settings", sessionC.id)).body.probe).toMatchObject({ openaiCount: 1 });
    expect(probeCount).toBe(1);
  });

  it("does nothing for a tenant with no key, and never touches the other tenants' rows", async () => {
    const before = probeCount;
    const read = await get("/api/v1/models", sessionD.id);
    expect(read.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(await rowFor(IDENTITY_D.tenantId)).toBe(false);
    expect(probeCount).toBe(before);
    // A and B kept exactly what they were seeded with.
    expect(idsOf((await get("/api/v1/models", sessionA.id)).body.models)).toContain("alpha-only-chat");
    expect(idsOf((await get("/api/v1/models", sessionB.id)).body.models)).not.toContain("upgrade-live-chat");
  });
});
