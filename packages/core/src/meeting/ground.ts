import { amountsIn, findDateTimeMentions, numbersTraced } from "../harness/judges";
import type { AppLocale } from "../locale";
import { meetingMinutesSchema, type MeetingMinutes } from "./minutes";
import { untracedDates } from "./said-dates";
import { DIRECT_READ_CHARS, indexTranscript } from "./transcript-index";

export { untracedDates } from "./said-dates";

/** Stamped over a number the transcript never said. A marker, not a figure. */
export const FIGURE_NOT_SAID = "[figure not said]";

const FIGURE = /\d+(?:[.,]\d+)*%?/g;

export type GroundingResult = {
  minutes: MeetingMinutes;
  /** Non-empty date fields cleared because the transcript never said them. */
  clearedDates: number;
  /** Number tokens replaced with `FIGURE_NOT_SAID`. */
  replacedFigures: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The numeric core, so `2.1` and `2,1` are the same figure and a trailing `%` is not part of it. */
function figureCores(token: string): string[] {
  const bare = token.replace(/%$/, "");
  const cores = new Set<string>([bare]);
  if (/^\d+[.,]\d+$/.test(bare)) {
    cores.add(bare.includes(",") ? bare.replace(",", ".") : bare.replace(".", ","));
  }
  return [...cores];
}

/**
 * The figure as its own number in the transcript: not a piece of a longer digit run (`12` in `120`), and
 * not the fraction or the group of a bigger number (`5` in `1.5` or `5,000`, `500` in `1.500`).
 */
function ownNumberPattern(core: string): RegExp {
  return new RegExp(`(?<!\\d)(?<!\\d[.,])${escapeRegExp(core)}(?!\\d)(?![.,]\\d)`);
}

/**
 * A figure counts as said when the transcript has it as its own number, or, for anything bigger than a
 * small count or a year, states the same amount another way (`Rp 1,5 miliar` for `1.500.000.000`). A small
 * count is vouched for only by itself.
 */
export function figureSaid(token: string, transcript: string, locale: AppLocale = "en"): boolean {
  if (figureCores(token).some((core) => ownNumberPattern(core).test(transcript))) {
    return true;
  }
  const needsTrace = amountsIn(token.replace(/%$/, ""), locale).some((amount) => !amount.free);
  if (!needsTrace) {
    return false;
  }
  // A long transcript is read once into its amounts (`indexTranscript`), not once per figure.
  const evidence = transcript.length > DIRECT_READ_CHARS ? indexTranscript(transcript).amounts(locale) : transcript;
  return numbersTraced(token, evidence, locale).traced;
}

function normalisedWords(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** A deadline in words ("Friday", "this week") is said when those words are in the transcript as whole words. */
function phraseSaid(phrase: string, transcript: string): boolean {
  const needle = normalisedWords(phrase);
  const haystack = normalisedWords(transcript);
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    const before = haystack.charAt(from - 1);
    const after = haystack.charAt(from + needle.length);
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
      return true;
    }
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
}

/**
 * A date claim counts as said when every date and time in it is one the transcript states (`untracedDates`),
 * and a deadline in words when those words are in the transcript. An empty claim has nothing to prove.
 */
export function dateSaid(claim: string, transcript: string, locale: AppLocale = "en"): boolean {
  const needle = claim.trim();
  if (!needle) {
    return true;
  }
  if (findDateTimeMentions(needle).length > 0) {
    return untracedDates(needle, transcript, locale).length === 0;
  }
  return phraseSaid(needle, transcript);
}

/** Every figure mark in a string, markers included, so two sheets can be compared. */
export function figureMarks(text: string): string[] {
  const marks: string[] = [];
  const markers = text.split(FIGURE_NOT_SAID).length - 1;
  for (let index = 0; index < markers; index += 1) {
    marks.push(FIGURE_NOT_SAID);
  }
  for (const match of text.matchAll(FIGURE)) {
    const [core] = figureCores(match[0]);
    if (core) {
      marks.push(core.includes(",") ? core.replace(",", ".") : core);
    }
  }
  return marks;
}

function replaceFigures(text: string, transcript: string, locale: AppLocale): { text: string; replaced: number } {
  let replaced = 0;
  const next = text.replace(FIGURE, (token) => {
    if (figureSaid(token, transcript, locale)) {
      return token;
    }
    replaced += 1;
    return FIGURE_NOT_SAID;
  });
  return { text: next.replace(/[ \t]{2,}/g, " ").trim(), replaced };
}

/**
 * Clear a date the transcript never said, and replace a figure it never said. Names are not this
 * function's job. Nothing here asks the model to try again. A decision's or action item's `quote` is the
 * transcript's own words and is never rewritten.
 */
export function guardMinutesGrounding(
  minutes: MeetingMinutes,
  transcript: string,
  locale: AppLocale = "en",
): GroundingResult {
  let clearedDates = 0;
  let replacedFigures = 0;
  const rewrite = (text: string): string => {
    const result = replaceFigures(text, transcript, locale);
    replacedFigures += result.replaced;
    return result.text;
  };
  const heldOn = dateSaid(minutes.heldOn, transcript, locale) ? minutes.heldOn : "";
  if (minutes.heldOn.trim() && !heldOn) {
    clearedDates += 1;
  }
  const attendees = minutes.attendees.map((attendee) => ({ ...attendee, role: rewrite(attendee.role) }));
  const decisions = minutes.decisions.map((decision) => ({
    ...decision,
    statement: rewrite(decision.statement),
    context: rewrite(decision.context),
  }));
  const actionItems = minutes.actionItems.map((item) => {
    const due = dateSaid(item.due, transcript, locale) ? item.due : "";
    if (item.due.trim() && !due) {
      clearedDates += 1;
    }
    return { ...item, task: rewrite(item.task), firstStep: rewrite(item.firstStep), due };
  });
  return {
    minutes: meetingMinutesSchema.parse({
      ...minutes,
      heldOn,
      summary: rewrite(minutes.summary),
      attendees,
      decisions,
      actionItems,
      risks: minutes.risks.map(rewrite),
      openQuestions: minutes.openQuestions.map(rewrite),
    }),
    clearedDates,
    replacedFigures,
  };
}
