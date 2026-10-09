/**
 * One shared allowance of extra model calls for one Finance run.
 *
 * A write-up is one model call: the narrative. Three things can ask for more — a reading that did not
 * come back as sections (asked once more), a section the number guard blanked (rewritten), and a
 * section that said the opposite of a computed direction or gave advice (rewritten). Each used to take
 * its own call, section by section, so one narrative could fan out into many. They now draw on one
 * budget: the first to ask gets the call, every later one is refused and falls back to what code can
 * do on its own (take the sentence out, say so, carry on).
 *
 * The budget is a counter by nature, so this is the one place in Finance that holds state; it holds
 * nothing but numbers and is made fresh for every run.
 */

/** The extra calls a run may make beyond the narrative. */
export const EXTRA_CALLS_MAX = 1;

/** Said once when the run's one extra call was spent and a later check had to be handled in code. */
export const BUDGET_SPENT_STEP = "The one extra model call was already used; the rest was handled in code";

export type CallBudget = {
  /** Ask for the next extra call. True when it is granted (and now spent), false when none is left. */
  take(): boolean;
  /** Extra calls the run may still make. */
  readonly remaining: number;
  /** Extra calls granted so far. */
  readonly used: number;
  /** Times a caller asked and was refused, so the desk can say a rewrite was not attempted. */
  readonly refused: number;
};

/** A budget of `extra` calls (a whole number, never negative). Each run makes its own. */
export function createCallBudget(extra: number = EXTRA_CALLS_MAX): CallBudget {
  const total = Number.isFinite(extra) ? Math.max(0, Math.floor(extra)) : 0;
  let used = 0;
  let refused = 0;
  return {
    take(): boolean {
      if (used >= total) {
        refused += 1;
        return false;
      }
      used += 1;
      return true;
    },
    get remaining(): number {
      return total - used;
    },
    get used(): number {
      return used;
    },
    get refused(): number {
      return refused;
    },
  };
}

/**
 * Ask for an extra call when there is a budget to ask; with none, the caller is outside a Finance run
 * (a test, a one-off script) and is not limited.
 */
export function takeExtraCall(budget: CallBudget | undefined): boolean {
  return budget === undefined ? true : budget.take();
}
