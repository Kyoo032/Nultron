import { describe, expect, it } from "vitest";
import { KAFE_ITEMS, KAFE_OPENING_CASH } from "./__fixtures__/books";
import { cashflowBreakeven } from "./breakeven";
import { cashflowInputSchema, computeCashflow } from "./compute";
import { cashflowAllowedNumbers, cashflowDirectionClaims, cashflowPromptFacts } from "./facts";
import { walkPeriods, periodInputsFromItems } from "./periods";
import type { DirectionClaim } from "../claim-direction";

const input = cashflowInputSchema.parse({ items: KAFE_ITEMS, params: { openingCash: KAFE_OPENING_CASH } });
const computed = computeCashflow(input);

function marginClaims(claims: readonly DirectionClaim[], phrase: "above breakeven" | "below breakeven") {
  return claims.filter((claim) => claim.agree.some((word) => word.en === phrase));
}

describe("margin of safety", () => {
  it("is computed from the same periods the breakeven module reads", () => {
    const independent = cashflowBreakeven(walkPeriods(periodInputsFromItems(KAFE_ITEMS), KAFE_OPENING_CASH));
    expect(computed.breakeven.marginOfSafety).not.toBeNull();
    expect(computed.breakeven.marginOfSafety).toBeCloseTo(independent.marginOfSafety as number, 4);
    expect(computed.breakeven.marginOfSafetyPct).toBeCloseTo(independent.marginOfSafetyPct as number, 9);
  });

  it("prints both figures in the fact sheet, in both languages", () => {
    for (const locale of ["en", "id"] as const) {
      const facts = cashflowPromptFacts(computed, locale);
      expect(facts).toContain("- marginOfSafety.perPeriod |");
      expect(facts).toContain("- marginOfSafetyPct |");
    }
  });

  it("allows both figures back to the guard", () => {
    const allowed = cashflowAllowedNumbers(input, computed);
    for (const value of [computed.breakeven.marginOfSafety, computed.breakeven.marginOfSafetyPct]) {
      expect(allowed.some((number) => Math.abs(number - (value as number)) < 1e-6)).toBe(true);
    }
  });

  it("claims above breakeven when the margin is positive, and below when it is negative", () => {
    const above = marginClaims(cashflowDirectionClaims(computed), "above breakeven");
    expect(above.map((claim) => claim.amount)).toEqual([
      computed.breakeven.marginOfSafety,
      computed.breakeven.marginOfSafetyPct,
    ]);
    const below = cashflowDirectionClaims({
      ...computed,
      breakeven: { ...computed.breakeven, marginOfSafety: -1, marginOfSafetyPct: -1 },
    });
    const belowClaims = marginClaims(below, "below breakeven");
    expect(belowClaims.map((claim) => claim.amount)).toEqual([-1, -1]);
    expect(belowClaims[0]?.contradict.some((word) => word.en === "above breakeven")).toBe(true);
  });

  it("makes no claim when the margin is not computable", () => {
    const none = cashflowDirectionClaims({
      ...computed,
      breakeven: { ...computed.breakeven, marginOfSafety: null, marginOfSafetyPct: null },
    });
    expect(marginClaims(none, "above breakeven")).toEqual([]);
    expect(marginClaims(none, "below breakeven")).toEqual([]);
  });
});
