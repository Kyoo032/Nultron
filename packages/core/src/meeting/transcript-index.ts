/**
 * Meeting mode: a long transcript, read once into the small strings the judges are asked about.
 *
 * A transcript can be 600 000 characters, pasted by anyone, and the judges' date and amount readers are
 * quadratic in how many dates and amounts one string holds: a transcript that is nothing but dates took
 * seconds per question. So a long transcript is read once, a line at a time (a line longer than a window is
 * read in overlapping windows), into three short strings: every distinct date or time it states, every number
 * and month name it says, and every distinct amount it states. The judges then read those instead, and every
 * later question about the same transcript costs almost nothing. A short text, such as the passage around a
 * quote, is not indexed: it is read as it is.
 *
 * The strings keep what the judges look at: each date or amount as written, with its unit and currency
 * symbol. They drop what the judges only use for context (a currency written as a code before a bare number).
 *
 * Pure: no model call, no clock, no file access.
 */
import { amountsIn, findDateTimeMentions } from "../harness/judges";
import type { AppLocale } from "../locale";

/** Evidence up to this long is read as it is; longer is read through {@link indexTranscript}. */
export const DIRECT_READ_CHARS = 4000;
/** A line longer than this is read in windows of this size, overlapping so no date or amount is cut in two. */
const LINE_WINDOW_CHARS = 2000;
const LINE_WINDOW_OVERLAP_CHARS = 64;
/** The transcripts remembered between calls: the one a run works on, and the one it translates against. */
const REMEMBERED_TRANSCRIPTS = 4;
const SEPARATOR = "\n;\n";

/**
 * Every month name the judges' date reader knows, lower case. A test pins each one against the reader, so a
 * typo here cannot hide; the reader's own table is private to it.
 */
export const MONTH_WORDS: readonly string[] = [
  "january",
  "jan",
  "januari",
  "february",
  "feb",
  "februari",
  "pebruari",
  "march",
  "mar",
  "maret",
  "april",
  "apr",
  "may",
  "mei",
  "june",
  "jun",
  "juni",
  "july",
  "jul",
  "juli",
  "august",
  "aug",
  "agustus",
  "agu",
  "agt",
  "september",
  "sept",
  "sep",
  "october",
  "oct",
  "oktober",
  "okt",
  "november",
  "nov",
  "nopember",
  "december",
  "dec",
  "desember",
  "des",
];

const MONTH_PATTERNS = MONTH_WORDS.map((word) => [word, new RegExp(`(?<![a-z])${word}(?![a-z])`)] as const);

export type TranscriptIndex = {
  /** Every distinct date and time the transcript states, one per entry: the evidence for the strict reading. */
  readonly strictDates: string;
  /** Every number and month name the transcript says: the evidence for the loose reading of a split date. */
  readonly looseDates: string;
  /** Every distinct amount the transcript states, read the way the run's language reads it. */
  amounts(locale: AppLocale): string;
};

function* linesOf(text: string): Generator<string> {
  for (const line of text.split("\n")) {
    if (line.length <= LINE_WINDOW_CHARS) {
      yield line;
      continue;
    }
    const step = LINE_WINDOW_CHARS - LINE_WINDOW_OVERLAP_CHARS;
    for (let at = 0; at < line.length; at += step) {
      yield line.slice(at, at + LINE_WINDOW_CHARS);
    }
  }
}

function distinct(text: string, read: (line: string) => Iterable<string>): string {
  const found = new Set<string>();
  for (const line of linesOf(text)) {
    for (const item of read(line)) {
      found.add(item);
    }
  }
  return [...found].join(SEPARATOR);
}

function looseDatesOf(text: string): string {
  const numbers = new Set<number>();
  for (const found of text.matchAll(/\d+/g)) {
    const value = Number(found[0]);
    if (Number.isFinite(value)) {
      numbers.add(value);
    }
  }
  const lower = text.toLowerCase();
  const months = MONTH_PATTERNS.filter(([, pattern]) => pattern.test(lower)).map(([word]) => word);
  return `${months.join(" ")} ${[...numbers].join(" ")}`;
}

const remembered = new Map<string, TranscriptIndex>();

/** The transcript read once. Remembered by its text, so the checks, the guards and a repair round share it. */
export function indexTranscript(text: string): TranscriptIndex {
  const known = remembered.get(text);
  if (known) {
    return known;
  }
  const amountsByLocale = new Map<AppLocale, string>();
  const index: TranscriptIndex = {
    strictDates: distinct(text, (line) => findDateTimeMentions(line).map((mention) => mention.text)),
    looseDates: looseDatesOf(text),
    amounts(locale) {
      const known = amountsByLocale.get(locale);
      if (known !== undefined) {
        return known;
      }
      const read = distinct(text, (line) => amountsIn(line, locale).map((amount) => amount.text));
      amountsByLocale.set(locale, read);
      return read;
    },
  };
  if (remembered.size >= REMEMBERED_TRANSCRIPTS) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) {
      remembered.delete(oldest);
    }
  }
  remembered.set(text, index);
  return index;
}
