import type { AppLocale } from "@agentforge/core/locale";
import type { UsageRange } from "@/components/usage-panel";

const LOCALE_TAGS: Record<AppLocale, string> = { en: "en-US", id: "id-ID" };
const MS_PER_DAY = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_KEY = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

export type UsageWindow = { count: number; span: string };

type KeySpan = { start: Date; end: Date };

function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

function isoWeekMonday(year: number, week: number): Date | null {
  const jan4 = utcDate(year, 1, 4);
  if (!jan4 || week < 1 || week > 53) {
    return null;
  }
  const weekday = jan4.getUTCDay() || 7;
  return new Date(jan4.getTime() - (weekday - 1) * MS_PER_DAY + (week - 1) * 7 * MS_PER_DAY);
}

function keySpan(range: UsageRange, key: string): KeySpan | null {
  if (range === "day") {
    const match = DAY_KEY.exec(key);
    const day = match ? utcDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
    return day ? { start: day, end: day } : null;
  }
  if (range === "week") {
    const match = WEEK_KEY.exec(key);
    const monday = match ? isoWeekMonday(Number(match[1]), Number(match[2])) : null;
    return monday ? { start: monday, end: new Date(monday.getTime() + 6 * MS_PER_DAY) } : null;
  }
  const match = MONTH_KEY.exec(key);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = utcDate(year, month, 1);
  if (!start) {
    return null;
  }
  return { start, end: new Date(Date.UTC(year, month, 0)) };
}

export function usageWindow(range: UsageRange, keys: readonly string[], locale: AppLocale): UsageWindow | null {
  const first = keys[0];
  const last = keys.at(-1);
  if (!first || !last) {
    return null;
  }
  const start = keySpan(range, first);
  const end = keySpan(range, last);
  if (!start || !end) {
    return null;
  }
  const options: Intl.DateTimeFormatOptions =
    range === "month"
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  const span = new Intl.DateTimeFormat(LOCALE_TAGS[locale] ?? LOCALE_TAGS.en, options).formatRange(
    start.start,
    end.end,
  );
  return { count: keys.length, span };
}
