import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * One outline call, then single-slide rewrites (`presentation-generate.ts`); no tools bound.
 * The outline is checked for its slide count, an empty or repeated slide and text that overflows
 * the exported slide (`presentation-checks.ts`), with one repair round before it is returned as is.
 * Open Slide decks are not checked: they have no headings or bullets to look at.
 */
export const presentationsHarnessSpec: ModeHarnessSpec = {
  mode: "presentations",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "generate-outline", name: "Generate the outline", status: "has" },
    { id: "rewrite-one-slide", name: "Rewrite one slide", status: "has" },
    { id: "download-pptx", name: "Download the PPTX", status: "has" },
    { id: "edit-text", name: "Edit text", status: "new" },
    { id: "add-shapes", name: "Add shapes", status: "new" },
  ],
};
