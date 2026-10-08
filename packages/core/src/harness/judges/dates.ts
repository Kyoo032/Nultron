/**
 * Dates, clock times and durations: reading them from text, resolving them, and checking that the ones
 * a model wrote are ones the evidence says.
 *
 * `findDateTimeMentions` is a copy of the reader that lives in host `meeting/minutes-checks.ts`, with its
 * behaviour unchanged (the host's cases are ported into `dates.test.ts`). Lane L3a switches the host to
 * import this one; until then the two must not drift. Pure; no model call.
 */
import type { AppLocale } from "../../locale";

// -- reading dates and times ---------------------------------------------------------------------

const MONTHS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ["January", "Jan", "Januari"]],
  [2, ["February", "Feb", "Februari", "Pebruari"]],
  [3, ["March", "Mar", "Maret"]],
  [4, ["April", "Apr"]],
  [5, ["May", "Mei"]],
  [6, ["June", "Jun", "Juni"]],
  [7, ["July", "Jul", "Juli"]],
  [8, ["August", "Aug", "Agustus", "Agu", "Agt"]],
  [9, ["September", "Sept", "Sep"]],
  [10, ["October", "Oct", "Oktober", "Okt"]],
  [11, ["November", "Nov", "Nopember"]],
  [12, ["December", "Dec", "Desember", "Des"]],
];

const MONTH_BY_NAME: ReadonlyMap<string, number> = new Map(
  MONTHS.flatMap(([month, names]) => names.map((name) => [name.toLowerCase(), month] as const)),
);

/** Longest first, so "September" wins over "Sep". */
const MONTH_ALTERNATION = [...MONTHS.flatMap(([, names]) => names)]
  .sort((left, right) => right.length - left.length)
  .join("|");

/**
 * What one date or time in a text looks like. `numbers` depends on `kind`: for `clock` it is
 * `[hour, minute]`; for `date` it is `[day]` or `[day, year]` (and `year` stays null); for `numeric-date`
 * it is the two day/month parts as written (ISO order for `2026-03-14`, so `[3, 14]`) and `year` is set.
 */
export type DateTimeMention = {
  readonly kind: "clock" | "date" | "numeric-date";
  readonly text: string;
  /** clock: [hour, minute]; date: [day, year?]; numeric-date: the two day/month parts. */
  readonly numbers: readonly number[];
  /** date: the month named. */
  readonly month: number | null;
  /** numeric-date: the year part. */
  readonly year: number | null;
};

// A month name only counts in the minutes when it is capitalised, so the verbs "may" and "march"
// are not read as dates. The transcript is searched in lower case, where either spelling counts.
const DAY_THEN_MONTH = new RegExp(
  `(?<![\\d/-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALTERNATION})\\.?(?![A-Za-z])(?:,?\\s+(\\d{4})(?!\\d))?`,
  "g",
);
const MONTH_THEN_DAY = new RegExp(
  `(?<![A-Za-z])(${MONTH_ALTERNATION})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(\\d{4})(?!\\d))?`,
  "g",
);
const ISO_DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
const NUMERIC_DATE = /(?<![\d/-])(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?![\d/-])/g;
const ID_CLOCK = /\b(?:pukul|jam)\s+(\d{1,2})(?:[:.](\d{2}))?(?!\d)/gi;
const CLOCK = /(?<![\d:./-])(\d{1,2})(?:([:.])(\d{2}))?(?:\s?([ap])\.?m\.?(?![A-Za-z]))?(?![\d:])/gi;

function blank(text: string, start: number, length: number): string {
  return `${text.slice(0, start)}${" ".repeat(length)}${text.slice(start + length)}`;
}

/** Runs `pattern` over `text`, hands each match to `read`, and blanks the matched span so a later pattern skips it. */
function take(
  text: string,
  pattern: RegExp,
  read: (match: RegExpMatchArray) => DateTimeMention | null,
): { rest: string; found: DateTimeMention[] } {
  let rest = text;
  const found: DateTimeMention[] = [];
  for (const match of text.matchAll(pattern)) {
    const mention = read(match);
    if (mention) {
      found.push(mention);
      rest = blank(rest, match.index ?? 0, match[0].length);
    }
  }
  return { rest, found };
}

function validDay(day: number): boolean {
  return day >= 1 && day <= 31;
}

function clockMention(
  match: RegExpMatchArray,
  hour: number,
  minute: number,
  twelveHour: boolean,
): DateTimeMention | null {
  const limit = twelveHour ? 12 : 24;
  if (hour > limit || (twelveHour && hour < 1) || minute > 59) {
    return null;
  }
  return { kind: "clock", text: match[0].trim(), numbers: [hour, minute], month: null, year: null };
}

type Scan = {
  readonly found: readonly DateTimeMention[];
  /** The text with every mention blanked at equal length. */
  readonly rest: string;
};

function scanDateTimes(text: string): Scan {
  const monthNumber = (name: string | undefined): number | null =>
    MONTH_BY_NAME.get((name ?? "").toLowerCase()) ?? null;
  const dateMention = (
    match: RegExpMatchArray,
    day: string | undefined,
    name: string | undefined,
    year: string | undefined,
  ) => {
    const dayNumber = Number(day);
    const month = monthNumber(name);
    if (!validDay(dayNumber) || month === null) {
      return null;
    }
    const numbers = year ? [dayNumber, Number(year)] : [dayNumber];
    return { kind: "date", text: match[0].trim(), numbers, month, year: null } satisfies DateTimeMention;
  };

  const iso = take(text, ISO_DATE, (match) => ({
    kind: "numeric-date",
    text: match[0],
    numbers: [Number(match[2]), Number(match[3])],
    month: null,
    year: Number(match[1]),
  }));
  const numeric = take(iso.rest, NUMERIC_DATE, (match) => ({
    kind: "numeric-date",
    text: match[0],
    numbers: [Number(match[1]), Number(match[2])],
    month: null,
    year: Number(match[3]),
  }));
  const dayFirst = take(numeric.rest, DAY_THEN_MONTH, (match) => dateMention(match, match[1], match[2], match[3]));
  const monthFirst = take(dayFirst.rest, MONTH_THEN_DAY, (match) => dateMention(match, match[2], match[1], match[3]));
  const indonesianClock = take(monthFirst.rest, ID_CLOCK, (match) =>
    clockMention(match, Number(match[1]), Number(match[2] ?? 0), false),
  );
  const clock = take(indonesianClock.rest, CLOCK, (match) => {
    const separator = match[2];
    const meridiem = match[4];
    // "3.5" is a decimal and a bare "3" is a number: a clock needs "3:30" or an am/pm.
    if (separator !== ":" && !meridiem) {
      return null;
    }
    return clockMention(match, Number(match[1]), Number(match[3] ?? 0), Boolean(meridiem));
  });
  return {
    found: [
      ...iso.found,
      ...numeric.found,
      ...dayFirst.found,
      ...monthFirst.found,
      ...indonesianClock.found,
      ...clock.found,
    ],
    rest: clock.rest,
  };
}

/**
 * Every date and time the text quotes, in the forms the minutes writer uses, grouped by kind: ISO dates,
 * numeric dates, day-first then month-first named dates, then clock times (Indonesian `pukul`/`jam` before
 * the rest). Plain weekdays and "next week" are not dates here.
 */
export function findDateTimeMentions(text: string): DateTimeMention[] {
  return [...scanDateTimes(text).found];
}

/**
 * The text with every date and time blanked at equal length, so a number reader that runs next does not
 * take "14" of "14 Agustus 2026" or "15" of "pukul 15.00" for a figure.
 */
export function maskDateTimes(text: string): string {
  return scanDateTimes(text).rest;
}

// -- resolving dates ------------------------------------------------------------------------------

type DateParts = { readonly day: number; readonly month: number; readonly year: number | null };

const FEBRUARY = 2;
const FEBRUARY_MAX_DAY = 29;
const TWO_DIGIT_YEAR_BASE = 2000;
const TWO_DIGIT_YEAR_LIMIT = 100;
const MONTHS_PER_YEAR = 12;
const ISO_START = /^\d{4}-/;

function fullYear(year: number | null): number | null {
  return year !== null && year < TWO_DIGIT_YEAR_LIMIT ? TWO_DIGIT_YEAR_BASE + year : year;
}

function plausible(parts: DateParts): boolean {
  if (!validDay(parts.day) || parts.month < 1 || parts.month > MONTHS_PER_YEAR) {
    return false;
  }
  return !(parts.month === FEBRUARY && parts.day > FEBRUARY_MAX_DAY);
}

/** True when the day exists in that month of that year (29 February only in a leap year). */
function realDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Which of an ambiguous `03/04/2026` is read first: day-first in Indonesian, month-first in English. */
function dayFirstFor(locale: AppLocale): boolean {
  return locale === "id";
}

/**
 * The readings of a date mention. A named date and an ISO date have one. A numeric date has one when a
 * part is above 12 and otherwise two: with a locale only the one that locale reads, without one both.
 */
function datePartsOf(mention: DateTimeMention, locale: AppLocale | null): DateParts[] {
  if (mention.kind === "date") {
    const [day = 0, year] = mention.numbers;
    return [{ day, month: mention.month ?? 0, year: year ?? null }].filter(plausible);
  }
  if (mention.kind !== "numeric-date") {
    return [];
  }
  const year = fullYear(mention.year);
  const [first = 0, second = 0] = mention.numbers;
  if (ISO_START.test(mention.text)) {
    return [{ day: second, month: first, year }].filter(plausible);
  }
  const dayFirst: DateParts = { day: first, month: second, year };
  const monthFirst: DateParts = { day: second, month: first, year };
  const readings = [dayFirst, monthFirst].filter(plausible);
  if (readings.length < 2 || first === second) {
    return readings.slice(0, 1);
  }
  if (locale === null) {
    return readings;
  }
  return [dayFirstFor(locale) ? dayFirst : monthFirst];
}

function isoOf(parts: DateParts): string | null {
  if (parts.year === null || !realDate(parts.year, parts.month, parts.day)) {
    return null;
  }
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

function dateMentions(text: string): DateTimeMention[] {
  return findDateTimeMentions(text).filter((mention) => mention.kind !== "clock");
}

/**
 * The first full date in the text as `YYYY-MM-DD`, or null when the text holds none, the date has no
 * year, or the day does not exist (31 February). An ambiguous numeric date such as `03/04/2026` is read
 * day-first in Indonesian and month-first in English.
 */
export function isoDateOf(text: string, locale: AppLocale): string | null {
  for (const mention of dateMentions(text)) {
    for (const parts of datePartsOf(mention, locale)) {
      const iso = isoOf(parts);
      if (iso !== null) {
        return iso;
      }
    }
  }
  return null;
}

/** Every `YYYY-MM-DD` the text could mean, in order, counting both readings of an ambiguous numeric date. */
export function isoDatesOf(text: string): string[] {
  const found = dateMentions(text).flatMap((mention) =>
    datePartsOf(mention, null)
      .map(isoOf)
      .filter((iso): iso is string => iso !== null),
  );
  return [...new Set(found)];
}

function partsAgree(left: DateParts, right: DateParts): boolean {
  return (
    left.day === right.day &&
    left.month === right.month &&
    (left.year === null || right.year === null || left.year === right.year)
  );
}

function mentionsAgree(left: DateTimeMention, right: DateTimeMention, locale: AppLocale | null): boolean {
  const rightParts = datePartsOf(right, locale);
  return datePartsOf(left, locale).some((parts) => rightParts.some((other) => partsAgree(parts, other)));
}

/**
 * True when the first date in `left` and the first in `right` are the same day: written differently, or
 * one of them without a year. Pass the run locale to settle an ambiguous numeric date; without it either
 * reading may agree.
 */
export function sameDate(left: string, right: string, locale?: AppLocale): boolean {
  const [leftMention] = dateMentions(left);
  const [rightMention] = dateMentions(right);
  if (!leftMention || !rightMention) {
    return false;
  }
  return mentionsAgree(leftMention, rightMention, locale ?? null);
}

// -- tracing dates and times to evidence ------------------------------------------------------------

const MERIDIEM = /(?<![A-Za-z])([ap])\.?m\.?(?![A-Za-z])/i;
const NOON_HOUR = 12;

/** The 24-hour hours a clock mention can mean: one when it says am/pm or is plainly 24-hour, else two. */
function hoursOf(mention: DateTimeMention): number[] {
  const [hour = 0] = mention.numbers;
  const meridiem = MERIDIEM.exec(mention.text)?.[1]?.toLowerCase();
  const twelve = hour % NOON_HOUR;
  if (meridiem === "a") {
    return [twelve];
  }
  if (meridiem === "p") {
    return [twelve + NOON_HOUR];
  }
  if (hour === 0 || hour > NOON_HOUR) {
    return [hour % 24];
  }
  return [twelve, twelve + NOON_HOUR];
}

function clocksAgree(left: DateTimeMention, right: DateTimeMention): boolean {
  const [, leftMinute = 0] = left.numbers;
  const [, rightMinute = 0] = right.numbers;
  if (leftMinute !== rightMinute) {
    return false;
  }
  const rightHours = hoursOf(right);
  return hoursOf(left).some((hour) => rightHours.includes(hour));
}

/** A claim's numeric date is read by the run locale; the evidence's may be read either way. */
function mentionTraced(claim: DateTimeMention, evidence: readonly DateTimeMention[], locale: AppLocale): boolean {
  if (claim.kind === "clock") {
    return evidence.some((other) => other.kind === "clock" && clocksAgree(claim, other));
  }
  const claimParts = datePartsOf(claim, locale);
  return evidence.some(
    (other) =>
      other.kind !== "clock" &&
      datePartsOf(other, null).some((parts) => claimParts.some((mine) => partsAgree(mine, parts))),
  );
}

type Heard = { readonly numbers: ReadonlySet<number>; readonly months: ReadonlySet<number> };

/** The numbers and month names a transcript says. Spelled-out numbers ("fourteenth") are not read. */
function whatWasHeard(transcript: string): Heard {
  const numbers = new Set<number>();
  for (const match of transcript.matchAll(/\d+/g)) {
    numbers.add(Number(match[0]));
  }
  const months = new Set<number>();
  const lower = transcript.toLowerCase();
  for (const [name, month] of MONTH_BY_NAME) {
    if (new RegExp(`(?<![a-z])${name}(?![a-z])`).test(lower)) {
      months.add(month);
    }
  }
  return { numbers, months };
}

/** 3, 15 and 03 are one hour on the clock: a transcript that says "3 PM" supports "15:00". */
function hourVariants(hour: number): number[] {
  const twelve = hour % NOON_HOUR;
  return [hour, twelve === 0 ? NOON_HOUR : twelve, twelve + NOON_HOUR, hour === 24 ? 0 : hour];
}

/** Copy of the host's looser reading: the parts of a date or time are said somewhere in the text, not necessarily together. */
function isHeard(mention: DateTimeMention, heard: Heard): boolean {
  const has = (value: number) => heard.numbers.has(value);
  switch (mention.kind) {
    case "clock": {
      const [hour = 0, minute = 0] = mention.numbers;
      return hourVariants(hour).some(has) && (minute === 0 || has(minute));
    }
    case "date":
      return mention.numbers.every(has) && mention.month !== null && heard.months.has(mention.month);
    case "numeric-date": {
      const part = (value: number) => has(value) || (value >= 1 && value <= MONTHS_PER_YEAR && heard.months.has(value));
      const year = mention.year;
      const yearHeard = year === null || has(year) || (year < TWO_DIGIT_YEAR_LIMIT && has(TWO_DIGIT_YEAR_BASE + year));
      return mention.numbers.every(part) && yearHeard;
    }
  }
}

export type DatesTraceOptions = {
  /**
   * Read the evidence the way a spoken transcript needs: a date is said when its day number, its year and its
   * month name each appear anywhere in the evidence, not necessarily side by side. Default false, which wants
   * the evidence to state the same date (so "1 Agustus" is not found in "31 Agustus" and "1 September").
   */
  readonly loose?: boolean;
};

export type DatesTrace = {
  /** Every date and time in the claim is stated by the evidence (true when the claim has none). */
  readonly traced: boolean;
  /** The claim's dates and times the evidence does not state, in the order {@link findDateTimeMentions} gives them. */
  readonly untraced: readonly DateTimeMention[];
};

/**
 * Does the evidence state every date and time the claim mentions? A date matches when day, month and year
 * agree (a claim without a year matches any year; a numeric claim is read by `locale`); a clock time matches
 * when the minutes agree and the hour does on a 12- or 24-hour clock (a claim that says am or pm must
 * match it). A claim with no date or time is traced.
 */
export function datesTraced(
  claim: string,
  evidence: string,
  locale: AppLocale,
  options: DatesTraceOptions = {},
): DatesTrace {
  const mentions = findDateTimeMentions(claim);
  if (mentions.length === 0) {
    return { traced: true, untraced: [] };
  }
  const untraced = options.loose
    ? mentions.filter((mention) => !isHeard(mention, whatWasHeard(evidence)))
    : untracedStrictly(mentions, findDateTimeMentions(evidence), locale);
  return { traced: untraced.length === 0, untraced };
}

function untracedStrictly(
  mentions: readonly DateTimeMention[],
  evidence: readonly DateTimeMention[],
  locale: AppLocale,
): DateTimeMention[] {
  return mentions.filter((mention) => !mentionTraced(mention, evidence, locale));
}

// -- durations ------------------------------------------------------------------------------------

const MONTHS_PER_QUARTER = 3;

const UNIT_MONTHS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:months?|bulan|bln)$/i, 1],
  [/^(?:years?|yrs?|tahun|thn)$/i, MONTHS_PER_YEAR],
  [/^(?:quarters?|kuartal|triwulan)$/i, MONTHS_PER_QUARTER],
];

const DURATION_UNIT = "months?|bulan|bln|years?|yrs?|tahun|thn|quarters?|kuartal|triwulan";

/** Small numbers written out, longest first so "dua belas" wins over "dua". */
const NUMBER_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["dua belas", 12],
  ["twelve", 12],
  ["eleven", 11],
  ["sebelas", 11],
  ["sepuluh", 10],
  ["delapan", 8],
  ["sembilan", 9],
  ["three", 3],
  ["seven", 7],
  ["eight", 8],
  ["tujuh", 7],
  ["empat", 4],
  ["enam", 6],
  ["lima", 5],
  ["tiga", 3],
  ["four", 4],
  ["five", 5],
  ["nine", 9],
  ["ten", 10],
  ["satu", 1],
  ["dua", 2],
  ["one", 1],
  ["two", 2],
  ["six", 6],
];

const DIGIT_DURATION = new RegExp(
  `(?<![\\w.,])(\\d+(?:[.,]\\d+)?)\\s*\\)?\\s*(?:\\([^)]{1,40}\\)\\s*)?(${DURATION_UNIT})\\b`,
  "gi",
);
const WORD_DURATION = new RegExp(
  `\\b(${NUMBER_WORDS.map(([word]) => word.replace(" ", "\\s+")).join("|")})\\s+(${DURATION_UNIT})\\b`,
  "gi",
);
const FUSED_DURATION = /\b(setahun|sebulan)\b/gi;

function monthsPerUnit(unit: string): number {
  return UNIT_MONTHS.find(([pattern]) => pattern.test(unit))?.[1] ?? 0;
}

type DurationHit = { readonly index: number; readonly months: number };

function durationHits(text: string): DurationHit[] {
  const hits: DurationHit[] = [];
  for (const match of text.matchAll(DIGIT_DURATION)) {
    const amount = Number((match[1] ?? "").replace(",", "."));
    hits.push({ index: match.index ?? 0, months: amount * monthsPerUnit(match[2] ?? "") });
  }
  for (const match of text.matchAll(WORD_DURATION)) {
    const word = (match[1] ?? "").toLowerCase().replace(/\s+/g, " ");
    const amount = NUMBER_WORDS.find(([name]) => name === word)?.[1] ?? 0;
    hits.push({ index: match.index ?? 0, months: amount * monthsPerUnit(match[2] ?? "") });
  }
  for (const match of text.matchAll(FUSED_DURATION)) {
    hits.push({ index: match.index ?? 0, months: (match[1] ?? "").toLowerCase() === "setahun" ? MONTHS_PER_YEAR : 1 });
  }
  return hits.filter((hit) => Number.isFinite(hit.months) && hit.months > 0).sort((a, b) => a.index - b.index);
}

/**
 * The first duration in the text, in months: months, years and quarters in English and Indonesian, digits
 * (`24`, `1,5`, and `24 (dua puluh empat) bulan` or `twenty-four (24) months`) or a small number written
 * out (`one year`, `satu tahun`, `dua belas bulan`, `setahun`). Days and weeks are not months, so they
 * give null; so does text with no duration.
 */
export function durationMonths(text: string): number | null {
  return durationHits(text)[0]?.months ?? null;
}
