import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_GROUP_RATIO } from "../gateway";
import { explainRunUsd, type PricingCatalog, type PricingModel } from "../gateway/account";
import { MEDIA_PRICE_ENTRIES, findMediaListPrice, type MediaPrice } from "../models/media-pricing";
import { holdMicros, settleMicros } from "./estimate";
import {
  ceilingGroupRatio,
  imageCeiling,
  jobCeiling,
  listPriceCeilingMicros,
  secondCeiling,
  tokenCeiling,
  tokenHoldMicros,
  unitHoldMicros,
  type TokenCeiling,
  type UnitCeiling,
} from "./pricing";

function tokenModel(overrides: Partial<PricingModel> = {}): PricingModel {
  return {
    modelName: "m",
    quotaType: 0,
    modelRatio: 1,
    completionRatio: 2,
    modelPrice: 0,
    ...overrides,
  };
}

function catalogOf(models: PricingModel[], groupRatio: Record<string, number> = {}): PricingCatalog {
  return { models, groupRatio };
}

function mediaPrice(overrides: Partial<MediaPrice> = {}): MediaPrice {
  return {
    vendor: "Vendor",
    unit: "image",
    tiers: { default: 0.04 },
    defaultTier: "default",
    source: "https://example.test/pricing",
    checkedAt: "2026-10-15",
    confidence: "high",
    origin: "list",
    ...overrides,
  };
}

function ceilingOf(model: string, catalog: PricingCatalog): TokenCeiling {
  const result = tokenCeiling(model, catalog);
  if (!result.ok) {
    throw new Error(`expected a ceiling, got ${result.code}`);
  }
  return result.ceiling;
}

function unitCeilingOf(result: ReturnType<typeof imageCeiling>): UnitCeiling {
  if (!result.ok) {
    throw new Error(`expected a ceiling, got ${result.code}`);
  }
  return result.ceiling;
}

describe("ceilingGroupRatio", () => {
  it("is the default group ratio when the catalog lists no group", () => {
    expect(ceilingGroupRatio(catalogOf([tokenModel()]))).toBe(DEFAULT_GROUP_RATIO);
  });

  it("is the highest listed group ratio", () => {
    expect(ceilingGroupRatio(catalogOf([tokenModel()], { default: 1, vip: 1.5, cheap: 0.5 }))).toBe(1.5);
  });

  it("never drops below the default, since the ledger prices every call at it", () => {
    expect(ceilingGroupRatio(catalogOf([tokenModel()], { cheap: 0.5 }))).toBe(DEFAULT_GROUP_RATIO);
  });

  it("ignores zero, negative, non-finite and non-numeric entries", () => {
    expect(
      ceilingGroupRatio(catalogOf([tokenModel()], { a: 0, b: -2, c: Number.NaN, d: Number.POSITIVE_INFINITY })),
    ).toBe(DEFAULT_GROUP_RATIO);
  });
});

describe("tokenCeiling", () => {
  it("states input and output at the highest group ratio, in whole micros per million tokens", () => {
    const catalog = catalogOf([tokenModel({ modelRatio: 1, completionRatio: 2 })], { default: 1, vip: 1.5 });
    expect(ceilingOf("m", catalog)).toEqual({
      model: "m",
      groupRatio: 1.5,
      fixedMicros: 0,
      inputMicrosPerMillionTokens: 3_000_000,
      outputMicrosPerMillionTokens: 6_000_000,
    });
  });

  it("holds the input estimate plus the output cap at that ceiling", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel()], { vip: 1.5 }));
    expect(tokenHoldMicros(ceiling, { inputTokens: 1000, outputCap: 500 })).toEqual({ ok: true, micros: 6000 });
  });

  it("matches the settle-side holdMicros at the ceiling group for whole-micro rates", () => {
    const model = tokenModel({ modelRatio: 1.5, completionRatio: 2 });
    const ceiling = ceilingOf("m", catalogOf([model], { default: 1, vip: 2 }));
    for (const [inputTokens, outputCap] of [
      [0, 0],
      [1, 0],
      [7, 13],
      [1000, 500],
      [123_456, 4096],
    ]) {
      expect(tokenHoldMicros(ceiling, { inputTokens, outputCap })).toEqual(
        holdMicros({ inputTokens, outputCap, price: { model, groupRatio: 2 } }),
      );
    }
  });

  it("defaults a zero ratio to one, as explainRunUsd and the ledger do", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel({ modelRatio: 0, completionRatio: 0 })]));
    expect(ceiling.inputMicrosPerMillionTokens).toBe(2_000_000);
    expect(ceiling.outputMicrosPerMillionTokens).toBe(2_000_000);
    expect(tokenHoldMicros(ceiling, { inputTokens: 1000, outputCap: 500 })).toEqual({ ok: true, micros: 3000 });
  });

  it("matches a model id case-insensitively and ignores surrounding spaces", () => {
    const result = tokenCeiling("  M ", catalogOf([tokenModel()]));
    expect(result.ok && result.ceiling.model).toBe("m");
  });

  it("prices a flat per-call model at its fixed charge, whatever the tokens", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel({ quotaType: 1, modelPrice: 0.02 })], { vip: 2 }));
    expect(ceiling.fixedMicros).toBe(40_000);
    expect(ceiling.inputMicrosPerMillionTokens).toBe(0);
    expect(ceiling.outputMicrosPerMillionTokens).toBe(0);
    expect(tokenHoldMicros(ceiling, { inputTokens: 999_999, outputCap: 4096 })).toEqual({ ok: true, micros: 40_000 });
  });

  it("refuses a model the catalog does not list", () => {
    expect(tokenCeiling("unknown", catalogOf([tokenModel()]))).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("refuses a blank or non-string model id", () => {
    const catalog = catalogOf([tokenModel()]);
    expect(tokenCeiling("   ", catalog)).toEqual({ ok: false, code: "model_not_priced" });
    expect(tokenCeiling(undefined as unknown as string, catalog)).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("refuses a tiered-expression model the host cannot evaluate", () => {
    expect(tokenCeiling("m", catalogOf([tokenModel({ billingMode: "tiered_expr" })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a flat model with no price and no ratio", () => {
    expect(tokenCeiling("m", catalogOf([tokenModel({ quotaType: 1, modelPrice: 0, modelRatio: 0 })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a flat model priced at zero, rather than holding nothing", () => {
    expect(tokenCeiling("m", catalogOf([tokenModel({ quotaType: 1, modelPrice: 0, modelRatio: 1 })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a negative flat price", () => {
    expect(tokenCeiling("m", catalogOf([tokenModel({ quotaType: 1, modelPrice: -0.01 })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a non-finite field before any arithmetic", () => {
    const catalog = (patch: Partial<PricingModel>) => catalogOf([tokenModel(patch)]);
    for (const patch of [
      { modelRatio: Number.POSITIVE_INFINITY },
      { completionRatio: Number.NaN },
      { modelPrice: Number.NEGATIVE_INFINITY },
      { quotaType: Number.NaN },
    ]) {
      expect(tokenCeiling("m", catalog(patch))).toEqual({ ok: false, code: "model_not_priced" });
    }
  });

  it("refuses a rate too large to state as a safe integer", () => {
    expect(tokenCeiling("m", catalogOf([tokenModel({ modelRatio: 1e15 })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses when there is no catalog to price against", () => {
    expect(tokenCeiling("m", null)).toEqual({ ok: false, code: "pricing_unavailable" });
  });
});

describe("tokenHoldMicros", () => {
  it("refuses a hold too large to state exactly, rather than rounding it", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel()]));
    expect(tokenHoldMicros(ceiling, { inputTokens: 2 ** 40, outputCap: 0 })).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
  });

  it("throws for a count it cannot honestly estimate", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel()]));
    expect(() => tokenHoldMicros(ceiling, { inputTokens: -1, outputCap: 0 })).toThrow(RangeError);
    expect(() => tokenHoldMicros(ceiling, { inputTokens: 1.5, outputCap: 0 })).toThrow(RangeError);
    expect(() => tokenHoldMicros(ceiling, { inputTokens: 0, outputCap: Number.NaN })).toThrow(RangeError);
  });

  it("rounds the whole hold up to one micro, not each token", () => {
    const ceiling = ceilingOf("m", catalogOf([tokenModel({ modelRatio: 0.075, completionRatio: 1 })]));
    expect(tokenHoldMicros(ceiling, { inputTokens: 1, outputCap: 0 })).toEqual({ ok: true, micros: 1 });
    expect(tokenHoldMicros(ceiling, { inputTokens: 0, outputCap: 0 })).toEqual({ ok: true, micros: 0 });
  });
});

describe("hold at the ceiling is never below the settle of any run it covers", () => {
  const rate = fc.double({ min: 0.001, max: 50, noNaN: true });
  const completion = fc.double({ min: 0.001, max: 10, noNaN: true });
  const tokenShape = fc.record({
    quotaType: fc.constant(0),
    modelRatio: rate,
    completionRatio: completion,
    modelPrice: fc.constant(0),
  });
  const flatShape = fc.record({
    quotaType: fc.constant(1),
    modelRatio: rate,
    completionRatio: completion,
    modelPrice: fc.double({ min: 0.00001, max: 50, noNaN: true }),
  });

  it("holds at least the settle for the ledger's group and for any group up to the ceiling", () => {
    fc.assert(
      fc.property(
        fc.oneof(tokenShape, flatShape),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (shape, inputTokens, outputTokens, listedGroup, fraction) => {
          const model = tokenModel(shape);
          const ceiling = ceilingOf("m", catalogOf([model], { listed: listedGroup }));
          const hold = tokenHoldMicros(ceiling, { inputTokens, outputCap: outputTokens });
          expect(hold.ok).toBe(true);
          if (!hold.ok) {
            return;
          }
          for (const groupRatio of [DEFAULT_GROUP_RATIO, fraction * ceiling.groupRatio]) {
            const settled = explainRunUsd({ model: "m", inputTokens, outputTokens }, catalogOf([model]), groupRatio);
            expect(settled.usd).not.toBeNull();
            if (settled.usd === null) {
              return;
            }
            const settledMicros = settleMicros(settled.usd);
            expect(settledMicros).not.toBeNull();
            expect(settledMicros as number).toBeLessThanOrEqual(hold.micros);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("gives a flat-priced model a ceiling that is never zero", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.00001, max: 50, noNaN: true }),
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        (modelPrice, listedGroup) => {
          const catalog = catalogOf([tokenModel({ quotaType: 1, modelPrice })], { listed: listedGroup });
          const result = tokenCeiling("m", catalog);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.ceiling.fixedMicros).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("listPriceCeilingMicros", () => {
  it("takes the highest published tier for a per-second price", () => {
    const price = mediaPrice({ unit: "second", tiers: { "720p": 0.05, "1080p": 0.1, "4k": 0.3 } });
    expect(listPriceCeilingMicros(price, "second")).toBe(300_000);
  });

  it("states an exact price as exactly its micros, despite float noise", () => {
    expect(listPriceCeilingMicros(mediaPrice({ tiers: { default: 0.04 } }), "image")).toBe(40_000);
  });

  it("rounds a sub-micro price up to a whole micro", () => {
    expect(listPriceCeilingMicros(mediaPrice({ tiers: { default: 0.0000015 } }), "image")).toBe(2);
  });

  it("multiplies an image price by the largest aspect factor", () => {
    const price = mediaPrice({
      aspectMultipliers: {
        square: { factor: 1, exact: true },
        portrait: { factor: 1.5, exact: false },
      },
    });
    expect(listPriceCeilingMicros(price, "image")).toBe(60_000);
  });

  it("ignores an aspect factor below one, which would lower the ceiling", () => {
    const price = mediaPrice({ aspectMultipliers: { square: { factor: 0.5, exact: true } } });
    expect(listPriceCeilingMicros(price, "image")).toBe(40_000);
  });

  it("refuses a price whose unit is not the one asked for", () => {
    expect(listPriceCeilingMicros(mediaPrice({ unit: "second" }), "image")).toBeNull();
  });

  it("refuses a price with no positive published tier", () => {
    expect(listPriceCeilingMicros(mediaPrice({ tiers: {} }), "image")).toBeNull();
    expect(listPriceCeilingMicros(mediaPrice({ tiers: { default: 0 } }), "image")).toBeNull();
    expect(listPriceCeilingMicros(mediaPrice({ tiers: { default: Number.POSITIVE_INFINITY } }), "image")).toBeNull();
  });
});

describe("imageCeiling and secondCeiling", () => {
  const imageRows = MEDIA_PRICE_ENTRIES.filter((entry) => entry.price.unit === "image" && entry.ids.length > 0);
  const secondRows = MEDIA_PRICE_ENTRIES.filter((entry) => entry.price.unit === "second" && entry.ids.length > 0);

  it("gives every image model in the list table a whole positive micro ceiling", () => {
    expect(imageRows.length).toBeGreaterThan(0);
    for (const entry of imageRows) {
      const result = imageCeiling(entry.ids[0]);
      expect(result.ok).toBe(true);
      const ceiling = unitCeilingOf(result);
      expect(ceiling.unit).toBe("images");
      expect(Number.isSafeInteger(ceiling.perUnitMicros)).toBe(true);
      expect(ceiling.perUnitMicros).toBeGreaterThanOrEqual(1);
    }
  });

  it("holds an image run as its count times the ceiling per image", () => {
    const first = unitCeilingOf(imageCeiling(imageRows[0].ids[0]));
    expect(unitHoldMicros(first, 3)).toEqual({ ok: true, micros: first.perUnitMicros * 3 });
  });

  it("refuses an image model it does not list", () => {
    expect(imageCeiling("zz-unlisted-image-model")).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("refuses an image model asked for as a per-second price", () => {
    expect(secondCeiling(imageRows[0].ids[0])).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("gives a per-second model a ceiling that scales with the clip length", () => {
    const row = unitCeilingOf(secondCeiling(secondRows[0].ids[0]));
    expect(row.unit).toBe("seconds");
    expect(unitHoldMicros(row, 10)).toEqual({ ok: true, micros: row.perUnitMicros * 10 });
  });

  it("refuses a model id that the table does not price", () => {
    expect(secondCeiling("   ")).toEqual({ ok: false, code: "model_not_priced" });
  });
});

describe("jobCeiling", () => {
  const gatewayFlat = (overrides: Partial<PricingModel> = {}) =>
    catalogOf([tokenModel({ modelName: "zz-track-model", quotaType: 1, modelPrice: 0.05, ...overrides })], {
      default: 1,
      vip: 1.2,
    });

  it("prices a flat gateway job at its fixed charge times the highest group ratio", () => {
    const ceiling = unitCeilingOf(jobCeiling("zz-track-model", gatewayFlat()));
    expect(ceiling).toEqual({ unit: "jobs", model: "zz-track-model", perUnitMicros: 60_000 });
    expect(unitHoldMicros(ceiling, 2)).toEqual({ ok: true, micros: 120_000 });
  });

  it("refuses a job model the catalog does not price", () => {
    expect(jobCeiling("zz-track-model", catalogOf([]))).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("refuses a job when there is no catalog and no listed price", () => {
    expect(jobCeiling("zz-track-model", null)).toEqual({ ok: false, code: "pricing_unavailable" });
  });

  it("refuses a token-priced model, which is not a flat job", () => {
    expect(jobCeiling("zz-track-model", catalogOf([tokenModel({ modelName: "zz-track-model" })]))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a tiered or zero-priced flat job", () => {
    expect(jobCeiling("zz-track-model", gatewayFlat({ billingMode: "tiered_expr" }))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
    expect(jobCeiling("zz-track-model", gatewayFlat({ modelPrice: 0, modelRatio: 1 }))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
    expect(jobCeiling("zz-track-model", gatewayFlat({ modelPrice: Number.POSITIVE_INFINITY }))).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a listed price whose unit is not a track", () => {
    const imageId = MEDIA_PRICE_ENTRIES.find((entry) => entry.price.unit === "image" && entry.ids.length > 0)?.ids[0];
    expect(imageId && findMediaListPrice(imageId)?.unit).toBe("image");
    expect(imageId && jobCeiling(imageId, gatewayFlat())).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("never gives a flat job a ceiling of zero", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.00001, max: 50, noNaN: true }),
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        (modelPrice, listedGroup) => {
          const result = jobCeiling(
            "zz-track-model",
            catalogOf([tokenModel({ modelName: "zz-track-model", quotaType: 1, modelPrice })], { listed: listedGroup }),
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.ceiling.perUnitMicros).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("unitHoldMicros", () => {
  const ceiling: UnitCeiling = { unit: "jobs", model: "m", perUnitMicros: 40_000 };

  it("multiplies the ceiling by the whole number of units", () => {
    expect(unitHoldMicros(ceiling, 3)).toEqual({ ok: true, micros: 120_000 });
  });

  it("charges a fractional unit as a whole one, which is the safe direction", () => {
    expect(unitHoldMicros(ceiling, 2.2)).toEqual({ ok: true, micros: 120_000 });
  });

  it("throws for a quantity below one unit or not finite", () => {
    expect(() => unitHoldMicros(ceiling, 0)).toThrow(RangeError);
    expect(() => unitHoldMicros(ceiling, Number.NaN)).toThrow(RangeError);
  });

  it("refuses a hold too large to state exactly", () => {
    expect(unitHoldMicros({ unit: "seconds", model: "m", perUnitMicros: 2 ** 40 }, 2 ** 20)).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
  });
});

describe("determinism and catalog discipline", () => {
  it("returns the same ceiling for the same input, and does not change the catalog it is given", () => {
    const catalog = catalogOf([tokenModel({ modelRatio: 2 })], { vip: 1.5 });
    const snapshot = JSON.stringify(catalog);
    const first = tokenCeiling("m", catalog);
    const second = tokenCeiling("m", catalog);
    expect(second).toEqual(first);
    expect(JSON.stringify(catalog)).toBe(snapshot);
  });

  it("agrees with the settle-side price when the catalog lists no group, the ledger's case", () => {
    const model = tokenModel({ modelRatio: 0.5, completionRatio: 3 });
    const ceiling = ceilingOf("m", catalogOf([model]));
    const settled = explainRunUsd({ model: "m", inputTokens: 4000, outputTokens: 1000 }, catalogOf([model]));
    expect(settled.usd).not.toBeNull();
    expect(tokenHoldMicros(ceiling, { inputTokens: 4000, outputCap: 1000 })).toEqual({
      ok: true,
      micros: settleMicros(settled.usd as number),
    });
  });
});
