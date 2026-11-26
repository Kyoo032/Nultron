/**
 * F8d (DFIND-170) — the tenant's model allowlist governs `allowanceFor`.
 *
 * Three sources of truth, in order: the portal's `model_allowlist` on the token body (recorded at
 * sign-in and refresh), then the desk's own `modelAllowlist` setting when no portal ever answered,
 * and an empty or absent list meaning today's behaviour — every model allowed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-model-allowance-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

import type { PricingCatalog, PricingModel, TenantContext } from "@agentforge/core";
import {
  PRICE_BAND_1_MAX_USD_PER_MILLION_INPUT,
  PRICE_BAND_2_MAX_USD_PER_MILLION_INPUT,
  allowanceFor,
  clearTenantModelAllowlist,
  priceBandFor,
  priceInfoFromCatalog,
  recordTenantModelAllowlist,
  tenantAllowedModelIds,
  tenantModelAllowlist,
} from "./model-allowance";
import { loadSettings, saveSettings } from "./settings-store";
import type { SelectableModel } from "./selectable-models";

const tenant: TenantContext = {
  tenantId: "allowance-tenant",
  organizationId: "allowance-org",
  workspaceId: "allowance-desk",
  userId: "allowance-user",
  role: "owner",
};

const model = (id: string): SelectableModel =>
  ({ id, name: id, provider: "test" }) as unknown as SelectableModel;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("tenantModelAllowlist", () => {
  it("is null before anything reports one", () => {
    clearTenantModelAllowlist(tenant.tenantId);
    expect(tenantModelAllowlist(tenant)).toBeNull();
  });

  it("is the portal's record once a token carried it, and a missing field never clears it", () => {
    recordTenantModelAllowlist(tenant.tenantId, ["alpha", "beta"]);
    expect(tenantModelAllowlist(tenant)).toEqual(["alpha", "beta"]);
    recordTenantModelAllowlist(tenant.tenantId, null);
    expect(tenantModelAllowlist(tenant)).toEqual(["alpha", "beta"]);
  });

  it("is the desk's own setting when the portal never sent a list", () => {
    clearTenantModelAllowlist("desk-only-tenant");
    const deskTenant: TenantContext = { ...tenant, tenantId: "desk-only-tenant" };
    saveSettings(
      { modelAllowlist: ["desk-model"] },
      { tenantId: deskTenant.tenantId, workspaceId: deskTenant.workspaceId },
    );
    expect(tenantModelAllowlist(deskTenant)).toEqual(["desk-model"]);
    // And a portal answer overrides the desk's own — the tenant's word, not the machine's.
    recordTenantModelAllowlist("desk-only-tenant", ["portal-model"]);
    expect(tenantModelAllowlist(deskTenant)).toEqual(["portal-model"]);
    expect(loadSettings({ tenantId: "desk-only-tenant", workspaceId: "allowance-desk" }).modelAllowlist).toEqual([
      "desk-model",
    ]);
  });
});

describe("allowanceFor", () => {
  it("allows every model on an empty list, today's behaviour", () => {
    recordTenantModelAllowlist(tenant.tenantId, []);
    expect(allowanceFor(tenant).allows(model("anything"), null)).toBe(true);
  });

  it("unlists and refuses a model that is not on the list", () => {
    recordTenantModelAllowlist(tenant.tenantId, ["good-model"]);
    const allowance = allowanceFor(tenant);
    expect(allowance.allows(model("good-model"), null)).toBe(true);
    expect(allowance.allows(model("unlisted"), null)).toBe(false);
  });

  it("matches ids case-insensitively and ignores padding", () => {
    recordTenantModelAllowlist(tenant.tenantId, ["  Mixed-Case  "]);
    expect(allowanceFor(tenant).allows(model("mixed-case"), null)).toBe(true);
  });
});

describe("tenantAllowedModelIds", () => {
  it("is the lowercased id set the catalog filters by, and null while every model is allowed", () => {
    recordTenantModelAllowlist(tenant.tenantId, []);
    expect(tenantAllowedModelIds(tenant)).toBeNull();
    recordTenantModelAllowlist(tenant.tenantId, ["  One-Model "]);
    expect(tenantAllowedModelIds(tenant)).toEqual(new Set(["one-model"]));
    expect(tenantAllowedModelIds(tenant)?.has("unlisted")).toBe(false);
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
