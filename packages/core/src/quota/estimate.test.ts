import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { explainRunUsd, type PricingCatalog, type PricingModel } from "../gateway/account";
import {
  IMAGE_TOKEN_ALLOWANCE,
  MAX_HOLD_FRACTION,
  MIN_OUTPUT_TOKENS,
  estimateInputTokens,
  holdMicros,
  outputCapFor,
  priceMicros,
  settleMicros,
} from "./estimate";

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

describe("estimateInputTokens", () => {
  it("counts half the body bytes plus the image allowance per inline image", () => {
    expect(IMAGE_TOKEN_ALLOWANCE).toBe(1600);
    expect(estimateInputTokens(0, 0)).toBe(0);
    expect(estimateInputTokens(4, 0)).toBe(2);
    expect(estimateInputTokens(5, 0)).toBe(3);
    expect(estimateInputTokens(1000, 2)).toBe(3700);
  });

  it("refuses a count it cannot honestly estimate", () => {
    expect(() => estimateInputTokens(-1, 0)).toThrow(RangeError);
    expect(() => estimateInputTokens(1.5, 0)).toThrow(RangeError);
    expect(() => estimateInputTokens(Number.NaN, 0)).toThrow(RangeError);
    expect(() => estimateInputTokens(0, -1)).toThrow(RangeError);
  });
});

describe("holdMicros on a token-priced model", () => {
  it("prices input at the model ratio and output at the completion ratio, in micros", () => {
    const held = holdMicros({ inputTokens: 1000, outputCap: 500, price: { model: tokenModel(), groupRatio: 1 } });
    expect(held).toEqual({ ok: true, micros: 4000 });
  });

  it("scales by the group ratio", () => {
    const held = holdMicros({ inputTokens: 1000, outputCap: 500, price: { model: tokenModel(), groupRatio: 1.5 } });
    expect(held).toEqual({ ok: true, micros: 6000 });
  });

  it("defaults a zero ratio to one, as explainRunUsd does", () => {
    const held = holdMicros({
      inputTokens: 1000,
      outputCap: 500,
      price: { model: tokenModel({ modelRatio: 0, completionRatio: 0 }), groupRatio: 1 },
    });
    expect(held).toEqual({ ok: true, micros: 3000 });
  });

  it("falls back to the default group ratio for a zero, negative or non-finite group", () => {
    const expected = { ok: true, micros: 4000 };
    for (const groupRatio of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(holdMicros({ inputTokens: 1000, outputCap: 500, price: { model: tokenModel(), groupRatio } })).toEqual(
        expected,
      );
    }
  });

  it("rounds the total up to a whole micro once, not each token", () => {
    const model = tokenModel({ modelRatio: 0.075, completionRatio: 1 });
    expect(holdMicros({ inputTokens: 1, outputCap: 0, price: { model, groupRatio: 1 } })).toEqual({
      ok: true,
      micros: 1,
    });
    expect(holdMicros({ inputTokens: 0, outputCap: 0, price: { model, groupRatio: 1 } })).toEqual({
      ok: true,
      micros: 0,
    });
  });
});

describe("holdMicros on a flat-priced model and unpriced models", () => {
  it("charges a flat per-call price regardless of tokens", () => {
    const model = tokenModel({ quotaType: 1, modelPrice: 0.02 });
    expect(holdMicros({ inputTokens: 999_999, outputCap: 4096, price: { model, groupRatio: 1.5 } })).toEqual({
      ok: true,
      micros: 30000,
    });
  });

  it("refuses a tiered-expression model", () => {
    const model = tokenModel({ billingMode: "tiered_expr" });
    expect(holdMicros({ inputTokens: 1, outputCap: 1, price: { model, groupRatio: 1 } })).toEqual({
      ok: false,
      code: "model_not_priced",
    });
  });

  it("refuses a flat model with no price and no ratio, the way isUnpricedBilling does", () => {
    const model = tokenModel({ quotaType: 1, modelPrice: 0, modelRatio: 0 });
    expect(priceMicros({ model, groupRatio: 1 })).toEqual({ ok: false, code: "model_not_priced" });
  });

  it("refuses a non-finite field before doing any arithmetic", () => {
    for (const patch of [
      { modelRatio: Number.POSITIVE_INFINITY },
      { completionRatio: Number.NaN },
      { modelPrice: Number.NEGATIVE_INFINITY },
      { quotaType: Number.NaN },
    ]) {
      expect(priceMicros({ model: tokenModel(patch), groupRatio: 1 })).toEqual({ ok: false, code: "model_not_priced" });
    }
  });

  it("refuses a negative flat price", () => {
    const model = tokenModel({ quotaType: 1, modelPrice: -0.01, modelRatio: 1 });
    expect(priceMicros({ model, groupRatio: 1 })).toEqual({ ok: false, code: "model_not_priced" });
  });
});

describe("holdMicros against the settle price", () => {
  it("holds exactly what explainRunUsd settles for the same tokens, token-priced or flat-priced", () => {
    const rate = fc.double({ min: 0.001, max: 200, noNaN: true });
    const completion = fc.double({ min: 0.001, max: 50, noNaN: true });
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
    fc.assert(
      fc.property(
        fc.oneof(tokenShape, flatShape),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (shape, inputTokens, outputTokens, groupRatio) => {
          const model = tokenModel(shape);
          const catalog: PricingCatalog = { models: [model], groupRatio: {} };
          const settled = explainRunUsd({ model: "m", inputTokens, outputTokens }, catalog, groupRatio);
          const held = holdMicros({ inputTokens, outputCap: outputTokens, price: { model, groupRatio } });
          expect(settled.usd).not.toBeNull();
          expect(held.ok).toBe(true);
          if (settled.usd === null || !held.ok) {
            return;
          }
          const settledMicros = settleMicros(settled.usd) as number;
          expect(held.micros).toBeGreaterThanOrEqual(settledMicros);
          expect(held.micros).toBe(settledMicros);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("outputCapFor", () => {
  it("caps at the ceiling when the room is larger", () => {
    expect(
      outputCapFor({ headroomMicros: 1_000_000, inputCostMicros: 0, outputPricePerTokenMicros: 2, ceiling: 4096 }),
    ).toEqual({ ok: true, cap: 4096 });
    expect(
      outputCapFor({
        headroomMicros: 1_000_000,
        inputCostMicros: 400_000,
        outputPricePerTokenMicros: 2,
        ceiling: 4096,
      }),
    ).toEqual({ ok: true, cap: 4096 });
  });

  it("caps at what the room affords, after the input cost, with one micro kept as float margin", () => {
    expect(
      outputCapFor({ headroomMicros: 4_000, inputCostMicros: 1_000, outputPricePerTokenMicros: 2, ceiling: 4096 }),
    ).toEqual({ ok: true, cap: 499 });
  });

  it("keeps one hold to half the headroom, so a single call cannot spend the whole allowance", () => {
    expect(MAX_HOLD_FRACTION).toBe(0.5);
    expect(
      outputCapFor({ headroomMicros: 1_000_000, inputCostMicros: 0, outputPricePerTokenMicros: 2, ceiling: 1_000_000 }),
    ).toEqual({ ok: true, cap: 249_999 });
  });

  it("refuses when the input alone reaches half the headroom", () => {
    expect(
      outputCapFor({
        headroomMicros: 1_000_000,
        inputCostMicros: 500_000,
        outputPricePerTokenMicros: 2,
        ceiling: 4096,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      outputCapFor({
        headroomMicros: 1_000_000,
        inputCostMicros: 500_001,
        outputPricePerTokenMicros: 2,
        ceiling: 4096,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      outputCapFor({
        headroomMicros: 1_000_000,
        inputCostMicros: 900_000,
        outputPricePerTokenMicros: 0,
        ceiling: 4096,
      }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("refuses when the room affords fewer than the minimum output tokens", () => {
    expect(MIN_OUTPUT_TOKENS).toBe(256);
    expect(
      outputCapFor({ headroomMicros: 1_000, inputCostMicros: 0, outputPricePerTokenMicros: 4, ceiling: 4096 }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      outputCapFor({ headroomMicros: 1_000, inputCostMicros: 0, outputPricePerTokenMicros: 4, ceiling: 255 }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("refuses when the input alone is over the headroom", () => {
    expect(
      outputCapFor({ headroomMicros: 1_000, inputCostMicros: 1_001, outputPricePerTokenMicros: 2, ceiling: 4096 }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("does not divide by a zero output price; a free output takes the ceiling", () => {
    expect(outputCapFor({ headroomMicros: 0, inputCostMicros: 0, outputPricePerTokenMicros: 0, ceiling: 100 })).toEqual(
      { ok: true, cap: 100 },
    );
  });

  it("does not refuse a model whose ceiling is under the minimum when the room is ample", () => {
    expect(
      outputCapFor({ headroomMicros: 1_000_000, inputCostMicros: 0, outputPricePerTokenMicros: 2, ceiling: 100 }),
    ).toEqual({ ok: true, cap: 100 });
  });

  it("refuses non-finite or negative figures rather than guessing", () => {
    expect(
      outputCapFor({ headroomMicros: Number.NaN, inputCostMicros: 0, outputPricePerTokenMicros: 2, ceiling: 4096 }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
    expect(
      outputCapFor({ headroomMicros: 1_000_000, inputCostMicros: 0, outputPricePerTokenMicros: -1, ceiling: 4096 }),
    ).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("keeps the cap and the hold inside the headroom at a fractional price", () => {
    const model = tokenModel({ modelRatio: 0.075, completionRatio: 1 });
    const price = { model, groupRatio: 1 };
    const inputCost = holdMicros({ inputTokens: 0, outputCap: 0, price });
    const priced = priceMicros(price);
    expect(inputCost).toEqual({ ok: true, micros: 0 });
    expect(priced.ok).toBe(true);
    if (!priced.ok) {
      return;
    }
    const result = outputCapFor({
      headroomMicros: 3_000,
      inputCostMicros: 0,
      outputPricePerTokenMicros: priced.price.outputPerTokenMicros,
      ceiling: 10_000,
    });
    expect(result).toEqual({ ok: true, cap: 9993 });
    expect(holdMicros({ inputTokens: 0, outputCap: 9993, price })).toEqual({ ok: true, micros: 1499 });
  });

  it("throws for an invalid ceiling, which is a configuration error", () => {
    expect(() =>
      outputCapFor({ headroomMicros: 1_000, inputCostMicros: 0, outputPricePerTokenMicros: 2, ceiling: 0 }),
    ).toThrow(RangeError);
  });

  it("never returns a cap that holds more than the headroom", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.double({ min: 0.001, max: 200, noNaN: true }),
        fc.double({ min: 0.001, max: 50, noNaN: true }),
        fc.integer({ min: 1, max: 200_000 }),
        (headroomMicros, inputTokens, modelRatio, completionRatio, ceiling) => {
          const price = { model: tokenModel({ modelRatio, completionRatio }), groupRatio: 1 };
          const inputCost = holdMicros({ inputTokens, outputCap: 0, price });
          const priced = priceMicros(price);
          expect(inputCost.ok && priced.ok).toBe(true);
          if (!inputCost.ok || !priced.ok) {
            return;
          }
          const result = outputCapFor({
            headroomMicros,
            inputCostMicros: inputCost.micros,
            outputPricePerTokenMicros: priced.price.outputPerTokenMicros,
            ceiling,
          });
          if (!result.ok) {
            expect(result.code).toBe("quota_exceeded");
            return;
          }
          expect(result.cap).toBeLessThanOrEqual(ceiling);
          expect(result.cap).toBeGreaterThanOrEqual(Math.min(ceiling, MIN_OUTPUT_TOKENS));
          const hold = holdMicros({ inputTokens, outputCap: result.cap, price });
          expect(hold.ok).toBe(true);
          if (hold.ok) {
            expect(hold.micros).toBeLessThanOrEqual(headroomMicros);
            expect(hold.micros).toBeLessThanOrEqual(Math.floor(headroomMicros * MAX_HOLD_FRACTION));
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("settleMicros", () => {
  it("rounds a positive cost up to a whole micro, with a minimum of one", () => {
    expect(settleMicros(0)).toBe(0);
    expect(settleMicros(0.000000001)).toBe(1);
    expect(settleMicros(0.0000001)).toBe(1);
    expect(settleMicros(0.0000015)).toBe(2);
    expect(settleMicros(0.0000025)).toBe(3);
  });

  it("is exact for a price that is a whole number of micros, despite float noise", () => {
    expect(settleMicros(0.004)).toBe(4000);
    expect(settleMicros(0.1 + 0.2)).toBe(300_000);
  });

  it("refuses a cost it cannot honestly state", () => {
    expect(settleMicros(-0.01)).toBeNull();
    expect(settleMicros(Number.NaN)).toBeNull();
    expect(settleMicros(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
