import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { usageWindow } from "./usage-window";

const DAY_MS = 86_400_000;

function dayKeys(first: string, count: number): string[] {
  const start = Date.parse(`${first}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

function isoWeekKeys(first: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `2026-W${String(first + index).padStart(2, "0")}`);
}

function plain(text: string | undefined): string | undefined {
  return text?.replace(/\s/g, " ");
}

describe("usageWindow", () => {
  it("spans the first to the last day of a day range, both ends included", () => {
    const window = usageWindow("day", dayKeys("2026-10-06", 14), "en");
    expect(window?.count).toBe(14);
    expect(plain(window?.span)).toBe("Oct 6 – 19, 2026");
  });

  it("reads a single day as that day", () => {
    const window = usageWindow("day", ["2026-10-19"], "en");
    expect(window?.count).toBe(1);
    expect(plain(window?.span)).toBe("Oct 19, 2026");
  });

  it("reads the day range in Indonesian", () => {
    expect(plain(usageWindow("day", dayKeys("2026-10-06", 14), "id")?.span)).toBe("6–19 Okt 2026");
  });

  it("spans Monday of the first ISO week to Sunday of the last", () => {
    const window = usageWindow("week", isoWeekKeys(34, 8), "en");
    expect(window?.count).toBe(8);
    expect(plain(window?.span)).toBe("Aug 17 – Oct 11, 2026");
    expect(plain(usageWindow("week", isoWeekKeys(34, 8), "id")?.span)).toBe("17 Agu – 11 Okt 2026");
  });

  it("reads ISO weeks across a year boundary", () => {
    const window = usageWindow("week", ["2025-W52", "2026-W01"], "en");
    expect(window?.count).toBe(2);
    expect(plain(window?.span)).toBe("Dec 22, 2025 – Jan 4, 2026");
  });

  it("spans whole months for a month range", () => {
    const keys = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const window = usageWindow("month", keys, "en");
    expect(window?.count).toBe(6);
    expect(plain(window?.span)).toBe("May – Oct 2026");
    expect(plain(usageWindow("month", keys, "id")?.span)).toBe("Mei–Okt 2026");
  });

  it("answers null when there are no buckets", () => {
    expect(usageWindow("day", [], "en")).toBeNull();
  });

  it("answers null for a key that is not a day, week or month of its range", () => {
    expect(usageWindow("day", ["2026-10-6"], "en")).toBeNull();
    expect(usageWindow("day", ["2026-02-30"], "en")).toBeNull();
    expect(usageWindow("week", ["2026-W54"], "en")).toBeNull();
    expect(usageWindow("month", ["2026-13"], "en")).toBeNull();
    expect(usageWindow("month", ["2026-10-01"], "en")).toBeNull();
  });
});

describe("the window sentence", () => {
  afterEach(() => {
    resetLocaleForTests();
  });

  it("names one bar per period, the count and the span, in English", () => {
    applyLocale("en");
    expect(t("usage.chart.window.day", { count: 14, span: "Oct 6 – 19, 2026" })).toBe(
      "One bar per day · last 14 days · Oct 6 – 19, 2026",
    );
  });

  it("names the same parts in Indonesian", () => {
    applyLocale("id");
    expect(t("usage.chart.window.week", { count: 8, span: "17 Agu – 11 Okt 2026" })).toBe(
      "Satu batang per minggu · 8 minggu terakhir · 17 Agu – 11 Okt 2026",
    );
  });
});
