/**
 * Verdicts: the bridge from per-item judgements to the harness's `OutputCheck`.
 *
 * A mode judges an output item by item (each fact, each red flag, each action item) and wants two things
 * from the same judgement: a pass/fail the stop gate (`runChecked`) can act on, and a status for every item
 * on screen afterwards (verified, unverified, not in the sources). `judgeCheck` makes the first;
 * `outcomeOf` and `outcomesById` make the second. The types in `../spec` are not changed.
 *
 * Wiring a mode:
 *  1. write `judge(output) => ItemJudgement[]` from the other judges (quote, numbers, dates, scope, ...);
 *  2. `judgeCheck(id, judge, words, { onJudged })` for each check, and hand them to `runChecked`;
 *  3. keep `failingIds` from `onJudged` to aim the repair at the items that failed;
 *  4. after the last round, call `judge(output)` once more and `outcomesById` it, so every item has a status.
 *
 * Pure; no model call.
 */
import type { CheckVerdict, OutputCheck } from "../spec";

/** How an item ended up: its evidence was found, it was not, or the sources do not state it at all. */
export type ItemOutcome = "verified" | "unverified" | "not-in-sources";

/** One judge's finding about one item of the output. */
export type ItemJudgement = {
  /** The item: a fact's field, a red flag's number, an action item's number. */
  readonly id: string;
  readonly ok: boolean;
  /**
   * What is wrong, in one short line, when `ok` is false. It goes into the repair note, so it may quote the
   * output; the summary never keeps it.
   */
  readonly problem?: string;
  /**
   * The model says the sources do not state this item, and nothing contradicts that. Neither a pass nor a
   * fail: the item's outcome is `not-in-sources`.
   */
  readonly absent?: boolean;
};

/** The words of a check's repair note. Fixed English, like every repair note. */
export type JudgeWords = {
  /** Opens the ERROR line; the failing items follow it. */
  readonly error: string;
  readonly why: string;
  /** `{items}` is replaced by the failing item ids. */
  readonly fix: string;
};

export type JudgeCheckOptions = {
  /** Called with every judgement each time the check runs, before the verdict is made. */
  readonly onJudged?: (judgements: readonly ItemJudgement[]) => void;
};

/** How many failing items a repair note names before it says "and N more". */
const MAX_ITEMS_NAMED = 12;
const DEFAULT_PROBLEM = "failed";
const ITEMS_PLACEHOLDER = "{items}";

/** Ids of the items that failed, each once, in order. */
export function failingIds(judgements: readonly ItemJudgement[]): string[] {
  return [...new Set(judgements.filter((judgement) => !judgement.ok).map((judgement) => judgement.id))];
}

function withStop(line: string): string {
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

function failedVerdict(
  check: string,
  words: JudgeWords,
  failing: readonly ItemJudgement[],
): Extract<CheckVerdict, { ok: false }> {
  const named = failing.slice(0, MAX_ITEMS_NAMED);
  const rest = failing.length - named.length;
  const more = rest > 0 ? [`and ${rest} more`] : [];
  const lines = [...named.map((item) => `${item.id}: ${item.problem?.trim() || DEFAULT_PROBLEM}`), ...more];
  const ids = [...named.map((item) => item.id), ...more];
  return {
    ok: false,
    check,
    error: `${words.error} ${withStop(lines.join("; "))}`,
    why: words.why,
    fix: words.fix.replaceAll(ITEMS_PLACEHOLDER, ids.join(", ")),
  };
}

/**
 * An `OutputCheck` that fails when any item judgement fails, with a repair note that names the items and
 * what is wrong with each. A judge that throws is not caught here: the runner counts a throwing check as failed.
 */
export function judgeCheck<T>(
  id: string,
  judge: (output: T) => readonly ItemJudgement[] | Promise<readonly ItemJudgement[]>,
  words: JudgeWords,
  options: JudgeCheckOptions = {},
): OutputCheck<T> {
  return {
    id,
    async run(output) {
      const judgements = await judge(output);
      options.onJudged?.(judgements);
      const failing = judgements.filter((judgement) => !judgement.ok);
      return failing.length === 0 ? { ok: true } : failedVerdict(id, words, failing);
    },
  };
}

/**
 * One item's outcome from every judgement made about it: unverified if anything failed (or nothing was
 * checked), not-in-sources if it is absent and nothing failed, else verified.
 */
export function outcomeOf(judgements: readonly ItemJudgement[]): ItemOutcome {
  if (judgements.length === 0 || judgements.some((judgement) => !judgement.ok)) {
    return "unverified";
  }
  return judgements.some((judgement) => judgement.absent) ? "not-in-sources" : "verified";
}

/** The outcome of each item, from the judgements of every check together. Items come in order of first appearance. */
export function outcomesById(judgements: readonly ItemJudgement[]): ReadonlyMap<string, ItemOutcome> {
  const grouped = new Map<string, ItemJudgement[]>();
  for (const judgement of judgements) {
    grouped.set(judgement.id, [...(grouped.get(judgement.id) ?? []), judgement]);
  }
  return new Map([...grouped].map(([id, group]) => [id, outcomeOf(group)] as const));
}

/** What a run kept of its checks. Ids and pass/fail only: no output text ever goes in it. */
export type VerdictSummary = {
  readonly passed: boolean;
  /** Repair rounds spent; 0 when the first output passed. */
  readonly rounds: number;
  readonly verdicts: ReadonlyArray<{ readonly check: string; readonly ok: boolean }>;
};

/** Summarise a `runChecked` result, in the order of `checks`. A check with no verdict counts as failed. */
export function summarizeVerdicts(
  checks: readonly { readonly id: string }[],
  result: { readonly verdicts: readonly CheckVerdict[]; readonly rounds: number; readonly passed: boolean },
): VerdictSummary {
  return {
    passed: result.passed,
    rounds: result.rounds,
    verdicts: checks.map((check, index) => ({ check: check.id, ok: result.verdicts[index]?.ok ?? false })),
  };
}
