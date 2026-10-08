/**
 * Meeting mode: which dates and times in a claim the transcript really says.
 *
 * The claim is read with the shared judges (`@agentforge/core/judges`), strictest reading first:
 *  1. strict: the transcript states the same date (so "1 Agustus" is not found in "31 Agustus");
 *  2. loose: a speaker splits a date across a sentence ("tanggal 14, bulan Agustus, tahun 2026"), so the day,
 *     the month name and the year only have to appear in the transcript. A named date must also have its
 *     day number and its month name side by side: within `SPLIT_DATE_NEAR_CHARS` of each other with no other
 *     number between them. Otherwise a stray "1" in "...31 Agustus 2026, and 1 vendor" would vouch for
 *     "1 Agustus", and so would a "2" anywhere in a long meeting for "2 Agustus".
 *
 * A long transcript is read through `indexTranscript` (see there), so the work stays linear in its length.
 *
 * Pure: no model call, no clock, no file access.
 */
import { type DateTimeMention, datesTraced, findDateTimeMentions } from "../harness/judges";
import type { AppLocale } from "../locale";
import { DIRECT_READ_CHARS, indexTranscript } from "./transcript-index";

/** How far either side of the day number the month name may be for a split date to count. */
export const SPLIT_DATE_NEAR_CHARS = 40;

/** The most places a day number is tried at when looking for it beside its month name. */
export const SPLIT_DATE_MAX_PLACES = 200;

const TRAILING_YEAR = /,?\s*\d{4}\s*$/;
const LEADING_NON_DIGITS = /^\D*/;
const TRAILING_NON_DIGITS = /\D*$/;

function sameMention(left: DateTimeMention, right: DateTimeMention): boolean {
  return left.kind === right.kind && left.text === right.text;
}

function yearIsSaid(year: number, transcript: string): boolean {
  return new RegExp(`(?<!\\d)${year}(?!\\d)`).test(transcript);
}

/**
 * True when the day number sits next to a month name in the transcript, and the year (if any) is said. Each
 * place the day number appears (up to `SPLIT_DATE_MAX_PLACES`) is read with only the words around it, up to
 * the next number on either side.
 */
function dayIsNearItsMonth(mention: DateTimeMention, transcript: string, locale: AppLocale): boolean {
  const [day, year] = mention.numbers;
  if (day === undefined || (year !== undefined && !yearIsSaid(year, transcript))) {
    return false;
  }
  const withoutYear = mention.text.replace(TRAILING_YEAR, "");
  const digits = String(day);
  let places = 0;
  for (const found of transcript.matchAll(new RegExp(`(?<!\\d)${digits}(?!\\d)`, "g"))) {
    places += 1;
    if (places > SPLIT_DATE_MAX_PLACES) {
      break;
    }
    const at = found.index ?? 0;
    const before = transcript.slice(Math.max(0, at - SPLIT_DATE_NEAR_CHARS), at);
    const after = transcript.slice(at + digits.length, at + digits.length + SPLIT_DATE_NEAR_CHARS);
    const around = `${before.match(TRAILING_NON_DIGITS)?.[0] ?? ""}${digits}${after.match(LEADING_NON_DIGITS)?.[0] ?? ""}`;
    if (datesTraced(withoutYear, around, locale, { loose: true }).traced) {
      return true;
    }
  }
  return false;
}

/**
 * The dates and clock times in `claim` the transcript does not say, in the order they are written. A claim
 * with none (a weekday, "next week") has nothing to trace here and gives an empty list: the caller decides
 * what a deadline in words must satisfy.
 */
export function untracedDates(claim: string, transcript: string, locale: AppLocale = "en"): DateTimeMention[] {
  if (findDateTimeMentions(claim).length === 0) {
    return [];
  }
  const index = transcript.length > DIRECT_READ_CHARS ? indexTranscript(transcript) : null;
  const strict = datesTraced(claim, index ? index.strictDates : transcript, locale).untraced;
  if (strict.length === 0) {
    return [];
  }
  const loose = datesTraced(claim, index ? index.looseDates : transcript, locale, { loose: true }).untraced;
  return strict.filter(
    (mention) =>
      loose.some((missing) => sameMention(missing, mention)) ||
      (mention.kind === "date" && !dayIsNearItsMonth(mention, transcript, locale)),
  );
}
