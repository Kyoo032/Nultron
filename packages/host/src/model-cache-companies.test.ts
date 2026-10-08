/**
 * SR-163, review round: the hosted model cache is a company's, not the partner's.
 *
 * `ModelCacheScope` was `{ tenantId }` and the hosted cache was one `tenant_state` row per tenant id. On the
 * server the tenant is the white-label partner and a company is an organisation inside it, so company A's
 * Settings (`probe`) and model list showed whatever company B's last probe left: B's provider error, B's
 * catalogue. The row is now `model_cache:<organisation id>`, the same composite slot the gateway verdict
 * uses (`companyStateKey`).
 *
 * What each caller does without a company, decided here and pinned below:
 *   - a scope that names a company: that company's slot;
 *   - a scope that names only the partner, inside a request whose session is the same partner's: the
 *     session's company (this is the "work started by a request inherits its company" rule that already
 *     held for the tenant);
 *   - anything else on the hosted server (a bare partner with no matching session, nothing at all): refused
 *     with `company_required`, never the partner's row. A read that cannot say whose catalogue it wants is a
 *     bug in the caller, not a reason to show it somebody else's.
 *   - the warm-up never throws: it logs the refusal and starts nothing.
 *
 * The connection is a throwaway in-memory database registered directly (the idiom of
 * `model-cache-tenancy.test.ts`), so nothing here opens the process's real database.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT_ID, type ChatModel } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import type { HostSession } from "./types";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-model-cache-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "6b1d9f3a7c5e4082b4a6c8e0d2f19357a3c5e7b9d1f40628d0a2c4e6f8b19a75";
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.AGENTFORGE_SERVER;
delete process.env.OPENAI_API_KEY;

const modelCache = await import("./model-cache");
const selectable = await import("./selectable-models");
const settingsStore = await import("./settings-store");
const stateStore = await import("./tenant-state-store");
const { withRequestSession } = await import("./tenant-scope");

const PARTNER = "partner-one";
const OTHER_PARTNER = "partner-two";
const A = { tenantId: PARTNER, organizationId: "org-a", workspaceId: "desk-a" };
const B = { tenantId: PARTNER, organizationId: "org-b", workspaceId: "desk-b" };
const SOLO = { tenantId: OTHER_PARTNER, organizationId: "org-solo", workspaceId: "desk-solo" };
const KEY_A = "sk-companies-aaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "sk-companies-bbbbbbbbbbbbbbbbbbbbbbbb";

const model = (id: string, provider: ChatModel["provider"] = "openai"): ChatModel => ({
  id,
  label: id,
  provider,
  inputModalities: ["text"],
});
const ids = (list: ChatModel[]): string[] => list.map((entry) => entry.id);

const CACHE_A = { openai: [model("alpha-only-chat")], openaiProbedAt: "2026-10-07T00:00:00.000Z" };
const CACHE_B = {
  openai: [model("beta-only-chat")],
  openaiProbedAt: "2026-10-07T00:00:01.000Z",
  openaiError: "beta's probe failed",
};

let sqlite: Database.Database;

const hosted = (): void => {
  process.env.AGENTFORGE_SERVER = "1";
};

const sessionOf = (tenantId: string, orgId: string): HostSession => ({
  id: `session-${orgId}`,
  tenantId,
  orgId,
  userId: `user-${orgId}`,
});

function cacheKeys(): string[] {
  return (
    sqlite
      .prepare("SELECT tenant_id, key FROM tenant_state WHERE key LIKE 'model_cache%' ORDER BY tenant_id, key")
      .all() as Array<{ tenant_id: string; key: string }>
  ).map((row) => `${row.tenant_id}|${row.key}`);
}

const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  for (const tenantId of [PARTNER, OTHER_PARTNER, LOCAL_TENANT_ID]) {
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
  delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stateStore.resetTenantStateSqlForTests();
  settingsStore.resetSettingsCacheForTests();
  sqlite.close();
  rmSync(path.join(dataDir, "models-cache.json"), { force: true });
  selectable.resetCatalogMemo();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("two companies under one partner each have their own model cache", () => {
  it("keeps company A's probe and catalogue out of company B's reads", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);

    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(modelCache.loadModelCache(B).openai).toBeUndefined();
    expect(modelCache.probeSummary(undefined, B)).toMatchObject({ openaiCount: 0, totalCount: 0 });
    expect(modelCache.probeSummary(undefined, A)).toMatchObject({ openaiCount: 1, totalCount: 1 });
    // One row per company, in the partner's table: nothing is written to the partner's own slot.
    expect(cacheKeys()).toEqual([`${PARTNER}|model_cache:org-a`]);
  });

  it("never lets one company's save, or its probe error, replace another's", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    expect(modelCache.loadModelCache(A).openaiError).toBeUndefined();
    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(modelCache.probeSummary(undefined, A).openaiError).toBeUndefined();
    expect(modelCache.probeSummary(undefined, B).openaiError).toBe("beta's probe failed");
    expect(cacheKeys()).toEqual([`${PARTNER}|model_cache:org-a`, `${PARTNER}|model_cache:org-b`]);
  });

  it("changes a company's stamp only when that company writes", () => {
    hosted();
    expect(modelCache.modelCacheStamp(A)).toBe("missing");
    modelCache.saveModelCache(CACHE_A, A);
    const stampA = modelCache.modelCacheStamp(A);
    expect(stampA).not.toBe("missing");
    expect(modelCache.modelCacheStamp(B)).toBe("missing");
    modelCache.saveModelCache(CACHE_B, B);
    expect(modelCache.modelCacheStamp(A)).toBe(stampA);
  });

  it("gives each company its own derived-catalogue slot", () => {
    hosted();
    expect(modelCache.modelCacheSlot(A)).not.toBe(modelCache.modelCacheSlot(B));
    expect(modelCache.modelCacheSlot(A)).not.toBe(modelCache.modelCacheSlot(SOLO));
    // And a partner's slot is not a prefix trick: two ids that differ only in their tail never collide.
    expect(modelCache.modelCacheSlot({ ...A, organizationId: "org" })).not.toBe(
      modelCache.modelCacheSlot({ ...A, organizationId: "org-a" }),
    );
  });

  it("lists each company's own models, and memoises them apart", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    expect(ids(selectable.listCatalogModels(A))).toContain("alpha-only-chat");
    expect(ids(selectable.listCatalogModels(A))).not.toContain("beta-only-chat");
    expect(ids(selectable.listCatalogModels(B))).toContain("beta-only-chat");
    expect(ids(selectable.listCatalogModels(B))).not.toContain("alpha-only-chat");
  });

  it("keeps a company that never probed on the static list, whatever its neighbours hold", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    expect(ids(selectable.listCatalogModels(B))).not.toContain("alpha-only-chat");
    expect(modelCache.loadModelCache(B).openai).toBeUndefined();
    expect(modelCache.loadModelCache(B).openaiError).toBeUndefined();
  });
});

describe("two partners with one company each: the topology every earlier test used", () => {
  it("still keeps each partner's cache apart", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, SOLO);

    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(ids(modelCache.loadModelCache(SOLO).openai ?? [])).toEqual(["beta-only-chat"]);
  });
});

describe("a hosted call that cannot name its company", () => {
  it("is refused with company_required, and never reads or writes the partner's row", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);

    const bare = { tenantId: PARTNER };
    expect(() => modelCache.loadModelCache(bare)).toThrowError(expect.objectContaining({ code: "company_required" }));
    expect(() => modelCache.saveModelCache(CACHE_B, bare)).toThrowError(
      expect.objectContaining({ code: "company_required" }),
    );
    expect(() => modelCache.modelCacheStamp(bare)).toThrowError(expect.objectContaining({ code: "company_required" }));
    expect(() => modelCache.modelCacheSlot(bare)).toThrowError(expect.objectContaining({ code: "company_required" }));
    expect(cacheKeys()).toEqual([`${PARTNER}|model_cache:org-a`]);
  });

  it("still refuses a call that names nothing, as it always did, with the tenant error", () => {
    hosted();
    expect(() => modelCache.loadModelCache()).toThrowError(expect.objectContaining({ code: "tenant_required" }));
  });

  it("takes the company from the request in scope when the scope names the same partner", () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);
    modelCache.saveModelCache(CACHE_B, B);

    const inA = withRequestSession(sessionOf(PARTNER, "org-a"), async () => ({
      bare: modelCache.loadModelCache({ tenantId: PARTNER }),
      none: modelCache.loadModelCache(),
    }));
    return inA.then(({ bare, none }) => {
      expect(ids(bare.openai ?? [])).toEqual(["alpha-only-chat"]);
      expect(ids(none.openai ?? [])).toEqual(["alpha-only-chat"]);
    });
  });

  it("does not borrow another partner's session company for a scope that names a different partner", async () => {
    hosted();
    modelCache.saveModelCache(CACHE_A, A);

    await withRequestSession(sessionOf(OTHER_PARTNER, "org-solo"), async () => {
      expect(() => modelCache.loadModelCache({ tenantId: PARTNER })).toThrowError(
        expect.objectContaining({ code: "company_required" }),
      );
    });
  });
});

describe("the hosted warm-up is per company", () => {
  it("starts for the company that has a key and no row, and names the company in the refresh", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    settingsStore.saveSettings({ openaiApiKey: KEY_B }, B);
    modelCache.saveModelCache(CACHE_B, B);
    const refresh = vi.fn(async () => ({}));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    // B already has its own row, so it needs none, whatever A's state.
    expect(selectable.warmHostedModelCache(B, { refresh })).toBe(false);

    expect(refresh).toHaveBeenCalledTimes(1);
    const [settings, options] = refresh.mock.calls[0] as unknown as [{ openaiApiKey?: string }, Record<string, unknown>];
    expect(settings.openaiApiKey).toBe(KEY_A);
    expect(options).toEqual({ scope: { tenantId: PARTNER, organizationId: "org-a" }, onlyIfMissing: true });
  });

  it("does not let one company's running or throttled warm-up stand in for the other's", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    settingsStore.saveSettings({ openaiApiKey: KEY_B }, B);
    let release: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<unknown>((resolve) => (release = () => resolve({}))));

    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(true);
    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(false);
    // A is still in flight; B, in the same partner, gets its own.
    expect(selectable.warmHostedModelCache(B, { refresh })).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);

    release();
    await drain();
  });

  it("writes the probe into the company that started it", async () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    vi.stubGlobal("fetch", async (url: unknown) => {
      if (/\/models(\?|$)/.test(String(url)) && !String(url).includes("models.dev")) {
        return new Response(JSON.stringify({ data: [{ id: "warmed-for-a" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });

    expect(selectable.warmHostedModelCache(A)).toBe(true);
    await vi.waitFor(() => expect(cacheKeys()).toEqual([`${PARTNER}|model_cache:org-a`]));
    expect(ids(modelCache.loadModelCache(A).openai ?? [])).toContain("warmed-for-a");
    expect(modelCache.loadModelCache(B).openai).toBeUndefined();
  });

  it("starts nothing and does not throw for a scope that names only the partner", () => {
    hosted();
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi.fn(async () => ({}));

    expect(() => selectable.warmHostedModelCache({ tenantId: PARTNER }, { refresh })).not.toThrow();
    expect(selectable.warmHostedModelCache({ tenantId: PARTNER }, { refresh })).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Personal: server mode off, the cache is the one file it always was", () => {
  it("ignores the organisation entirely: one file whichever company the scope names", () => {
    modelCache.saveModelCache(CACHE_A, A);

    expect(ids(modelCache.loadModelCache(B).openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(ids(modelCache.loadModelCache({ tenantId: PARTNER }).openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(ids(modelCache.loadModelCache().openai ?? [])).toEqual(["alpha-only-chat"]);
    expect(modelCache.modelCacheSlot(A)).toBe("desk");
    expect(modelCache.modelCacheSlot({ tenantId: PARTNER })).toBe("desk");
    const written = JSON.parse(readFileSync(path.join(dataDir, "models-cache.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(written)).toContain("openai");
    expect(cacheKeys()).toEqual([]);
  });

  it("starts no warm-up on a desk", () => {
    const refresh = vi.fn(async () => ({}));
    expect(selectable.warmHostedModelCache(A, { refresh })).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
