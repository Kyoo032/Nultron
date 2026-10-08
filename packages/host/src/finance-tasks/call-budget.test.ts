import { describe, expect, it } from "vitest";
import { EXTRA_CALLS_MAX, createCallBudget, takeExtraCall } from "./call-budget";

describe("createCallBudget", () => {
  it("grants one extra call by default and refuses every later ask", () => {
    const budget = createCallBudget();
    expect(EXTRA_CALLS_MAX).toBe(1);
    expect(budget.remaining).toBe(1);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.take()).toBe(false);
    expect(budget.used).toBe(1);
    expect(budget.remaining).toBe(0);
  });

  it("counts the refusals, so the desk can say a rewrite was not attempted", () => {
    const budget = createCallBudget(1);
    budget.take();
    budget.take();
    budget.take();
    expect(budget.refused).toBe(2);
  });

  it("makes each run's budget its own", () => {
    const first = createCallBudget();
    const second = createCallBudget();
    first.take();
    expect(second.remaining).toBe(1);
    expect(second.take()).toBe(true);
  });

  it("honours a larger allowance and refuses a negative or broken one", () => {
    const three = createCallBudget(3);
    expect([three.take(), three.take(), three.take(), three.take()]).toEqual([true, true, true, false]);
    expect(createCallBudget(0).take()).toBe(false);
    expect(createCallBudget(-2).take()).toBe(false);
    expect(createCallBudget(Number.NaN).take()).toBe(false);
    expect(createCallBudget(1.9).remaining).toBe(1);
  });
});

describe("takeExtraCall", () => {
  it("is unlimited outside a run, where there is no budget to draw on", () => {
    expect(takeExtraCall(undefined)).toBe(true);
  });

  it("draws on the budget it is given", () => {
    const budget = createCallBudget(1);
    expect(takeExtraCall(budget)).toBe(true);
    expect(takeExtraCall(budget)).toBe(false);
  });
});
