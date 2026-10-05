import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Figures come from core maths and the model only names and narrates, so there is no tool loop
 * (`finance-tasks/runner.ts`). One repair round: a section with an untraceable figure is asked for
 * once more, then the sentence is cut (`finance-section-repair.ts` `repairUnverifiedSections`).
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
