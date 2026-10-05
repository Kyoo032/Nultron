/**
 * When a locked address opens up again: the rolling day's guesses, with the oldest ones sliding out
 * first. A pure function, so the arithmetic is pinned without a database.
 */
import { describe, expect, it } from "vitest";
import { secondsUntilUnlocked } from "./otp-lock";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-10-01T12:00:00.000Z");

function codeAt(hoursAgo: number, attempts: number) {
  return { createdAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS), attempts };
}

describe("secondsUntilUnlocked", () => {
  it("is null while the day's total is under the limit: nothing is locked", () => {
    expect(secondsUntilUnlocked([codeAt(1, 5), codeAt(2, 5), codeAt(3, 5), codeAt(4, 4)], NOW, 20, DAY_MS)).toBeNull();
  });

  it("opens when the oldest code's guesses leave the day, if that brings the total under the limit", () => {
    // 20 guesses; the oldest code (5 guesses) is 10 hours old, so it ages out in 14 hours.
    const rows = [codeAt(10, 5), codeAt(6, 5), codeAt(5, 5), codeAt(1, 5)];
    expect(secondsUntilUnlocked(rows, NOW, 20, DAY_MS)).toBe(14 * 3600);
  });

  it("waits for as many of the oldest codes as it takes: one guess is not enough to drop under the limit twice", () => {
    // 22 guesses: dropping the oldest (1) leaves 21, still locked; dropping the next (5) leaves 16.
    const rows = [codeAt(20, 1), codeAt(12, 5), codeAt(6, 6), codeAt(5, 5), codeAt(1, 5)];
    expect(secondsUntilUnlocked(rows, NOW, 20, DAY_MS)).toBe((24 - 12) * 3600);
  });

  it("does not care what order the rows arrive in", () => {
    const rows = [codeAt(1, 5), codeAt(10, 5), codeAt(5, 5), codeAt(6, 5)];
    expect(secondsUntilUnlocked(rows, NOW, 20, DAY_MS)).toBe(14 * 3600);
  });

  it("never answers less than one second: a lock that is about to lift still reads as a wait", () => {
    const rows = [{ createdAt: new Date(NOW.getTime() - DAY_MS + 200), attempts: 20 }];
    expect(secondsUntilUnlocked(rows, NOW, 20, DAY_MS)).toBe(1);
  });
});
