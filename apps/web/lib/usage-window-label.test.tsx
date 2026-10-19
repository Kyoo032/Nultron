import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageWindowLabel } from "@/components/usage-window-label";
import type { RangeUsage, UsageRange } from "@/components/usage-panel";
import { applyLocale, resetLocaleForTests } from "./i18n";

const DAY_MS = 86_400_000;

function payload(range: UsageRange, keys: string[]): Pick<RangeUsage, "range" | "buckets"> {
  return {
    range,
    buckets: keys.map((key) => ({ key, label: key, usd: 0, models: [] })),
  };
}

function dayKeys(first: string, count: number): string[] {
  const start = Date.parse(`${first}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

function render(usage: Pick<RangeUsage, "range" | "buckets"> | null): string {
  return renderToStaticMarkup(<UsageWindowLabel usage={usage} />).replace(/\s/g, " ");
}

describe("UsageWindowLabel", () => {
  afterEach(() => {
    resetLocaleForTests();
  });

  it("renders nothing before any payload has loaded", () => {
    expect(render(null)).toBe("");
  });

  it("states the day window under the chart title", () => {
    const markup = render(payload("day", dayKeys("2026-10-06", 14)));
    expect(markup).toContain('data-testid="usage-range-window"');
    expect(markup).toContain("One bar per day · last 14 days · Oct 6 – 19, 2026");
  });

  it("states the month window in Indonesian", () => {
    applyLocale("id");
    const markup = render(payload("month", ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]));
    expect(markup).toContain("Satu batang per bulan · 6 bulan terakhir · Mei–Okt 2026");
  });

  it("renders nothing when the buckets carry no readable key", () => {
    expect(render(payload("day", ["not-a-day"]))).toBe("");
  });
});
