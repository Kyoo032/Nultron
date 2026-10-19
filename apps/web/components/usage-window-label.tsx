"use client";

import { getLocale, t } from "@/lib/i18n";
import { usageWindow } from "@/lib/usage-window";
import type { RangeUsage } from "./usage-panel";

export function UsageWindowLabel({ usage }: { usage: Pick<RangeUsage, "range" | "buckets"> | null }) {
  if (!usage) {
    return null;
  }
  const period = usageWindow(
    usage.range,
    usage.buckets.map((bucket) => bucket.key),
    getLocale(),
  );
  if (!period) {
    return null;
  }
  return (
    <p className="mt-1 text-xs text-[var(--text-2)]" data-testid="usage-range-window">
      {t(`usage.chart.window.${usage.range}`, { count: period.count, span: period.span })}
    </p>
  );
}
