/**
 * Enterprise: a hosted tenant that upgraded has a saved key and no `model_cache` row, and must not
 * have to re-save Settings to see its live models.
 *
 * Before BYOK Phase A the model cache was one machine file the server kept filling; Phase A made it a
 * `tenant_state` row per tenant, written only by a Settings save and by the Refresh button. A tenant
 * that already held a key when the server upgraded therefore read an empty cache: Chat listed static
 * ids, Images listed none, Meeting said `no_model`, until somebody saved Settings. A catalogue read on
 * the hosted server now starts ONE background refresh for such a tenant (`warmHostedModelCache`),
 * throttled per tenant and never awaited on the read path.
 *
 * Personal stays exactly as it was. A desk has one cache file, written by the same two actions, and a
 * missing file there is a desk that has not probed yet; nothing in this file's hosted rules applies.
 *
 * The connection is a throwaway in-memory database registered directly (the idiom of
 * `model-cache-tenancy.test.ts`), so nothing here opens the process's real database.
 */
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT_ID, type ChatModel } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-model-cache-warmup-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
/** Server mode demands a real wrap key (`vault-key.ts`). Generated, not typed. */
process.env.AGENTFORGE_SECRETS_KEY = "5e2a7c91d03b48f6a1c7e5d9023b86f4c19d7a3e58b0f246d1a97c3e05b8f162";
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.AGENTFORGE_SERVER;
delete process.env.OPENAI_API_KEY;

const modelCache = await import("./model-cache");
const selectable = await import("./selectable-models");
const settingsStore = await import("./settings-store");
const stateStore = await import("./tenant-state-store");

const A = { tenantId: "tenant-alpha", workspaceId: "desk-a" };
const B = { tenantId: "tenant-beta", workspaceId: "desk-b" };
const KEY_A = "sk-warmup-aaaaaaaaaaaaaaaaaaaaaaaa";

const model = (id: string): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text"] });
const ids = (list: ChatModel[]): string[] => list.map((entry) => entry.id);

let sqlite: Database.Database;

function hosted(): void {
  process.env.AGENTFORGE_SERVER = "1";
}

function cacheRows(): string[] {
  return (
    sqlite.prepare("SELECT tenant_id FROM tenant_state WHERE key = 'model_cache' ORDER BY tenant_id").all() as Array<{
      tenant_id: string;
    }>
  ).map((row) => row.tenant_id);
}

/** A gateway that lists `listed`, recording every URL asked and the bearer it was asked with. */
function stubGateway(listed: string[]): { gatewayCalls: Array<{ url: string; bearer: string }> } {
  const gatewayCalls: Array<{ url: string; bearer: string }> = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const text = String(url);
    if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      gatewayCalls.push({ url: text, bearer: headers.Authorization ?? "" });
      return new Response(JSON.stringify({ data: listed.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  return { gatewayCalls };
}

/** Let promise continuations that were started and not awaited run to the end. */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  settingsStore.resetSettingsCacheForTests();
  selectable.resetCatalogMemo();
  selectable.resetHostedModelCacheWarmups();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stateStore.resetTenantStateSqlForTests();
  settingsStore.resetSettingsCacheForTests();
  sqlite.close();
  selectable.resetCatalogMemo();
  for (const name of readdirSync(dataDir)) {
    rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a hosted catalogue read with no cache row and a saved key", () => {
  it("starts one refresh for that tenant and none for a tenant with no key", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const refresh = vi.fn(async () => ({}));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    expect(selectable.warmHostedModelCache(B, { refresh })).toBe(false);

    expect(refresh).toHaveBeenCalledTimes(1);
    const [settings, options] = refresh.mock.calls[0] as unknown as [{ openaiApiKey?: string }, Record<string, unknown>];
    expect(settings.openaiApiKey).toBe(KEY_A);
    // Named by tenant, so the probe's result lands in tenant A's row whichever request is in scope,
    // and write-if-absent, so a Save or a Refresh that lands first is never overwritten by this.
    expect(options).toEqual({ scope: { tenantId: A.tenantId }, onlyIfMissing: true });
  });

  it("starts nothing for a tenant whose cache row exists, even an empty or errored one", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    modelCache.saveModelCache({ openaiError: "the gateway was unreachable" }, A);
    const refresh = vi.fn(async () => ({}));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("starts nothing when another tenant has the key and this one has not", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const refresh = vi.fn(async () => ({}));

    expect(selectable.warmHostedModelCache(B, { refresh })).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("is started by a key on any provider, not only the gateway", () => {
    hosted();
    settingsStore.saveSettings({ anthropicApiKey: "sk-ant-warmup-aaaaaaaaaaaaaaaaaaaa" }, A);
    const refresh = vi.fn(async () => ({}));
    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
  });

  it("starts one at a time per tenant: a second read while it runs does not start another", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    let release: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<unknown>((resolve) => (release = () => resolve({}))));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(false);
    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
    await drain();
  });

  it("throttles per tenant: not again inside ten minutes, again after", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    // A refresh that finishes without writing a row (the write itself failed), so the tenant still
    // reads as "no row" and only the throttle stands between it and a refresh on every request.
    const refresh = vi.fn(async () => ({}));
    let now = 1_000_000;
    const deps = { refresh, nowMs: () => now };

    expect(selectable.HOSTED_CACHE_WARMUP_THROTTLE_MS).toBe(600_000);
    expect(selectable.warmHostedModelCache(A, deps)).toBe(true);
    await drain();

    now += selectable.HOSTED_CACHE_WARMUP_THROTTLE_MS - 1;
    expect(selectable.warmHostedModelCache(A, deps)).toBe(false);

    now += 1;
    expect(selectable.warmHostedModelCache(A, deps)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not spend a tenant's throttle on a read that found no key", () => {
    hosted();
    const refresh = vi.fn(async () => ({}));
    const now = 1_000_000;

    expect(selectable.warmHostedModelCache(A, { refresh, nowMs: () => now })).toBe(false);
    // The key arrives on the next request, by a path that did not refresh the cache.
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    expect(selectable.warmHostedModelCache(A, { refresh, nowMs: () => now })).toBe(true);
  });

  it("swallows a refresh that rejects, and logs it without the key", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => {
      throw new Error(`probe_failed: gateway said 401 for ${KEY_A}`);
    });

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    await drain();

    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("model_cache_warmup_failed");
    expect(logged).toContain(A.tenantId);
    expect(logged).not.toContain(KEY_A);
  });

  it("logs a probe that failed inside the refresh, which records its error in the row instead of throwing", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => ({ openaiError: `Gateway unreachable (openai: fetch failed for ${KEY_A})` }));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    await drain();

    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("model_cache_warmup_failed");
    expect(logged).toContain("Gateway unreachable");
    expect(logged).not.toContain(KEY_A);
  });

  it("stays quiet when the refresh listed models, even if one provider also errored", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => ({ openai: [model("listed-chat")], anthropicError: "no anthropic key" }));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    await drain();

    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a refresh that throws before it returns a promise", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(() => {
      throw new Error("synchronous failure");
    });

    expect(() => selectable.warmHostedModelCache(A, { refresh })).not.toThrow();
  });

  it("lets the next attempt through after a failure has finished, once the throttle allows it", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => {
      throw new Error("down");
    });
    let now = 5_000_000;
    expect(selectable.warmHostedModelCache(A, { refresh, nowMs: () => now })).toBe(true);
    await drain();
    // Not stuck "in flight" forever: the failed run released its slot.
    now += selectable.HOSTED_CACHE_WARMUP_THROTTLE_MS;
    expect(selectable.warmHostedModelCache(A, { refresh, nowMs: () => now })).toBe(true);
  });

  it("costs the read nothing when the tenant's settings cannot be read", () => {
    hosted();
    sqlite
      .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'settings', ?, ?)")
      .run(A.tenantId, "this is not a sealed envelope", Date.now());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => ({}));

    expect(() => selectable.warmHostedModelCache(A, { refresh })).not.toThrow();
    expect(() => selectable.listCatalogModels(A)).not.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("the catalogue reads that start it", () => {
  const reads: Array<[string, (scope: typeof A) => unknown]> = [
    ["listCatalogModels", (scope) => selectable.listCatalogModels(scope)],
    ["listSelectableModels", (scope) => selectable.listSelectableModels(scope)],
    ["listImageModels", (scope) => selectable.listImageModels(scope)],
    ["listVideoModels", (scope) => selectable.listVideoModels(scope)],
    ["listAudioModels", (scope) => selectable.listAudioModels(scope)],
    ["listMusicModels", (scope) => selectable.listMusicModels(scope)],
    ["listEmbeddingModels", (scope) => selectable.listEmbeddingModels(undefined, scope)],
    ["modeDefaultsFor", (scope) => selectable.modeDefaultsFor(scope)],
    ["modelCatalogBody", (scope) => selectable.modelCatalogBody(scope)],
    ["defaultSelectableModel", (scope) => selectable.defaultSelectableModel(undefined, scope)],
    ["listProbedModels", (scope) => selectable.listProbedModels(undefined, scope)],
    ["listProbedVideoModels", (scope) => selectable.listProbedVideoModels(undefined, scope)],
  ];

  it.each(reads)("%s fills the tenant's cache in the background and the next read is live", async (_name, read) => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const { gatewayCalls } = stubGateway(["warmed-chat-model"]);

    // The first read answers at once with what it has: nothing waits on the network.
    expect(() => read(A)).not.toThrow();
    expect(cacheRows()).toEqual([]);

    await vi.waitFor(() => expect(cacheRows()).toEqual([A.tenantId]));
    expect(ids(selectable.listCatalogModels(A))).toContain("warmed-chat-model");
    expect(gatewayCalls.map((call) => call.bearer)).toEqual([`Bearer ${KEY_A}`]);
  });

  it("probes once however many reads arrive in the same moment, and never again once it has a row", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const { gatewayCalls } = stubGateway(["warmed-chat-model"]);

    selectable.listSelectableModels(A);
    selectable.modelCatalogBody(A);
    selectable.listImageModels(A);
    selectable.modeDefaultsFor(A);
    await vi.waitFor(() => expect(cacheRows()).toEqual([A.tenantId]));
    await drain();
    selectable.listSelectableModels(A);
    selectable.modelCatalogBody(A);
    await drain();

    expect(gatewayCalls).toHaveLength(1);
  });

  it("touches only the tenant that has a key: the other tenant's row is never created", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const { gatewayCalls } = stubGateway(["warmed-chat-model"]);

    selectable.listSelectableModels(B);
    selectable.listSelectableModels(A);
    await vi.waitFor(() => expect(cacheRows()).toEqual([A.tenantId]));
    await drain();

    expect(cacheRows()).toEqual([A.tenantId]);
    expect(gatewayCalls).toHaveLength(1);
    expect(ids(selectable.listCatalogModels(B))).not.toContain("warmed-chat-model");
  });

  it("still refuses a hosted read that names no tenant, and starts nothing", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    const { gatewayCalls } = stubGateway(["warmed-chat-model"]);

    expect(() => selectable.listCatalogModels()).toThrow();
    expect(gatewayCalls).toHaveLength(0);
    expect(cacheRows()).toEqual([]);
  });
});

describe("a refresh that must not overwrite a newer cache", () => {
  it("leaves a row written while its probe was in flight, when asked to write only if absent", async () => {
    hosted();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        await held;
        return new Response(JSON.stringify({ data: [{ id: "slow-old-chat" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });

    const pending = selectable.refreshModelCache({ openaiApiKey: KEY_A }, { scope: A, onlyIfMissing: true });
    // The tenant saves Settings (a new key, a foreground refresh) while the background probe is out.
    modelCache.saveModelCache({ openai: [model("newer-chat")] }, A);
    release();
    await pending;

    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["newer-chat"]);
  });

  it("still writes when nothing else did, and a plain refresh still overwrites as it always did", async () => {
    hosted();
    stubGateway(["fresh-chat"]);
    await selectable.refreshModelCache({ openaiApiKey: KEY_A }, { scope: A, onlyIfMissing: true });
    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["fresh-chat"]);

    modelCache.saveModelCache({ openai: [model("stale-chat")] }, A);
    await selectable.refreshModelCache({ openaiApiKey: KEY_A }, { scope: A });
    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["fresh-chat"]);
  });
});

/**
 * Personal parity. A desk with a saved key and no `models-cache.json` is a desk that has not probed
 * yet; reading its catalogue has never started a probe, and must not start one now.
 */
describe("Personal parity: a desk's catalogue read starts nothing", () => {
  it("does not warm a desk's cache, whatever it holds", () => {
    settingsStore.saveSettings({ openaiApiKey: KEY_A });
    const refresh = vi.fn(async () => ({}));

    expect(selectable.warmHostedModelCache(undefined, { refresh })).toBe(false);
    expect(selectable.warmHostedModelCache({ tenantId: LOCAL_TENANT_ID }, { refresh })).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(deskReads())("%s makes no network call and writes no cache file on a desk", async (_name, read) => {
    settingsStore.saveSettings({ openaiApiKey: KEY_A });
    const { gatewayCalls } = stubGateway(["warmed-chat-model"]);
    // The strongest statement of "Personal is untouched": the desk path does not so much as look at the
    // settings. (Without the server-mode guard a desk read would resolve a tenant called "desk", whose
    // settings are empty, and start nothing by accident; this is what notices the guard going.)
    const settingsRead = vi.spyOn(settingsStore, "loadSettings");

    read();
    await drain();
    await drain();

    expect(settingsRead).not.toHaveBeenCalled();
    expect(gatewayCalls).toHaveLength(0);
    expect(existsSync(path.join(dataDir, "models-cache.json"))).toBe(false);
    expect(modelCache.modelCacheStamp()).toBe("missing");
  });

  it("answers the same empty catalogue it always did", () => {
    settingsStore.saveSettings({ openaiApiKey: KEY_A });
    const before = ids(selectable.listCatalogModels());
    selectable.resetCatalogMemo();
    expect(ids(selectable.listCatalogModels())).toEqual(before);
    expect(modelCache.loadModelCache()).toEqual({});
  });
});

function deskReads(): Array<[string, () => unknown]> {
  return [
    ["listCatalogModels", () => selectable.listCatalogModels()],
    ["listSelectableModels", () => selectable.listSelectableModels()],
    ["listImageModels", () => selectable.listImageModels()],
    ["listAudioModels", () => selectable.listAudioModels()],
    ["modeDefaultsFor", () => selectable.modeDefaultsFor()],
    ["modelCatalogBody", () => selectable.modelCatalogBody()],
    ["defaultSelectableModel", () => selectable.defaultSelectableModel()],
    ["listProbedModels", () => selectable.listProbedModels()],
  ];
}
