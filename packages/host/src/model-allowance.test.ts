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
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-model-allowance-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

import type { TenantContext } from "@agentforge/core";
import {
  allowanceFor,
  clearTenantModelAllowlist,
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
