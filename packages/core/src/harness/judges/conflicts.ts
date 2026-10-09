/**
 * Conflicts between facts: two documents (or two places in one) that give different values for the same
 * thing, such as two effective dates or two payment amounts.
 *
 * This only reports. Which of the values is right is a question for the person reading, and the model is
 * never asked to pick, so a conflict is shown beside both values and where each came from.
 * Pure; no model call.
 */
import type { AppLocale } from "../../locale";
import { type Amount, type NumberTolerance, amountsIn, amountsMatch } from "./numbers";
import { durationMonths, findDateTimeMentions, sameDate } from "./dates";
import { normaliseForMatch } from "./normalise";

/**
 * How the values of a key are compared:
 *  - `amount`: the first figure in each value (`Rp 1,5 miliar` and `Rp 1.500.000.000` agree);
 *  - `date`: the first date in each value (`14 Agustus 2026` and `2026-08-14` agree);
 *  - `duration`: months, years and quarters (`12 months` and `1 year` agree);
 *  - `text`: case, spacing and quote style are ignored, and one value containing the other agrees.
 * A value that holds no amount, date or duration is compared as text.
 */
export type ConflictKind = "amount" | "date" | "duration" | "text";

export type ConflictFact = {
  /** What the value is a value of: "effective-date", "payment", ... */
  readonly key: string;
  readonly value: string;
  /** Where the value came from, usually a document id. Optional. */
  readonly source?: string;
};

export type ConflictValue = {
  /** The first value written in this group. */
  readonly value: string;
  /** Every source that gave a value in this group, in order, each once. */
  readonly sources: readonly string[];
};

export type Conflict = {
  readonly key: string;
  readonly kind: ConflictKind;
  /** One entry per group of values that agree; there are at least two. */
  readonly values: readonly ConflictValue[];
};

export type ConflictOptions = {
  /** How alike two amounts must be to agree. Default `exact`; `rounded` is the Finance guard's half percent. */
  readonly tolerance?: NumberTolerance;
};

/** A value shorter than this is not accepted as "contained in" another: "no" is in "not allowed". */
const CONTAINMENT_MIN_CHARS = 6;
const DURATION_EPSILON = 1e-6;

type Reading = {
  readonly fact: ConflictFact;
  readonly amount: Amount | null;
  readonly months: number | null;
  readonly hasDate: boolean;
  readonly text: string;
};

function firstAmount(value: string, locale: AppLocale): Amount | null {
  const amounts = amountsIn(value, locale);
  return amounts.find((amount) => !amount.free) ?? amounts[0] ?? null;
}

function readingOf(fact: ConflictFact, kind: ConflictKind, locale: AppLocale): Reading {
  return {
    fact,
    amount: kind === "amount" ? firstAmount(fact.value, locale) : null,
    months: kind === "duration" ? durationMonths(fact.value) : null,
    hasDate: kind === "date" && findDateTimeMentions(fact.value).some((mention) => mention.kind !== "clock"),
    text: normaliseForMatch(fact.value, { foldCase: true }).value,
  };
}

function sameText(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= CONTAINMENT_MIN_CHARS && ` ${long} `.includes(` ${short} `);
}

function agree(
  kind: ConflictKind,
  left: Reading,
  right: Reading,
  locale: AppLocale,
  tolerance: NumberTolerance,
): boolean {
  switch (kind) {
    case "amount":
      if (left.amount && right.amount) {
        return amountsMatch(left.amount, right.amount, tolerance);
      }
      return !left.amount && !right.amount && sameText(left.text, right.text);
    case "duration":
      if (left.months !== null && right.months !== null) {
        return Math.abs(left.months - right.months) < DURATION_EPSILON;
      }
      return left.months === null && right.months === null && sameText(left.text, right.text);
    case "date":
      if (left.hasDate && right.hasDate) {
        return sameDate(left.fact.value, right.fact.value, locale);
      }
      return !left.hasDate && !right.hasDate && sameText(left.text, right.text);
    case "text":
      return sameText(left.text, right.text);
  }
}

type Group = { readonly lead: Reading; readonly members: ConflictFact[] };

function groupFacts(
  facts: readonly ConflictFact[],
  kind: ConflictKind,
  locale: AppLocale,
  tolerance: NumberTolerance,
): Group[] {
  const groups: Group[] = [];
  for (const fact of facts) {
    const reading = readingOf(fact, kind, locale);
    const home = groups.find((group) => agree(kind, group.lead, reading, locale, tolerance));
    if (home) {
      home.members.push(fact);
    } else {
      groups.push({ lead: reading, members: [fact] });
    }
  }
  return groups;
}

function sourcesOf(members: readonly ConflictFact[]): string[] {
  return [
    ...new Set(members.map((member) => member.source).filter((source): source is string => source !== undefined)),
  ];
}

/**
 * The keys whose facts do not all agree. `kindOf` says how each key's values are compared. Facts with a
 * blank value are skipped (a field the documents do not state is not a conflict). Conflicts come back in
 * order of the first fact of each key.
 */
export function findConflicts(
  facts: readonly ConflictFact[],
  kindOf: (key: string) => ConflictKind,
  locale: AppLocale,
  options: ConflictOptions = {},
): Conflict[] {
  const tolerance = options.tolerance ?? "exact";
  const byKey = new Map<string, ConflictFact[]>();
  for (const fact of facts) {
    if (fact.value.trim() !== "") {
      byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);
    }
  }
  const conflicts: Conflict[] = [];
  for (const [key, keyFacts] of byKey) {
    const kind = kindOf(key);
    const groups = groupFacts(keyFacts, kind, locale, tolerance);
    if (groups.length > 1) {
      conflicts.push({
        key,
        kind,
        values: groups.map((group) => ({
          value: (group.members[0] as ConflictFact).value,
          sources: sourcesOf(group.members),
        })),
      });
    }
  }
  return conflicts;
}
