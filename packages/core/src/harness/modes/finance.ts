import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Figures come from core maths and the model only names and narrates, so there is no tool loop
 * (`finance-tasks/runner.ts`). One repair round: a section with an untraceable figure is asked for
 * once more, then the sentence is cut (`finance-section-repair.ts` `repairUnverifiedSections`).
 * Two more passes sit beside it and do not raise `repairRounds`, because each is a single fixed
 * step and none is a loop: a reading that did not come back as sections is asked for once more with
 * the same facts (`finance-tasks/reading.ts`), and a sentence that quotes a computed figure while
 * saying the opposite of its direction is rewritten once, then cut (`finance-tasks/direction.ts`).
 * A cancelled job gets neither a second ask nor a rewrite.
 */
export const financeHarnessSpec: ModeHarnessSpec = {
  mode: "finance",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "financial-brief", name: "Financial brief", status: "has" },
    { id: "cash-flow", name: "Cash flow and runway", status: "has" },
    { id: "budget-versus-actual", name: "Budget versus actual", status: "has" },
    { id: "investment-appraisal", name: "Investment appraisal", status: "has" },
    { id: "ratio-health", name: "Ratio health check", status: "has" },
  ],
};
