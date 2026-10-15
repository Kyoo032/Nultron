import { DEFAULT_GROUP_RATIO, QUOTA_PER_USD, quotaToUsd } from "../gateway";
import { isUnpricedBilling, type PricingModel } from "../gateway/account";
import { USD_MICROS } from "../usage/metering";

export const IMAGE_TOKEN_ALLOWANCE = 1600;

export const MIN_OUTPUT_TOKENS = 256;

export const MAX_HOLD_FRACTION = 0.5;

const ROUNDING_MARGIN_MICROS = 1;

export type HoldPrice = {
  model: PricingModel;
  groupRatio: number;
};

export type TokenPriceMicros = {
  fixedMicros: number;
  inputPerTokenMicros: number;
  outputPerTokenMicros: number;
};

export type PriceMicrosResult = { ok: true; price: TokenPriceMicros } | { ok: false; code: "model_not_priced" };

export type HoldMicrosResult = { ok: true; micros: number } | { ok: false; code: "model_not_priced" };

export type OutputCapResult = { ok: true; cap: number } | { ok: false; code: "quota_exceeded" };

const UNPRICED: { ok: false; code: "model_not_priced" } = { ok: false, code: "model_not_priced" };

const REFUSED: { ok: false; code: "quota_exceeded" } = { ok: false, code: "quota_exceeded" };

function assertCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function ceilMicros(micros: number): number {
  return Math.ceil(Number(micros.toPrecision(12)));
}

export function settleMicros(usd: number): number | null {
  if (!Number.isFinite(usd) || usd < 0) {
    return null;
  }
  if (usd === 0) {
    return 0;
  }
  return Math.max(1, ceilMicros(usd * USD_MICROS));
}

export function estimateInputTokens(bodyBytes: number, inlineImages: number): number {
  assertCount(bodyBytes, "bodyBytes");
  assertCount(inlineImages, "inlineImages");
  return Math.ceil(bodyBytes / 2) + inlineImages * IMAGE_TOKEN_ALLOWANCE;
}

type UsdResult = { ok: true; usd: number } | { ok: false; code: "model_not_priced" };

function resolvedGroup(groupRatio: number): number {
  return Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : DEFAULT_GROUP_RATIO;
}

function usageUsd(price: HoldPrice, inputTokens: number, outputTokens: number): UsdResult {
  const { model, groupRatio } = price;
  if (![model.quotaType, model.modelRatio, model.completionRatio, model.modelPrice].every(Number.isFinite)) {
    return UNPRICED;
  }
  if (isUnpricedBilling(model)) {
    return UNPRICED;
  }
  const group = resolvedGroup(groupRatio);
  if (model.quotaType === 1) {
    if (model.modelPrice < 0) {
      return UNPRICED;
    }
    return { ok: true, usd: model.modelPrice * group };
  }
  const ratio = model.modelRatio > 0 ? model.modelRatio : 1;
  const completion = model.completionRatio > 0 ? model.completionRatio : 1;
  return { ok: true, usd: quotaToUsd((inputTokens + outputTokens * completion) * ratio * group) };
}

export function priceMicros(price: HoldPrice): PriceMicrosResult {
  const probe = usageUsd(price, 0, 0);
  if (!probe.ok) {
    return probe;
  }
  const { model, groupRatio } = price;
  if (model.quotaType === 1) {
    return {
      ok: true,
      price: {
        fixedMicros: probe.usd * USD_MICROS,
        inputPerTokenMicros: 0,
        outputPerTokenMicros: 0,
      },
    };
  }
  const ratio = model.modelRatio > 0 ? model.modelRatio : 1;
  const completion = model.completionRatio > 0 ? model.completionRatio : 1;
  const group = resolvedGroup(groupRatio);
  const microsPerQuota = USD_MICROS / QUOTA_PER_USD;
  return {
    ok: true,
    price: {
      fixedMicros: 0,
      inputPerTokenMicros: ratio * group * microsPerQuota,
      outputPerTokenMicros: completion * ratio * group * microsPerQuota,
    },
  };
}

export function holdMicros({
  inputTokens,
  outputCap,
  price,
}: {
  inputTokens: number;
  outputCap: number;
  price: HoldPrice;
}): HoldMicrosResult {
  assertCount(inputTokens, "inputTokens");
  assertCount(outputCap, "outputCap");
  const priced = usageUsd(price, inputTokens, outputCap);
  if (!priced.ok) {
    return priced;
  }
  return { ok: true, micros: ceilMicros(priced.usd * USD_MICROS) };
}

export function outputCapFor(input: {
  headroomMicros: number;
  inputCostMicros: number;
  outputPricePerTokenMicros: number;
  ceiling: number;
}): OutputCapResult {
  const { headroomMicros, inputCostMicros, outputPricePerTokenMicros, ceiling } = input;
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new RangeError(`output ceiling must be a positive integer, got ${ceiling}`);
  }
  if (![headroomMicros, inputCostMicros, outputPricePerTokenMicros].every(Number.isFinite)) {
    return REFUSED;
  }
  if (outputPricePerTokenMicros < 0) {
    return REFUSED;
  }
  const holdLimit = Math.floor(headroomMicros * MAX_HOLD_FRACTION);
  const room = holdLimit - inputCostMicros;
  if (room < 0) {
    return REFUSED;
  }
  if (outputPricePerTokenMicros === 0) {
    return { ok: true, cap: ceiling };
  }
  const affordable = Math.floor((room - ROUNDING_MARGIN_MICROS) / outputPricePerTokenMicros);
  if (affordable < MIN_OUTPUT_TOKENS) {
    return REFUSED;
  }
  return { ok: true, cap: Math.min(ceiling, affordable) };
}
