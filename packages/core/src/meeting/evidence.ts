/**
 * Meeting mode: does the transcript back each decision and action item?
 *
 * The writer is asked to copy, word for word, the sentence where something was agreed or taken on
 * (`quote`). Code then checks three things, and the model is never asked to vouch for itself:
 *  1. the quote is in the transcript (`matchQuote`: exact, then normalised, then case-folded, then elided);
 *  2. an action item's owner is named within `EVIDENCE_WINDOW_CHARS` of the quote, on either side;
 *  3. its due date is said in that same window.
 *
 * `judgeMinutesEvidence` gives one judgement per item, for the `minutes-evidence` check the stop gate runs
 * (`host/src/meeting/minutes-checks.ts`). `markMinutesEvidence` gives each item its final `evidence` status
 * once the repair round is over: an item that still fails is marked unverified, never dropped.
 *
 * Pure: no model call, no clock, no file access.
 */
import {
  DEFAULT_WINDOW_CHARS,
  type ItemJudgement,
  type JudgeWords,
  QUOTE_MIN_CHARS,
  createQuoteIndex,
  normaliseForMatch,
  outcomesById,
  windowAround,
} from "../harness/judges";
import type { AppLocale } from "../locale";
import { dateSaid } from "./ground";
import { nameAppearsInTranscript } from "./guard";
import { meetingMinutesSchema, NEEDS_OWNER, type MeetingMinutes } from "./minutes";

/** How far either side of the quote the owner and the due date may be said. */
export const EVIDENCE_WINDOW_CHARS = DEFAULT_WINDOW_CHARS;

const QUOTE_SHOWN_CHARS = 70;
const TRANSCRIPT_SOURCE = "transcript";

/** The id a judgement and a repair note use for the n-th decision or action item (1-based). */
export function minutesItemId(kind: "decision" | "action", index: number): string {
  return `${kind}-${index + 1}`;
}

function shown(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > QUOTE_SHOWN_CHARS ? `${flat.slice(0, QUOTE_SHOWN_CHARS - 1)}…` : flat}"`;
}

type Quoted = { readonly quote: string };
type QuoteIndex = ReturnType<typeof createQuoteIndex>;

/** Where the quote sits in the transcript: its surrounding passage, or why there is none. */
function passageOf(
  item: Quoted,
  index: QuoteIndex,
  transcript: string,
): { readonly passage: string } | { readonly problem: string } {
  const quote = item.quote.trim();
  if (!quote) {
    return { problem: "no quote: copy the exact words where it was agreed" };
  }
  if (normaliseForMatch(quote).value.length < QUOTE_MIN_CHARS) {
    return {
      problem: `the quote ${shown(quote)} is too short to check: copy the whole sentence (at least ${QUOTE_MIN_CHARS} characters)`,
    };
  }
  const found = index.match(quote, TRANSCRIPT_SOURCE);
  if (!found) {
    return { problem: `the quote ${shown(quote)} is not in the transcript` };
  }
  return { passage: windowAround(transcript, found.start, found.end, EVIDENCE_WINDOW_CHARS) };
}

function actionProblems(item: MeetingMinutes["actionItems"][number], passage: string, locale: AppLocale): string[] {
  const problems: string[] = [];
  const owner = item.owner.trim();
  if (owner !== "" && owner !== NEEDS_OWNER && !nameAppearsInTranscript(owner, passage)) {
    problems.push(`the owner ${shown(owner)} is not named within ${EVIDENCE_WINDOW_CHARS} characters of the quote`);
  }
  if (item.due.trim() !== "" && !dateSaid(item.due, passage, locale)) {
    problems.push(
      `the due date ${shown(item.due)} is not said within ${EVIDENCE_WINDOW_CHARS} characters of the quote`,
    );
  }
  return problems;
}

function judgement(id: string, problems: readonly string[]): ItemJudgement {
  return problems.length === 0 ? { id, ok: true } : { id, ok: false, problem: problems.join("; ") };
}

/** One judgement per decision, then one per action item, in the order the minutes list them. */
export function judgeMinutesEvidence(
  minutes: MeetingMinutes,
  transcript: string,
  locale: AppLocale = "en",
): ItemJudgement[] {
  const index = createQuoteIndex([{ id: TRANSCRIPT_SOURCE, text: transcript }]);
  const decisions = minutes.decisions.map((decision, at) => {
    const found = passageOf(decision, index, transcript);
    return judgement(minutesItemId("decision", at), "problem" in found ? [found.problem] : []);
  });
  const actions = minutes.actionItems.map((item, at) => {
    const found = passageOf(item, index, transcript);
    const problems = "problem" in found ? [found.problem] : actionProblems(item, found.passage, locale);
    return judgement(minutesItemId("action", at), problems);
  });
  return [...decisions, ...actions];
}

/**
 * The same minutes with `evidence` set on every decision and action item: verified when the item passes
 * every judgement, unverified otherwise. Never drops an item, never edits its words.
 */
export function markMinutesEvidence(
  minutes: MeetingMinutes,
  transcript: string,
  locale: AppLocale = "en",
): MeetingMinutes {
  const outcomes = outcomesById(judgeMinutesEvidence(minutes, transcript, locale));
  const statusOf = (kind: "decision" | "action", at: number) =>
    outcomes.get(minutesItemId(kind, at)) === "verified" ? ("verified" as const) : ("unverified" as const);
  return meetingMinutesSchema.parse({
    ...minutes,
    decisions: minutes.decisions.map((decision, at) => ({ ...decision, evidence: statusOf("decision", at) })),
    actionItems: minutes.actionItems.map((item, at) => ({ ...item, evidence: statusOf("action", at) })),
  });
}

/** The words of the `minutes-evidence` repair note. Fixed English, like every repair note. */
export const MINUTES_EVIDENCE_WORDS: JudgeWords = {
  error: "These items are not backed by the transcript:",
  why: "Every decision and action item must quote the transcript's own words, so a reader can check that it was said, and by whom.",
  fix: `For {items}: copy word for word, from the transcript, the sentence where it was agreed or taken on into "quote" (at least ${QUOTE_MIN_CHARS} characters, no paraphrase, no ellipsis, never translated), and name the owner and the due date only where that passage says them. If the transcript has no such passage, keep the item and leave "quote" empty. Change nothing else.`,
};
