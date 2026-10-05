import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Host code plans queries, runs the search and reads the pages itself (`research-generate.ts`
 * `webSearchTool.execute`, `fetchPageText`); the model only plans and writes. No tools bound.
 *
 * The drafting stage is checked (`packages/host/src/research-checks.ts`): every finding cites a
 * source, every cited id is one the run was given, no section is empty. A failed check sends the
 * synthesis back once with the exact sections and the allowed ids, so `repairRounds` is 1.
 */
export const researchHarnessSpec: ModeHarnessSpec = {
  mode: "research",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "plan-queries", name: "Plan the queries", status: "has" },
    { id: "search", name: "Search", status: "has" },
    { id: "read-pages", name: "Read the pages", status: "has" },
    { id: "verbatim-passages", name: "Pull verbatim passages", status: "has" },
    { id: "write-dossier", name: "Write the dossier", status: "has" },
  ],
};
