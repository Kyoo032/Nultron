import {
  DEFAULT_GROUP_RATIO,
  explainRunUsd,
  resolvedGatewayBaseUrl,
  type PricingCatalog,
  type TenantContext,
} from "@agentforge/core";
import { cachedPricingCatalog } from "./account-usage";
import { listSelectableModels, type SelectableModel } from "./selectable-models";

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

export function allowanceFor(_tenant: TenantContext): ModelAllowance {
  return { allows: () => true };
}

export function catalogFor(tenant: TenantContext, allowance: ModelAllowance): SelectableModel[] {
  const pricing = cachedPricingCatalog(resolvedGatewayBaseUrl());
  return listSelectableModels(tenant).filter((model) =>
    allowance.allows(model, priceInfoFromCatalog(pricing, model.id)),
  );
}
