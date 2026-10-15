import { DEFAULT_GROUP_RATIO } from "../gateway";
import { isUnpricedBilling, type PricingCatalog, type PricingModel } from "../gateway/account";
import { findMediaListPrice, type MediaPrice, type MediaPriceUnit } from "../models/media-pricing";
import { USD_MICROS } from "../usage/metering";
import { priceMicros } from "./estimate";

const MILLION = 1_000_000;

export type CeilingRefusal = { ok: false; code: "model_not_priced" | "pricing_unavailable" };

export type CeilingResult<T> = { ok: true; ceiling: T } | CeilingRefusal;

export type HoldResult = { ok: true; micros: number } | { ok: false; code: "quota_exceeded" };

export type TokenCeiling = {
  model: string;
  groupRatio: number;
  fixedMicros: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
};

export type UnitCeiling = {
  unit: "images" | "seconds" | "jobs";
  model: string;
  perUnitMicros: number;
};

function unpriced(): CeilingRefusal {
  return { ok: false, code: "model_not_priced" };
}

function refusedForSize(): HoldResult {
  return { ok: false, code: "quota_exceeded" };
}

function assertCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function wholeMicros(micros: number): number {
  return Math.ceil(Number(micros.toPrecision(12)));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalisedId(model: unknown): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const id = model.trim();
  return id.length > 0 ? id : null;
}

function findPricingModel(catalog: PricingCatalog, id: string): PricingModel | undefined {
  const needle = id.toLowerCase();
  return catalog.models.find((item) => item.modelName.toLowerCase() === needle);
}

export function ceilingGroupRatio(catalog: PricingCatalog): number {
  return Object.values(catalog.groupRatio).reduce<number>(
    (highest, ratio) => (isPositiveFinite(ratio) && ratio > highest ? ratio : highest),
    DEFAULT_GROUP_RATIO,
  );
}

export function tokenCeiling(model: string, catalog: PricingCatalog | null): CeilingResult<TokenCeiling> {
  if (!catalog) {
    return { ok: false, code: "pricing_unavailable" };
  }
  const id = normalisedId(model);
  const entry = id === null ? undefined : findPricingModel(catalog, id);
  if (!entry || isUnpricedBilling(entry)) {
    return unpriced();
  }
  const groupRatio = ceilingGroupRatio(catalog);
  const priced = priceMicros({ model: entry, groupRatio });
  if (!priced.ok) {
    return unpriced();
  }
  const fixedMicros = wholeMicros(priced.price.fixedMicros);
  const inputMicrosPerMillionTokens = wholeMicros(priced.price.inputPerTokenMicros * MILLION);
  const outputMicrosPerMillionTokens = wholeMicros(priced.price.outputPerTokenMicros * MILLION);
  const charged =
    entry.quotaType === 1 ? fixedMicros > 0 : inputMicrosPerMillionTokens > 0 && outputMicrosPerMillionTokens > 0;
  const representable = [fixedMicros, inputMicrosPerMillionTokens, outputMicrosPerMillionTokens].every(
    Number.isSafeInteger,
  );
  if (!charged || !representable) {
    return unpriced();
  }
  return {
    ok: true,
    ceiling: {
      model: entry.modelName,
      groupRatio,
      fixedMicros,
      inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens,
    },
  };
}

function roundedHold(fixedMicros: number, millionths: number): HoldResult {
  if (!Number.isSafeInteger(millionths)) {
    return refusedForSize();
  }
  const remainder = millionths % MILLION;
  const micros = fixedMicros + (millionths - remainder) / MILLION + (remainder > 0 ? 1 : 0);
  return Number.isSafeInteger(micros) ? { ok: true, micros } : refusedForSize();
}

export function tokenHoldMicros(ceiling: TokenCeiling, call: { inputTokens: number; outputCap: number }): HoldResult {
  assertCount(call.inputTokens, "inputTokens");
  assertCount(call.outputCap, "outputCap");
  const millionths =
    call.inputTokens * ceiling.inputMicrosPerMillionTokens + call.outputCap * ceiling.outputMicrosPerMillionTokens;
  return roundedHold(ceiling.fixedMicros, millionths);
}

export function listPriceCeilingMicros(price: MediaPrice, unit: MediaPriceUnit): number | null {
  if (price.unit !== unit) {
    return null;
  }
  const tiers = Object.values(price.tiers).filter(isPositiveFinite);
  if (tiers.length === 0) {
    return null;
  }
  const aspectFactors = Object.values(price.aspectMultipliers ?? {})
    .map((multiplier) => multiplier?.factor)
    .filter(isPositiveFinite);
  const factor = unit === "image" ? Math.max(1, ...aspectFactors) : 1;
  return wholeMicros(Math.max(...tiers) * factor * USD_MICROS);
}

function ceilingOrRefuse(
  unit: UnitCeiling["unit"],
  model: string,
  perUnitMicros: number | null,
): CeilingResult<UnitCeiling> {
  if (perUnitMicros === null || !Number.isSafeInteger(perUnitMicros) || perUnitMicros < 1) {
    return unpriced();
  }
  return { ok: true, ceiling: { unit, model, perUnitMicros } };
}

function listedCeiling(
  model: string,
  priceUnit: MediaPriceUnit,
  unit: UnitCeiling["unit"],
): CeilingResult<UnitCeiling> {
  const id = normalisedId(model);
  if (id === null) {
    return unpriced();
  }
  const price = findMediaListPrice(id);
  return ceilingOrRefuse(unit, id, price ? listPriceCeilingMicros(price, priceUnit) : null);
}

export function imageCeiling(model: string): CeilingResult<UnitCeiling> {
  return listedCeiling(model, "image", "images");
}

export function secondCeiling(model: string): CeilingResult<UnitCeiling> {
  return listedCeiling(model, "second", "seconds");
}

export function jobCeiling(model: string, catalog: PricingCatalog | null): CeilingResult<UnitCeiling> {
  const id = normalisedId(model);
  if (id === null) {
    return unpriced();
  }
  const listed = findMediaListPrice(id);
  if (listed) {
    return ceilingOrRefuse("jobs", id, listPriceCeilingMicros(listed, "track"));
  }
  if (!catalog) {
    return { ok: false, code: "pricing_unavailable" };
  }
  const entry = findPricingModel(catalog, id);
  if (entry?.quotaType !== 1 || isUnpricedBilling(entry) || !isPositiveFinite(entry.modelPrice)) {
    return unpriced();
  }
  return ceilingOrRefuse("jobs", id, wholeMicros(entry.modelPrice * ceilingGroupRatio(catalog) * USD_MICROS));
}

export function unitHoldMicros(ceiling: UnitCeiling, quantity: number): HoldResult {
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new RangeError(`quantity must be at least one unit, got ${quantity}`);
  }
  const micros = Math.ceil(quantity) * ceiling.perUnitMicros;
  return Number.isSafeInteger(micros) ? { ok: true, micros } : refusedForSize();
}
