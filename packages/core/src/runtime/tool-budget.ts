import { DEFAULT_MAX_STEPS, DEFAULT_RUN_BUDGET } from "../harness/defaults";
import type { BudgetRefusal, RunBudget } from "../harness/spec";

export { DEFAULT_MAX_STEPS };

export type ToolBudget = {
  /**
   * Asks to run one tool call. Returns null and counts the call when it may run; returns the refusal to
   * hand the model, and counts nothing, when the run's total or this tool's own ceiling is spent.
   */
  admit(toolKey: string): BudgetRefusal | null;
};

export function resolveMaxSteps(budget: RunBudget | undefined): number {
  return budget?.maxSteps ?? DEFAULT_MAX_STEPS;
}

function calls(count: number): string {
  return `${count} call${count === 1 ? "" : "s"}`;
}

function refusal(message: string): BudgetRefusal {
  return { ok: false, reason: "budget", message };
}

/**
 * One counter for a whole `execute`. The caller makes it once, ahead of every attempt the run makes
 * (wire fallback, contact retries), so a retry cannot reset the count. The total is checked before the
 * tool's own ceiling.
 */
export function createToolBudget(budget: RunBudget | undefined): ToolBudget {
  // No budget passed no longer means "admit all": the default budget always applies, so a runtime
  // or a mode that forgets its own numbers is still inside a ceiling (F7a).
  budget ??= DEFAULT_RUN_BUDGET;
  let total = 0;
  const perTool = new Map<string, number>();
  return {
    admit(toolKey) {
      if (total >= budget.maxToolCalls) {
        return refusal(
          `Tool budget spent: this run allows ${calls(budget.maxToolCalls)} in all and they have run. Do not call more tools; answer with what you have.`,
        );
      }
      const used = perTool.get(toolKey) ?? 0;
      const cap = budget.perTool && Object.hasOwn(budget.perTool, toolKey) ? budget.perTool[toolKey] : undefined;
      if (cap !== undefined && used >= cap) {
        return refusal(
          `Tool budget spent for ${toolKey}: this run allows ${calls(cap)} to it and they have run. Use another tool or answer with what you have.`,
        );
      }
      total += 1;
      perTool.set(toolKey, used + 1);
      return null;
    },
  };
}
