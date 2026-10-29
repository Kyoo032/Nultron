import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModel, PricingCatalog, PricingModel, TenantContext } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import {
  PRICE_BAND_1_MAX_USD_PER_MILLION_INPUT,
  PRICE_BAND_2_MAX_USD_PER_MILLION_INPUT,
  allowanceFor,
  catalogFor,
  priceBandFor,
  priceInfoFromCatalog,
  type ModelAllowance,
  type PriceInfo,
} from "./model-allowance";
import { saveModelCache } from "./model-cache";
import { listSelectableModels, resetCatalogMemo, type SelectableModel } from "./selectable-models";
import {
  registerTenantStateSql,
  resetTenantStateAdoptionForTests,
  resetTenantStateSqlForTests,
} from "./tenant-state-store";

const TENANT: TenantContext = {
  tenantId: "tenant-alpha",
  organizationId: "org-alpha",
  workspaceId: "workspace-alpha",
  userId: "user-alpha",
  role: "owner",
};

const OTHER_TENANT: TenantContext = {
  tenantId: "tenant-beta",
  organizationId: "org-beta",
  workspaceId: "workspace-beta",
  userId: "user-beta",
  role: "owner",
};

function chat(id: string, provider: ChatModel["provider"] = "openai"): ChatModel {
  return { id, label: id, provider, inputModalities: ["text"] };
}

const CACHE = {
  openai: [chat("gpt-5.6-luna"), chat("deepseek-v4-flash"), chat("glm-5.2-fast-preview"), chat("alpha-only-chat")],
  anthropic: [chat("claude-sonnet-5", "anthropic")],
};

const LIVE_IDS = ["alpha-only-chat", "claude-sonnet-5", "deepseek-v4-flash", "glm-5.2-fast-preview", "gpt-5.6-luna"];

function idsOf(models: readonly SelectableModel[]): string[] {
  return models.map((model) => model.id);
}

describe("allow-all matches listSelectableModels on the desk (AGENTFORGE_SERVER unset)", () => {
  let cacheDir: string;
  let previousCachePath: string | undefined;
  let previousServer: string | undefined;

  beforeEach(() => {
    previousCachePath = process.env.AGENTFORGE_MODELS_CACHE_PATH;
    previousServer = process.env.AGENTFORGE_SERVER;
    cacheDir = mkdtempSync(join(tmpdir(), "af-model-allowance-desk-"));
    process.env.AGENTFORGE_MODELS_CACHE_PATH = join(cacheDir, "models-cache.json");
    delete process.env.AGENTFORGE_SERVER;
    resetCatalogMemo();
    saveModelCache(CACHE);
  });

  afterEach(() => {
    if (previousCachePath === undefined) {
      delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
    } else {
      process.env.AGENTFORGE_MODELS_CACHE_PATH = previousCachePath;
    }
    if (previousServer === undefined) {
      delete process.env.AGENTFORGE_SERVER;
    } else {
      process.env.AGENTFORGE_SERVER = previousServer;
    }
    resetCatalogMemo();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("returns exactly what listSelectableModels returns", () => {
    const listed = listSelectableModels(TENANT);
    expect(idsOf(listed)).toEqual(expect.arrayContaining(LIVE_IDS));
    expect(catalogFor(TENANT, allowanceFor(TENANT))).toEqual(listed);
  });

  it("filters the catalogue to the two ids a stub allowance allows, in catalogue order", () => {
    const allowed = new Set(["gpt-5.6-luna", "claude-sonnet-5"]);
    const seenPrices: Array<PriceInfo | null> = [];
    const stub: ModelAllowance = {
      allows: (model, price) => {
        seenPrices.push(price);
        return allowed.has(model.id);
      },
    };
    const catalogue = listSelectableModels(TENANT);
    const filtered = catalogFor(TENANT, stub);
    expect(idsOf(filtered)).toEqual(idsOf(catalogue).filter((id) => allowed.has(id)));
    expect(idsOf(filtered)).toEqual(["gpt-5.6-luna", "claude-sonnet-5"]);
    expect(seenPrices).toHaveLength(catalogue.length);
    expect(seenPrices.every((price) => price === null)).toBe(true);
  });
});

describe("allow-all matches listSelectableModels on the hosted server (AGENTFORGE_SERVER=1)", () => {
  let sqlite: Database.Database;
  let previousServer: string | undefined;

  beforeEach(() => {
    previousServer = process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_SERVER = "1";
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    for (const tenantId of [TENANT.tenantId, OTHER_TENANT.tenantId]) {
      sqlite
        .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(tenantId, tenantId, tenantId, "active", Date.now());
    }
    registerTenantStateSql(sqlite as unknown as Parameters<typeof registerTenantStateSql>[0]);
    resetTenantStateAdoptionForTests();
    resetCatalogMemo();
    saveModelCache(CACHE, TENANT);
  });

  afterEach(() => {
    if (previousServer === undefined) {
      delete process.env.AGENTFORGE_SERVER;
    } else {
      process.env.AGENTFORGE_SERVER = previousServer;
    }
    resetTenantStateSqlForTests();
    sqlite.close();
    resetCatalogMemo();
  });

  it("returns exactly what listSelectableModels returns for the tenant", () => {
    const listed = listSelectableModels(TENANT);
    expect(idsOf(listed)).toEqual(expect.arrayContaining(LIVE_IDS));
    expect(catalogFor(TENANT, allowanceFor(TENANT))).toEqual(listed);
  });

  it("never shows one company's live catalogue to another company", () => {
    expect(idsOf(listSelectableModels(TENANT))).toContain("alpha-only-chat");
    expect(idsOf(listSelectableModels(OTHER_TENANT))).not.toContain("alpha-only-chat");
    expect(idsOf(catalogFor(OTHER_TENANT, allowanceFor(OTHER_TENANT)))).not.toContain("alpha-only-chat");
    expect(catalogFor(OTHER_TENANT, allowanceFor(OTHER_TENANT))).toEqual(listSelectableModels(OTHER_TENANT));
  });
});

function token(modelName: string, modelRatio: number, overrides: Partial<PricingModel> = {}): PricingModel {
  return { modelName, quotaType: 0, modelRatio, completionRatio: 1, modelPrice: 0, ...overrides };
}

function catalogOf(...models: PricingModel[]): PricingCatalog {
  return { models, groupRatio: {} };
}

describe("priceInfoFromCatalog bands input prices per million tokens", () => {
  const catalog = catalogOf(
    token("at-one-dollar", 0.5),
    token("over-one-dollar", 0.5000001),
    token("at-five-dollars", 2.5),
    token("over-five-dollars", 2.5000001),
    token("completion-priced", 0.5, { completionRatio: 4 }),
    token("tiered-model", 0.5, { billingMode: "tiered_expr" }),
    token("zero-ratio", 0),
    { modelName: "per-call", quotaType: 1, modelRatio: 0.5, completionRatio: 1, modelPrice: 0.02 },
  );

  it("uses the named cut points: $1 and $5 per million input tokens", () => {
    expect(PRICE_BAND_1_MAX_USD_PER_MILLION_INPUT).toBe(1);
    expect(PRICE_BAND_2_MAX_USD_PER_MILLION_INPUT).toBe(5);
  });

  it("keeps exactly $1 in band 1 and anything above it in band 2", () => {
    expect(priceInfoFromCatalog(catalog, "at-one-dollar")).toEqual({
      band: 1,
      usdPerMillionInput: 1,
      usdPerMillionOutput: 1,
    });
    expect(priceInfoFromCatalog(catalog, "over-one-dollar")?.band).toBe(2);
  });

  it("keeps exactly $5 in band 2 and anything above it in band 3", () => {
    expect(priceInfoFromCatalog(catalog, "at-five-dollars")?.band).toBe(2);
    expect(priceInfoFromCatalog(catalog, "over-five-dollars")?.band).toBe(3);
  });

  it("bands on the input price and reports the output price beside it", () => {
    expect(priceInfoFromCatalog(catalog, "completion-priced")).toEqual({
      band: 1,
      usdPerMillionInput: 1,
      usdPerMillionOutput: 4,
    });
  });

  it("matches the id without regard to case or surrounding spaces", () => {
    expect(priceInfoFromCatalog(catalog, "  AT-FIVE-DOLLARS ")?.band).toBe(2);
  });

  it("has no band for an id the catalogue does not carry", () => {
    expect(priceInfoFromCatalog(catalog, "not-in-catalog")).toBeNull();
  });

  it("has no band for a per-call model, a tiered model or a model with no positive ratio", () => {
    expect(priceInfoFromCatalog(catalog, "per-call")).toBeNull();
    expect(priceInfoFromCatalog(catalog, "tiered-model")).toBeNull();
    expect(priceInfoFromCatalog(catalog, "zero-ratio")).toBeNull();
  });

  it("has no band without a catalogue", () => {
    expect(priceInfoFromCatalog(null, "at-one-dollar")).toBeNull();
  });
});

describe("priceBandFor reads cached pricing only", () => {
  it("is null for an id with no cached price, and never fetches one", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(priceBandFor("gpt-5.6-luna")).toBeNull();
      expect(priceBandFor("no-such-model")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
