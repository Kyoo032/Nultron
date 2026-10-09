import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentforge/core";
import { createCallBudget } from "./call-budget";
import { askForReading, isUnreadReading } from "./reading";

const unread = () => new ApiError("invalid_finance", "not the sections", 502);

describe("isUnreadReading", () => {
  it("is true for the two 502s that mean the model did not write the reading", () => {
    expect(isUnreadReading(unread())).toBe(true);
    expect(isUnreadReading(new ApiError("generation_failed", "empty", 502))).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isUnreadReading(new ApiError("gateway_blocked", "closed", 403))).toBe(false);
    expect(isUnreadReading(new Error("boom"))).toBe(false);
  });
});

describe("askForReading", () => {
  it("asks once more when the first answer was not a reading, and says so", async () => {
    const ask = vi.fn().mockRejectedValueOnce(unread()).mockResolvedValueOnce("sections");
    const onRetry = vi.fn();
    await expect(askForReading(ask, onRetry)).resolves.toBe("sections");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("draws the second ask from the run's shared budget", async () => {
    const budget = createCallBudget();
    const ask = vi.fn().mockRejectedValueOnce(unread()).mockResolvedValueOnce("sections");
    await askForReading(ask, () => {}, budget);
    expect(budget.used).toBe(1);
    expect(budget.remaining).toBe(0);
  });

  it("does not ask again when the budget is already spent, and the original error stands", async () => {
    const budget = createCallBudget();
    budget.take();
    const failure = unread();
    const ask = vi.fn().mockRejectedValue(failure);
    const onRetry = vi.fn();
    await expect(askForReading(ask, onRetry, budget)).rejects.toBe(failure);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("spends nothing when the first answer is a reading", async () => {
    const budget = createCallBudget();
    const ask = vi.fn().mockResolvedValue("sections");
    await askForReading(ask, () => {}, budget);
    expect(budget.used).toBe(0);
  });

  it("never retries an error that is not an unread reading, and spends nothing on it", async () => {
    const budget = createCallBudget();
    const closed = new ApiError("gateway_blocked", "closed", 403);
    const ask = vi.fn().mockRejectedValue(closed);
    await expect(askForReading(ask, () => {}, budget)).rejects.toBe(closed);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(budget.used).toBe(0);
  });

  it("lets a second failure through as the same error", async () => {
    const budget = createCallBudget();
    const ask = vi.fn().mockRejectedValue(unread());
    await expect(askForReading(ask, () => {}, budget)).rejects.toMatchObject({ code: "invalid_finance" });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("still retries once with no budget at all, as before", async () => {
    const ask = vi.fn().mockRejectedValueOnce(unread()).mockResolvedValueOnce("sections");
    await expect(askForReading(ask, () => {})).resolves.toBe("sections");
  });
});
