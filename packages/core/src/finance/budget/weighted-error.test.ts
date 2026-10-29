import { describe, expect, it } from "vitest";
import { budgetAllowedNumbers, budgetInputSchema, budgetPromptFacts, computeBudget } from "./index";
import { RETAIL_ITEMS, RETAIL_PARAMS } from "./__fixtures__/grids";
import { budgetWeightedError, budgetWeightedErrors, DEFAULT_BUDGET_THRESHOLDS, varianceCell, type BudgetVarianceLine } from "./variance";

type Line = Pick<BudgetVarianceLine, "kind" | "periods">;

function line(kind: Line["kind"], pairs: readonly (readonly [number, number])[]): Line {
  return {
    kind,
    periods: pairs.map(([budget, actual], at) => varianceCell(`Q${at + 1}`, budget, actual, kind, DEFAULT_BUDGET_THRESHOLDS)),
  };
}

describe("weighted absolute error", () => {
  it("counts the swings a zero total variance hides", () => {
    const lines = [line("revenue", [[100, 130]]), line("revenue", [[100, 70]])];
    expect(budgetWeightedError(lines, "revenue")).toBeCloseTo(30, 9);
  });

  it("reads every period, so quarters that net to nothing still count", () => {
    const lines = [line("cost", [[100, 140], [100, 60]])];
    expect(budgetWeightedError(lines, "cost")).toBeCloseTo(40, 9);
  });

  it("charges an unbudgeted line in full against the budget there was", () => {
    const lines = [line("cost", [[50, 55]]), line("cost", [[0, 20]])];
    expect(budgetWeightedError(lines, "cost")).toBeCloseTo(50, 9);
  });

  it("is not a figure when the side had no budget at all", () => {
    expect(budgetWeightedError([line("cost", [[0, 20]])], "cost")).toBeNull();
    expect(budgetWeightedError([line("cost", [[10, 20]])], "revenue")).toBeNull();
  });

  it("is not a figure when there are no lines or the budget is all zero", () => {
    expect(budgetWeightedError([], "cost")).toBeNull();
    expect(budgetWeightedError([line("cost", [[0, 0]])], "cost")).toBeNull();
    expect(budgetWeightedErrors([])).toEqual({ revenue: null, cost: null });
  });
});

describe("the weighted error reaches the model and the guard", () => {
  const input = budgetInputSchema.parse({ items: RETAIL_ITEMS, params: RETAIL_PARAMS });
  const computed = computeBudget(input);

  it("is computed for both sides of the retail sheet", () => {
    expect(computed.weightedError.revenue).not.toBeNull();
    expect(computed.weightedError.cost).not.toBeNull();
    expect(computed.weightedError.revenue).toBeCloseTo(budgetWeightedError(computed.lines, "revenue") as number, 9);
  });

  it("is in the fact sheet, in both languages, and allowed back at one decimal", () => {
    expect(budgetPromptFacts(computed, "en")).toContain("weighted-error");
    expect(budgetPromptFacts(computed, "id")).toContain("weighted-error");
    const allowed = budgetAllowedNumbers(input, computed);
    const cost = computed.weightedError.cost as number;
    expect(allowed).toContain(Number(cost.toFixed(1)));
  });
});
