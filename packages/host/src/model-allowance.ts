import {
  DEFAULT_GROUP_RATIO,
  explainRunUsd,
  resolvedGatewayBaseUrl,
  type PricingCatalog,
} from "@agentforge/core";
import { cachedPricingCatalog } from "./account-usage";
import { modelCacheScopeOf } from "./model-cache";
import { listSelectableModels, type SelectableModel } from "./selectable-models";
import { loadSettings, type SettingsScope } from "./settings-store";

export type PriceBand = 1 | 2 | 3;

export const PRICE_BAND_1_MAX_USD_PER_MILLION_INPUT = 1;
export const PRICE_BAND_2_MAX_USD_PER_MILLION_INPUT = 5;

export type PriceInfo = Readonly<{
  band: PriceBand;
  usdPerMillionInput: number;
  usdPerMillionOutput: number;
}>;

export type ModelAllowance = Readonly<{
  allows(model: SelectableModel, price: PriceInfo | null): boolean;
}>;

const PER_CALL_QUOTA_TYPE = 1;
const MILLION_TOKENS = 1_000_000;

function bandForUsdPerMillionInput(usd: number): PriceBand {
  if (usd <= PRICE_BAND_1_MAX_USD_PER_MILLION_INPUT) {
    return 1;
  }
  if (usd <= PRICE_BAND_2_MAX_USD_PER_MILLION_INPUT) {
    return 2;
  }
  return 3;
}

export function priceInfoFromCatalog(catalog: PricingCatalog | null, modelId: string): PriceInfo | null {
  if (!catalog) {
    return null;
  }
  const needle = modelId.trim().toLowerCase();
  const row = catalog.models.find((item) => item.modelName.trim().toLowerCase() === needle);
  if (!row || row.quotaType === PER_CALL_QUOTA_TYPE || !(row.modelRatio > 0)) {
    return null;
  }
  const input = explainRunUsd(
    { model: row.modelName, inputTokens: MILLION_TOKENS, outputTokens: 0 },
    catalog,
    DEFAULT_GROUP_RATIO,
  );
  const output = explainRunUsd(
    { model: row.modelName, inputTokens: 0, outputTokens: MILLION_TOKENS },
    catalog,
    DEFAULT_GROUP_RATIO,
  );
  if (input.usd === null || output.usd === null) {
    return null;
  }
  return {
    band: bandForUsdPerMillionInput(input.usd),
    usdPerMillionInput: input.usd,
    usdPerMillionOutput: output.usd,
  };
}

export function priceBandFor(modelId: string): PriceBand | null {
  return priceInfoFromCatalog(cachedPricingCatalog(resolvedGatewayBaseUrl()), modelId)?.band ?? null;
}

/**
 * The tenant's model allowlist as the portal last reported it, kept in process memory only
 * (no host migration). `recordTenantModelAllowlist` writes it at sign-in and at every refresh
 * from the token body's `model_allowlist`; a `null` write means an older portal that does not
 * send the field yet, which leaves the entry untouched. An empty array is a real record: the
 * tenant allows every model.
 */
const PORTAL_MODEL_ALLOWLISTS = new Map<string, readonly string[]>();

export function recordTenantModelAllowlist(
  tenantId: string,
  allowlist: readonly string[] | null | undefined,
): void {
  if (allowlist === null || allowlist === undefined) {
    return;
  }
  PORTAL_MODEL_ALLOWLISTS.set(
    tenantId,
    allowlist.map((model) => model.trim()).filter((model) => model.length > 0),
  );
}

/** Test hook: drops the in-memory record without touching a desk's stored setting. */
export function clearTenantModelAllowlist(tenantId: string): void {
  PORTAL_MODEL_ALLOWLISTS.delete(tenantId);
}

/**
 * The allowlist that governs a tenant: the portal's record when there is one, and the desk's own
 * `modelAllowlist` setting when there is not (no portal). `null` means nothing is configured,
 * which is the same allow-everything answer as an empty list.
 */
export function tenantModelAllowlist(scope: SettingsScope): readonly string[] | null {
  const portalList = scope && typeof scope === "object" ? PORTAL_MODEL_ALLOWLISTS.get(scope.tenantId) : undefined;
  if (portalList !== undefined) {
    return portalList;
  }
  return loadSettings(scope).modelAllowlist ?? null;
}

/** The allowlist as the lowercased id set `listCatalogModels` filters by, or `null` to allow all. */
export function tenantAllowedModelIds(scope: SettingsScope): ReadonlySet<string> | null {
  const allowlist = tenantModelAllowlist(scope);
  if (!allowlist || allowlist.length === 0) {
    return null;
  }
  return new Set(allowlist.map((model) => model.trim().toLowerCase()));
}

export function allowanceFor(scope: SettingsScope): ModelAllowance {
  const allowlist = tenantModelAllowlist(scope);
  if (!allowlist || allowlist.length === 0) {
    return { allows: () => true };
  }
  const allowed = new Set(allowlist.map((model) => model.trim().toLowerCase()));
  return {
    allows: (model) => allowed.has(model.id.trim().toLowerCase()),
  };
}

export function catalogFor(scope: SettingsScope, allowance: ModelAllowance): SelectableModel[] {
  const pricing = cachedPricingCatalog(resolvedGatewayBaseUrl());
  return listSelectableModels(modelCacheScopeOf(scope)).filter((model) =>
    allowance.allows(model, priceInfoFromCatalog(pricing, model.id)),
  );
}
