/**
 * Meeting mode — what the minutes must pass before they are done.
 *
 * `runChecked` (`../harness/run-checked.ts`) hands these checks the model's draft and, on a
 * failure, sends the FIX text back for one more try (`repairRounds` in the meeting spec). Every
 * check is conservative on purpose: it fires only on something a reader could prove wrong from the
 * transcript alone, and it names the exact item, so a normal set of minutes never costs a second
 * model call. `guardMinutesNames` still runs after the checks and stays the last word on names.
 */

import { ApiError } from "@agentforge/core";
import {
  meetingMinutesSchema,
  nameAppearsInTranscript,
  NEEDS_OWNER,
  type MeetingMinutes,
} from "@agentforge/core/meeting";
import type { CheckVerdict } from "@agentforge/core/harness";
import { extractJsonObject } from "../presentation-outline";

/** A transcript of this many words or fewer is a greeting or a test clip; a summary is not demanded of it. */
export const TRIVIAL_TRANSCRIPT_WORDS = 20;

export const MINUTES_CHECK_IDS = {
  shape: "minutes-shape",
  owners: "action-owners",
  dates: "quoted-dates",
  summary: "summary-present",
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
  const result = meetingMinutesSchema.safeParse(json);
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

type Heard = { readonly numbers: ReadonlySet<number>; readonly months: ReadonlySet<number> };

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

/** Every date and time the text quotes, in the forms the minutes writer uses. Plain weekdays and "next week" are not dates here. */
export function findDateTimeMentions(text: string): DateTimeMention[] {
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
  return [
    ...iso.found,
    ...numeric.found,
    ...dayFirst.found,
    ...monthFirst.found,
    ...indonesianClock.found,
    ...clock.found,
  ];
}

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
  const twelve = hour % 12;
  return [hour, twelve === 0 ? 12 : twelve, twelve + 12, hour === 24 ? 0 : hour];
}

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
      const part = (value: number) => has(value) || (value >= 1 && value <= 12 && heard.months.has(value));
      const year = mention.year;
      const yearHeard = year === null || has(year) || (year < 100 && has(2000 + year));
      return mention.numbers.every(part) && yearHeard;
    }
  }
}

/**
 * No decision or action item quotes a date or time the transcript never says. A date is "said" when
 * its numbers appear as numbers in the transcript and its month appears by name (English or
 * Indonesian, any case); a clock time when its hour (12- or 24-hour) and minutes do. Items with no
 * date or time in them are never looked at.
 */
export function quotedDatesCheck(transcript: string): MinutesCheck {
  const heard = whatWasHeard(transcript);
  return onMinutes(MINUTES_CHECK_IDS.dates, (minutes) => {
    const problems: string[] = [];
    const items: string[] = [];
    const inspect = (label: string, parts: readonly string[]) => {
      const unheard = findDateTimeMentions(parts.join("\n")).filter((mention) => !isHeard(mention, heard));
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

// -- the set ----------------------------------------------------------------------------------

/** The checks for one meeting, in the order the repair note lists them. */
export function buildMinutesChecks(transcript: string): readonly MinutesCheck[] {
  return [
    minutesShapeCheck,
    actionOwnersCheck(transcript),
    quotedDatesCheck(transcript),
    summaryPresentCheck(transcript),
  ];
}

/** What a run kept of its checks. Ids and pass/fail only: the artifact meta is not encrypted, so no minutes text goes in it. */
export type MinutesChecksSummary = {
  readonly passed: boolean;
  /** Repair rounds spent; 0 when the first draft passed. */
  readonly rounds: number;
  readonly verdicts: ReadonlyArray<{ readonly check: string; readonly ok: boolean }>;
};

export function summarizeMinutesChecks(
  checks: readonly MinutesCheck[],
  result: { readonly verdicts: readonly CheckVerdict[]; readonly rounds: number; readonly passed: boolean },
): MinutesChecksSummary {
  return {
    passed: result.passed,
    rounds: result.rounds,
    verdicts: checks.map((check, index) => ({ check: check.id, ok: result.verdicts[index]?.ok ?? false })),
  };
}

/** The first prompt plus, on a repair, the draft that failed and the note on what to fix. */
export function minutesRepairPrompt(base: string, previousRaw: string, note: string): string {
  return [base, "Your previous answer:", previousRaw.trim() || "(empty)", note].join("\n\n");
}
