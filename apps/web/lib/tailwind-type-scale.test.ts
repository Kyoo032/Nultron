import { describe, expect, it } from "vitest";
import config from "../tailwind.config";

/**
 * The Tailwind type scale reads in order: each step is larger than the one before it. Until
 * 2026-10-22 `2xl` was 28px while `3xl` to `5xl` were 24px, so `text-3xl` rendered smaller than
 * `text-2xl`.
 */
const ORDER = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"];

const FONT_SIZE = (config.theme?.extend?.fontSize ?? {}) as Record<string, [string, unknown]>;

function sizeOf(name: string): number {
  const entry = FONT_SIZE[name];
  expect(entry, `fontSize.${name} exists`).toBeDefined();
  return Number.parseFloat(entry[0]);
}

describe("tailwind type scale", () => {
  it("never shrinks from one step to the next", () => {
    const sizes = ORDER.map(sizeOf);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `${ORDER[i]} against ${ORDER[i - 1]}`).toBeGreaterThanOrEqual(sizes[i - 1] as number);
    }
  });

  it("makes every step from 2xl up larger than the one before it", () => {
    const sizes = ORDER.slice(ORDER.indexOf("xl")).map(sizeOf);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `${ORDER[ORDER.indexOf("xl") + i]}`).toBeGreaterThan(sizes[i - 1] as number);
    }
  });
});
