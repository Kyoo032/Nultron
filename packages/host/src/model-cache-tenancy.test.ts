/**
 * Enterprise BYOK, Phase A, fix 1: the model cache is per tenant on the hosted server.
 *
 * Until now there was one machine file, `localDataDir()/models-cache.json`, written by whichever
 * tenant last saved a key or pressed Refresh and read back into EVERY tenant's model list and
 * Settings (`probe`). With one shared gateway that was a quirk; with each tenant bringing its own
 * provider keys it would show tenant A's provider catalogue (and the errors a probe with A's key
 * produced) to tenant B. On the hosted server the cache is now a `tenant_state` row, key
 * `model_cache`, per tenant. On the desktop and webdev it is the same file it always was.
 *
 * The connection is a throwaway in-memory database registered directly (the idiom of
 * `tenant-secrets.test.ts`), so nothing here opens the process's real database.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, LOCAL_TENANT_ID, type ChatModel } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import type { HostSession } from "./types";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-model-cache-tenancy-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.AGENTFORGE_SERVER;
delete process.env.OPENAI_API_KEY;

const modelCache = await import("./model-cache");
const selectable = await import("./selectable-models");
const stateStore = await import("./tenant-state-store");
const { withRequestSession } = await import("./tenant-scope");

// SR-163: a hosted cache is a company's, so a scope names its organisation as well as its partner. The ids
// match `sessionFor` below, so a scope and a request session in these cases mean the same company.
const A = { tenantId: "tenant-alpha", organizationId: "org-tenant-alpha" };
const B = { tenantId: "tenant-beta", organizationId: "org-tenant-beta" };

function model(id: string, provider: ChatModel["provider"] = "openai"): ChatModel {
  return { id, label: id, provider, inputModalities: ["text"] };
}

const CACHE_A = {
  openai: [model("alpha-only-chat")],
  openaiProbedAt: "2026-10-01T00:00:00.000Z",
  anthropic: [model("claude-alpha-only", "anthropic")],
  anthropicProbedAt: "2026-10-01T00:00:00.000Z",
};

const CACHE_B = {
  openai: [model("beta-only-chat")],
  openaiProbedAt: "2026-10-01T00:00:01.000Z",
  openaiError: "beta's probe failed",
};

let sqlite: Database.Database;

function hosted(): void {
  process.env.AGENTFORGE_SERVER = "1";
}

function sessionFor(tenantId: string): HostSession {
  return { id: `session-${tenantId}`, tenantId, orgId: `org-${tenantId}`, userId: `user-${tenantId}` };
}

function stateRows(): Array<{ tenant_id: string; key: string }> {
  return sqlite.prepare("SELECT tenant_id, key FROM tenant_state ORDER BY tenant_id, key").all() as Array<{
    tenant_id: string;
    key: string;
  }>;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  for (const tenantId of [A.tenantId, B.tenantId, LOCAL_TENANT_ID]) {
    sqlite
      .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, tenantId, tenantId, "active", Date.now());
  }
  stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
  stateStore.resetTenantStateAdoptionForTests();
  selectable.resetCatalogMemo();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
  vi.unstubAllGlobals();
  stateStore.resetTenantStateSqlForTests();
  sqlite.close();
  rmSync(path.join(dataDir, "models-cache.json"), { force: true });
  selectable.resetCatalogMemo();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("on the hosted server each tenant has its own model cache", () => {
  it("keeps tenant A's probe and catalogue out of tenant B's reads", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);

    expect(modelCache.loadModelCache(A).openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    expect(modelCache.loadModelCache(B)).toEqual({
      openai: undefined,
      anthropic: undefined,
      google: undefined,
      volcengine: undefined,
      openaiProbedAt: undefined,
      anthropicProbedAt: undefined,
      googleProbedAt: undefined,
      volcengineProbedAt: undefined,
      openaiError: undefined,
      anthropicError: undefined,
      googleError: undefined,
      volcengineError: undefined,
      detectedDialect: undefined,
    });
    expect(modelCache.probeSummary(modelCache.loadModelCache(B))).toMatchObject({
      openaiCount: 0,
      anthropicCount: 0,
      totalCount: 0,
    });
    expect(modelCache.probeSummary(modelCache.loadModelCache(A))).toMatchObject({
      openaiCount: 1,
      anthropicCount: 1,
      totalCount: 2,
    });
  });

  it("never lets one tenant's save overwrite another's", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    expect(modelCache.loadModelCache(A).openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    expect(modelCache.loadModelCache(A).openaiError).toBeUndefined();
    expect(modelCache.loadModelCache(B).openai?.map((m) => m.id)).toEqual(["beta-only-chat"]);
    expect(modelCache.loadModelCache(B).openaiError).toBe("beta's probe failed");
    expect(modelCache.loadModelCache(B).anthropic).toBeUndefined();
  });

  it("stores the cache as a tenant_state row and writes no machine file", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    expect(stateRows()).toEqual([
      { tenant_id: A.tenantId, key: `model_cache:${A.organizationId}` },
      { tenant_id: B.tenantId, key: `model_cache:${B.organizationId}` },
    ]);
    expect(existsSync(path.join(dataDir, "models-cache.json"))).toBe(false);
    expect(existsSync(path.join(dataDir, "tenants", A.tenantId, "models-cache.json"))).toBe(false);
  });

  it("does not read the machine file the shared cache used to live in", () => {
    // What an upgraded server may still have on its volume: one tenant's catalogue, shared by all.
    writeFileSync(
      path.join(dataDir, "models-cache.json"),
      JSON.stringify({ openai: [model("legacy-shared-chat")], openaiProbedAt: "2026-09-30T00:00:00.000Z" }),
    );
    hosted();
    expect(modelCache.loadModelCache(A).openai).toBeUndefined();
    expect(modelCache.loadModelCache(B).openai).toBeUndefined();
    expect(selectable.listCatalogModels(A).map((m) => m.id)).not.toContain("legacy-shared-chat");
  });

  it("keeps the derived catalogue per tenant too", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    const idsOf = (tenant: { tenantId: string }) => selectable.listCatalogModels(tenant).map((m) => m.id);
    expect(idsOf(A)).toContain("alpha-only-chat");
    expect(idsOf(A)).toContain("claude-alpha-only");
    expect(idsOf(A)).not.toContain("beta-only-chat");
    expect(idsOf(B)).toContain("beta-only-chat");
    expect(idsOf(B)).not.toContain("alpha-only-chat");
    expect(idsOf(B)).not.toContain("claude-alpha-only");

    const selectableIds = (tenant: { tenantId: string }) => selectable.listSelectableModels(tenant).map((m) => m.id);
    expect(selectableIds(A)).not.toContain("beta-only-chat");
    expect(selectableIds(B)).not.toContain("alpha-only-chat");
    expect(selectable.modelCatalogBody(B).models.map((m) => m.id)).not.toContain("alpha-only-chat");
  });

  it("memoizes per tenant, so two tenants alternating never rebuild each other's catalogue", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    const firstA = selectable.listCatalogModels(A);
    const firstB = selectable.listCatalogModels(B);
    expect(selectable.listCatalogModels(A)).toBe(firstA);
    expect(selectable.listCatalogModels(B)).toBe(firstB);
    expect(firstA).not.toBe(firstB);

    // A write invalidates that tenant's entry and nobody else's.
    modelCache.saveModelCache({ ...CACHE_A, openai: [model("alpha-second-chat")] }, A);
    expect(selectable.listCatalogModels(B)).toBe(firstB);
    expect(selectable.listCatalogModels(A).map((m) => m.id)).toContain("alpha-second-chat");
  });

  it("evicts the tenant used least recently, not the one built first", () => {
    hosted();
    const tenantAt = (index: number) => ({ tenantId: `lru-${index}`, organizationId: `org-lru-${index}` });
    const first = selectable.listCatalogModels(tenantAt(0));
    const second = selectable.listCatalogModels(tenantAt(1));
    for (let index = 2; index < selectable.CATALOG_MEMO_CAP; index += 1) {
      selectable.listCatalogModels(tenantAt(index));
    }
    // The first tenant built is the one in use: reading it again must make it the newest.
    expect(selectable.listCatalogModels(tenantAt(0))).toBe(first);
    // One more tenant than the memo holds pushes the least recently used out: lru-1, not lru-0.
    selectable.listCatalogModels(tenantAt(selectable.CATALOG_MEMO_CAP));
    expect(selectable.listCatalogModels(tenantAt(0))).toBe(first);
    expect(selectable.listCatalogModels(tenantAt(1))).not.toBe(second);
  });

  it("reads the tenant of the request when the caller names none", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    return Promise.all([
      withRequestSession(sessionFor(A.tenantId), async () => {
        await Promise.resolve();
        expect(modelCache.loadModelCache().openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
      }),
      withRequestSession(sessionFor(B.tenantId), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(modelCache.loadModelCache().openai?.map((m) => m.id)).toEqual(["beta-only-chat"]);
        expect(selectable.listCatalogModels().map((m) => m.id)).not.toContain("alpha-only-chat");
      }),
    ]);
  });

  it("refuses a read or a write that cannot name its tenant, rather than guess", () => {
    hosted();
    expect(() => modelCache.loadModelCache()).toThrow(ApiError);
    expect(() => modelCache.saveModelCache(CACHE_A)).toThrow(ApiError);
    expect(() => modelCache.modelCacheStamp()).toThrow(ApiError);
    expect(() => selectable.listCatalogModels()).toThrow(ApiError);
    expect(stateRows()).toEqual([]);
    expect(existsSync(path.join(dataDir, "models-cache.json"))).toBe(false);
  });

  it("refuses a malformed tenant id before it reaches the store", () => {
    hosted();
    expect(() => modelCache.loadModelCache({ tenantId: "../other", organizationId: "org-x" })).toThrow(ApiError);
    expect(() => modelCache.saveModelCache(CACHE_A, { tenantId: "a/b", organizationId: "org-x" })).toThrow(ApiError);
  });

  it("answers a corrupt stored value as an empty cache, like the file always did", () => {
    hosted();
    sqlite
      .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, ?, ?, ?)")
      .run(A.tenantId, `model_cache:${A.organizationId}`, "{not json", Date.now());
    expect(modelCache.loadModelCache(A).openai).toBeUndefined();
  });
});

describe("refreshing writes only the refreshing tenant's cache", () => {
  function stubGateway(listed: string[]): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      urls.push(text);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        return new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    return urls;
  }

  it("leaves the other tenant's catalogue and probe alone", async () => {
    hosted();
    modelCache.saveModelCache(CACHE_B, B);
    stubGateway(["alpha-refreshed-chat"]);

    await selectable.refreshModelCache({ openaiApiKey: "sk-alpha-refresh-1234567890" }, { scope: A });

    expect(modelCache.loadModelCache(A).openai?.map((m) => m.id)).toEqual(["alpha-refreshed-chat"]);
    expect(modelCache.loadModelCache(B).openai?.map((m) => m.id)).toEqual(["beta-only-chat"]);
    expect(modelCache.loadModelCache(B).openaiError).toBe("beta's probe failed");
    expect(existsSync(path.join(dataDir, "models-cache.json"))).toBe(false);
  });

  it("starts from the refreshing tenant's own cache, not from a shared one", async () => {
    hosted();
    modelCache.saveModelCache({ anthropic: [model("claude-alpha-only", "anthropic")] }, A);
    modelCache.saveModelCache({ google: [model("gemini-beta-only", "google")] }, B);
    stubGateway(["alpha-refreshed-chat"]);

    await selectable.refreshModelCache({ openaiApiKey: "sk-alpha-refresh-1234567890" }, { scope: A });

    const after = modelCache.loadModelCache(A);
    expect(after.anthropic?.map((m) => m.id)).toEqual(["claude-alpha-only"]);
    expect(after.google).toBeUndefined();
  });

  it("never probes a base URL taken from the stored settings", async () => {
    hosted();
    const urls = stubGateway(["x"]);
    await selectable.refreshModelCache(
      {
        anthropicApiKey: "sk-ant-alpha-1234567890",
        anthropicBaseUrl: "https://evil.example/v1",
        googleApiKey: "AIza-alpha-1234567890",
        googleBaseUrl: "https://evil.example/v1beta",
        volcengineApiKey: "ark-alpha-1234567890",
        volcengineBaseUrl: "https://evil.example/api/v3",
      },
      { scope: A },
    );
    const hosts = urls.map((url) => new URL(url).hostname);
    expect(hosts).not.toContain("evil.example");
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts).toContain("generativelanguage.googleapis.com");
    expect(hosts).toContain("ark.cn-beijing.volces.com");
  });

  it("does not probe on a stored base URL alone, with no key behind it", async () => {
    hosted();
    const urls = stubGateway(["x"]);
    await selectable.refreshModelCache(
      { anthropicBaseUrl: "https://evil.example/v1", volcengineBaseUrl: "https://evil.example/api/v3" },
      { scope: A },
    );
    const hosts = urls.map((url) => new URL(url).hostname);
    expect(hosts).not.toContain("evil.example");
    expect(hosts).not.toContain("api.anthropic.com");
    expect(hosts).not.toContain("ark.cn-beijing.volces.com");
  });
});

describe("Personal parity: the desktop and webdev keep the one file exactly as it was", () => {
  const FILE = () => path.join(dataDir, "models-cache.json");

  it("writes models-cache.json in the data dir with the same bytes as before", () => {
    modelCache.saveModelCache(CACHE_A);
    expect(readFileSync(FILE(), "utf8")).toBe(`${JSON.stringify(CACHE_A, null, 2)}\n`);
    expect(stateRows()).toEqual([]);
  });

  it("reads it back the way it always did", () => {
    modelCache.saveModelCache(CACHE_A);
    const loaded = modelCache.loadModelCache();
    expect(loaded.openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    expect(loaded.anthropicProbedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(loaded.google).toBeUndefined();
  });

  it("ignores a tenant named by the caller: there is one cache on a desk", () => {
    modelCache.saveModelCache(CACHE_A, A);
    expect(readFileSync(FILE(), "utf8")).toBe(`${JSON.stringify(CACHE_A, null, 2)}\n`);
    expect(modelCache.loadModelCache(B).openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    expect(modelCache.loadModelCache().openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    expect(selectable.listCatalogModels(B).map((m) => m.id)).toEqual(selectable.listCatalogModels().map((m) => m.id));
    expect(stateRows()).toEqual([]);
  });

  it("honours AGENTFORGE_MODELS_CACHE_PATH", () => {
    const custom = path.join(dataDir, "custom-models-cache.json");
    process.env.AGENTFORGE_MODELS_CACHE_PATH = custom;
    try {
      modelCache.saveModelCache(CACHE_A);
      expect(existsSync(custom)).toBe(true);
      expect(existsSync(FILE())).toBe(false);
      expect(modelCache.loadModelCache().openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    } finally {
      rmSync(custom, { force: true });
    }
  });

  it("stamps the file by mtime and size, or says it is missing", () => {
    expect(modelCache.modelCacheStamp()).toBe("missing");
    modelCache.saveModelCache(CACHE_A);
    expect(modelCache.modelCacheStamp()).toMatch(/^\d+(\.\d+)?:\d+$/);
  });

  it("refreshes into the same file, and probes the stored base URL as before", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      urls.push(text);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-local-probe" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    await selectable.refreshModelCache({
      anthropicApiKey: "sk-ant-local-1234567890",
      anthropicBaseUrl: "https://proxy.example/v1",
    });
    expect(urls.some((url) => new URL(url).hostname === "proxy.example")).toBe(true);
    expect(modelCache.loadModelCache().anthropic?.map((m) => m.id)).toEqual(["claude-local-probe"]);
    expect(existsSync(FILE())).toBe(true);
  });

  it("never touches tenant_state, even when a session is in scope", async () => {
    await withRequestSession(sessionFor(A.tenantId), async () => {
      modelCache.saveModelCache(CACHE_A);
      expect(modelCache.loadModelCache().openai?.map((m) => m.id)).toEqual(["alpha-only-chat"]);
    });
    expect(stateRows()).toEqual([]);
  });
});

describe("speech-to-text discovery reads the caller's own catalogue", () => {
  const WHISPER = { openai: [model("whisper-1"), model("alpha-only-chat")] };

  it("finds a recogniser in tenant A's catalogue and none in tenant B's", async () => {
    hosted();
    modelCache.saveModelCache(WHISPER, A);
    modelCache.saveModelCache(CACHE_B, B);
    const { resolveAsrCapability } = await import("./edit/asr");
    const { cachedModelIds } = await import("./meeting/transcribe");

    expect(resolveAsrCapability(A)).toMatchObject({ available: true, model: "whisper-1" });
    expect(resolveAsrCapability(B)).toMatchObject({ available: false, model: null });
    expect(cachedModelIds(A)).toContain("whisper-1");
    expect(cachedModelIds(B)).not.toContain("whisper-1");
  });

  it("answers the Edit doctor's speech-to-text line for the session's tenant", async () => {
    hosted();
    modelCache.saveModelCache(WHISPER, A);
    const { getEditDoctor } = await import("./edit/doctor");

    expect(getEditDoctor({ scope: A }).asr).toMatchObject({ available: true, model: "whisper-1" });
    expect(getEditDoctor({ scope: B }).asr).toMatchObject({ available: false });
    await withRequestSession(sessionFor(A.tenantId), async () => {
      expect(getEditDoctor().asr).toMatchObject({ available: true, model: "whisper-1" });
    });
  });

  it("reports no speech-to-text model, rather than failing, when nobody is behind the report", async () => {
    hosted();
    modelCache.saveModelCache(WHISPER, A);
    const { getEditDoctor } = await import("./edit/doctor");
    expect(getEditDoctor().asr).toEqual({ available: false, backend: null, model: null });
  });

  it("Personal parity: a desk's doctor still reads the one catalogue, whoever asks", async () => {
    modelCache.saveModelCache(WHISPER);
    const { getEditDoctor } = await import("./edit/doctor");
    const { resolveAsrCapability } = await import("./edit/asr");
    expect(resolveAsrCapability()).toMatchObject({ available: true, model: "whisper-1" });
    expect(getEditDoctor().asr).toEqual(resolveAsrCapability());
    expect(getEditDoctor({ scope: B }).asr).toEqual(resolveAsrCapability());
  });
});
