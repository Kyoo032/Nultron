import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { remainingUsageLabel } from "./chat-usage-label";

const format = (usd: number) => `$${usd.toFixed(2)}`;

beforeEach(() => applyLocale("en"));
afterEach(() => resetLocaleForTests());

describe("remainingUsageLabel", () => {
  it("is null when the key reports no remaining figure, so the chip shows nothing and no dash", () => {
    expect(remainingUsageLabel(null, format)).toBeNull();
    expect(remainingUsageLabel(undefined, format)).toBeNull();
  });

  it("names the formatted amount left when there is one", () => {
    expect(remainingUsageLabel(1.5, format)).toBe("Usage · $1.50");
    expect(remainingUsageLabel(0, format)).toBe("Usage · $0.00");
  });
});
