/**
 * Meeting mode — what the minutes must pass before they are done.
 *
 * `runChecked` (`../harness/run-checked.ts`) hands these checks the model's draft and, on a
 * failure, sends the FIX text back for one more try (`repairRounds` in the meeting spec). Every
 * check is conservative on purpose: it fires only on something a reader could prove wrong from the
 * transcript alone, and it names the exact item, so a normal set of minutes never costs a second
 * model call. `guardMinutesNames` still runs after the checks and stays the last word on names.
 *
 * The date reader and the evidence judges are the shared ones in `@agentforge/core/judges` and
 * `@agentforge/core/meeting` (`evidence.ts`); this file only wires them to the minutes draft.
 */

import { ApiError, type AppLocale } from "@agentforge/core";
import { judgeCheck, summarizeVerdicts, type ItemJudgement, type VerdictSummary } from "@agentforge/core/judges";
import {
  judgeMinutesEvidence,
  MINUTES_EVIDENCE_WORDS,
  meetingMinutesSchema,
  nameAppearsInTranscript,
  NEEDS_OWNER,
  untracedDates,
  withoutMarks,
  type MeetingMinutes,
} from "@agentforge/core/meeting";
import type { CheckVerdict, OutputCheck } from "@agentforge/core/harness";
import { extractJsonObject } from "../presentation-outline";

// The reader now lives with the other judges; the old name stays importable from here.
export { findDateTimeMentions, type DateTimeMention } from "@agentforge/core/judges";

/** A transcript of this many words or fewer is a greeting or a test clip; a summary is not demanded of it. */
export const TRIVIAL_TRANSCRIPT_WORDS = 20;

export const MINUTES_CHECK_IDS = {
  shape: "minutes-shape",
  owners: "action-owners",
  dates: "quoted-dates",
  summary: "summary-present",
  evidence: "minutes-evidence",
} as const;

/** What one model answer turned into: the minutes, or the reason there are none. */
export type ParsedMinutes =
  | { readonly ok: true; readonly minutes: MeetingMinutes }
  | {
      readonly ok: false;
      /** The `ApiError` code the run throws if the repair does not fix it. */
      readonly code: "generation_failed" | "invalid_minutes";
      /** The `ApiError` message, unchanged from before the checks existed. */
      readonly message: string;
      /** What the repair note tells the model, with the field paths the message leaves out. */
      readonly detail: string;
    };

/** A check on a draft. Synchronous, which is narrower than `OutputCheck`, so a test can read its verdict directly. */
export type MinutesCheck = { readonly id: string; run(draft: MinutesDraft): CheckVerdict };

/** One draft of the minutes: the model's own text, who wrote it, and how it parsed. */
export type MinutesDraft = {
  readonly raw: string;
  readonly model: string;
  readonly parsed: ParsedMinutes;
};

export function parseMinutesDraft(raw: string): ParsedMinutes {
  if (!raw.trim()) {
    return {
      ok: false,
      code: "generation_failed",
      message: "The model returned no minutes",
      detail: "the answer was empty",
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(raw));
  } catch {
    return {
      ok: false,
      code: "invalid_minutes",
      message: "The model returned invalid JSON for the minutes",
      detail: "the answer is not a single JSON object",
    };
  }
  // `evidence` and `edited` are the code's marks: whatever the model sent under them is dropped, not parsed.
  const result = meetingMinutesSchema.safeParse(withoutMarks(json));
  if (!result.success) {
    return {
      ok: false,
      code: "invalid_minutes",
      message: `Minutes failed validation: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      detail: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, minutes: result.data };
}

/** The failure the run throws when the minutes never parsed, even after the repair. */
export function minutesParseError(parsed: Extract<ParsedMinutes, { ok: false }>): ApiError {
  return new ApiError(parsed.code, parsed.message, 502);
}

// -- helpers ----------------------------------------------------------------------------------

const PASS: CheckVerdict = { ok: true };
const QUOTE_MAX = 70;

function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat}"`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Runs `inspect` on the parsed minutes, and passes a draft that never parsed: the shape check owns that. */
function onMinutes(id: string, inspect: (minutes: MeetingMinutes) => CheckVerdict): MinutesCheck {
  return {
    id,
    run: (draft) => (draft.parsed.ok ? inspect(draft.parsed.minutes) : PASS),
  };
}

// -- (a) shape --------------------------------------------------------------------------------

/** The answer is the minutes JSON: title and summary present, every action item with a task and an owner. */
export const minutesShapeCheck: MinutesCheck = {
  id: MINUTES_CHECK_IDS.shape,
  run: (draft) =>
    draft.parsed.ok
      ? PASS
      : {
          ok: false,
          check: MINUTES_CHECK_IDS.shape,
          error: `The minutes could not be read: ${draft.parsed.detail}.`,
          why: "The minutes are saved and filed from this JSON, so an answer that is not the exact shape cannot be saved.",
          fix: 'Return only the JSON object in the required shape, with no fences or commentary. "title" and "summary" are non-empty strings, and every action item has a non-empty "task" and "owner".',
        },
};

// -- (b) action items -------------------------------------------------------------------------

/**
 * Every action item has a task and an owner, and the owner is a person the transcript names or the
 * explicit `[needs owner]` marker. The name test is `nameAppearsInTranscript`, the same generous one
 * the guard uses (any word of the name, case-insensitive), so this fires on the owners the guard
 * would have stamped over anyway, and lets the model fix them first.
 */
export function actionOwnersCheck(transcript: string): MinutesCheck {
  return onMinutes(MINUTES_CHECK_IDS.owners, (minutes) => {
    const problems: string[] = [];
    const items: string[] = [];
    minutes.actionItems.forEach((item, index) => {
      const label = `action item ${index + 1}${item.task.trim() ? ` (${quoted(item.task)})` : ""}`;
      const owner = item.owner.trim();
      if (!item.task.trim()) {
        problems.push(`${label} has no task`);
        items.push(label);
      } else if (!owner) {
        problems.push(`${label} has no owner`);
        items.push(label);
      } else if (owner !== NEEDS_OWNER && !nameAppearsInTranscript(owner, transcript)) {
        problems.push(`${label} is owned by ${quoted(owner)}, a name the transcript never says`);
        items.push(label);
      }
    });
    if (problems.length === 0) {
      return PASS;
    }
    return {
      ok: false,
      check: MINUTES_CHECK_IDS.owners,
      error: `${problems.join("; ")}.`,
      why: "An action item is only useful with a task and with someone who took it on, and a person the meeting never named cannot own it.",
      fix: `Fix ${items.join(", ")}: give each a task, and set the owner to a person who speaks or is named in the transcript, or to exactly "${NEEDS_OWNER}" when nobody took it on.`,
    };
  });
}

// -- (c) dates and times ----------------------------------------------------------------------

/**
 * No decision or action item quotes a date or time the transcript never says. A date is "said" when the
 * transcript states it, or when a speaker split it across a sentence (day, month name and year each said,
 * the day beside its month); a clock time when its hour (12- or 24-hour) and minutes are. The reader and the
 * rule are `untracedDates` (`@agentforge/core/meeting`), the same one the guard and the evidence check use,
 * so "1 August" is not found in "31 August". Items with no date or time in them are never looked at.
 */
export function quotedDatesCheck(transcript: string, locale: AppLocale = "en"): MinutesCheck {
  return onMinutes(MINUTES_CHECK_IDS.dates, (minutes) => {
    const problems: string[] = [];
    const items: string[] = [];
    const inspect = (label: string, parts: readonly string[]) => {
      const unheard = untracedDates(parts.join("\n"), transcript, locale);
      if (unheard.length > 0) {
        problems.push(`${label} quotes ${unheard.map((mention) => quoted(mention.text)).join(", ")}`);
        items.push(label);
      }
    };
    minutes.decisions.forEach((decision, index) => {
      inspect(`decision ${index + 1} (${quoted(decision.statement)})`, [decision.statement, decision.context]);
    });
    minutes.actionItems.forEach((item, index) => {
      inspect(`action item ${index + 1} (${quoted(item.task)})`, [item.task, item.due, item.firstStep]);
    });
    if (problems.length === 0) {
      return PASS;
    }
    return {
      ok: false,
      check: MINUTES_CHECK_IDS.dates,
      error: `${problems.join("; ")}, which the transcript never says.`,
      why: "Minutes may only carry dates and times the meeting actually said; an invented one gets acted on.",
      fix: `In ${items.join(", ")}, replace each such date or time with what the transcript says, or take it out (leave "due" empty) when nobody stated one. Change nothing else.`,
    };
  });
}

// -- (d) summary ------------------------------------------------------------------------------

/**
 * The summary says something once the transcript is longer than `TRIVIAL_TRANSCRIPT_WORDS`. Twenty
 * words is a greeting or a test clip; anything longer has a point to summarise. A summary of only
 * whitespace or punctuation counts as empty (the schema's `min(1)` lets " " through).
 */
export function summaryPresentCheck(transcript: string): MinutesCheck {
  const words = wordCount(transcript);
  return onMinutes(MINUTES_CHECK_IDS.summary, (minutes) => {
    if (words <= TRIVIAL_TRANSCRIPT_WORDS || /[\p{L}\p{N}]/u.test(minutes.summary)) {
      return PASS;
    }
    return {
      ok: false,
      check: MINUTES_CHECK_IDS.summary,
      error: `The summary is empty, but the transcript is ${words} words long.`,
      why: "The summary is the first thing a reader of the minutes sees.",
      fix: 'Fill "summary" with two or three sentences on what the meeting covered and what it settled, using only what the transcript says.',
    };
  });
}

// -- (e) evidence -----------------------------------------------------------------------------

/**
 * Every decision and action item quotes the transcript, the owner is named within 240 characters of the
 * quote, and the due date is said there (`judgeMinutesEvidence`). A draft that never parsed passes: the
 * shape check owns that. `onJudged` hears every judgement, for a caller that wants to aim the repair.
 */
export function minutesEvidenceCheck(
  transcript: string,
  locale: AppLocale = "en",
  options: { readonly onJudged?: (judgements: readonly ItemJudgement[]) => void } = {},
): OutputCheck<MinutesDraft> {
  return judgeCheck<MinutesDraft>(
    MINUTES_CHECK_IDS.evidence,
    (draft) => (draft.parsed.ok ? judgeMinutesEvidence(draft.parsed.minutes, transcript, locale) : []),
    MINUTES_EVIDENCE_WORDS,
    options,
  );
}

// -- the set ----------------------------------------------------------------------------------

/**
 * The checks for one meeting, in the order the repair note lists them. `locale` is the language the meeting
 * was spoken in, which decides how an ambiguous date or a magnitude word is read.
 */
export function buildMinutesChecks(
  transcript: string,
  locale: AppLocale = "en",
  options: { readonly onEvidenceJudged?: (judgements: readonly ItemJudgement[]) => void } = {},
): readonly OutputCheck<MinutesDraft>[] {
  return [
    minutesShapeCheck,
    actionOwnersCheck(transcript),
    quotedDatesCheck(transcript, locale),
    summaryPresentCheck(transcript),
    minutesEvidenceCheck(transcript, locale, { onJudged: options.onEvidenceJudged }),
  ];
}

/** What a run kept of its checks. Ids and pass/fail only: the artifact meta is not encrypted, so no minutes text goes in it. */
export type MinutesChecksSummary = VerdictSummary;

export function summarizeMinutesChecks(
  checks: readonly { readonly id: string }[],
  result: { readonly verdicts: readonly CheckVerdict[]; readonly rounds: number; readonly passed: boolean },
): MinutesChecksSummary {
  return summarizeVerdicts(checks, result);
}

/** The first prompt plus, on a repair, the draft that failed and the note on what to fix. */
export function minutesRepairPrompt(base: string, previousRaw: string, note: string): string {
  return [base, "Your previous answer:", previousRaw.trim() || "(empty)", note].join("\n\n");
}
