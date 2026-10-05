import { LEGAL_CAPS } from "../../legal/types";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * A matter runs classify, review and draft stages, then verify and edit rounds, all in host code
 * (`legal/run.ts` `runLegalMatter`); no tools bound. `maxRounds` counts the verify passes, so the
 * first is not a repair: `legal/run.ts:876` edits at most `maxRounds - 1` times.
 */
export const legalHarnessSpec: ModeHarnessSpec = {
  mode: "legal",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: LEGAL_CAPS.maxRounds,
  skills: [
    { id: "open-matter", name: "Open the matter", status: "has" },
    { id: "diff-prior-turn", name: "Diff the prior turn", status: "has" },
    { id: "review-playbook", name: "Review against the playbook", status: "has" },
    { id: "verify-then-edit", name: "Verify, then edit", status: "has" },
    { id: "deliver-set", name: "Deliver the set", status: "has" },
  ],
};
