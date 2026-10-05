import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * One draft call, then single-section rewrites (`document-generate.ts`); no tools bound. The draft
 * passes a structure check and, when it has source material, a grounding check
 * (`host/src/documents-checks.ts`); a failure gets one repair round and then ships flagged. With
 * source material, code then deletes any sentence the source still does not support
 * (`documents/source-hold.ts`); that step calls no model and the checks run again on its result.
 */
export const documentsHarnessSpec: ModeHarnessSpec = {
  mode: "documents",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "draft-sections", name: "Draft the sections", status: "has" },
    { id: "stay-inside-source", name: "Stay inside the source", status: "has" },
    { id: "rewrite-one-section", name: "Rewrite one section", status: "has" },
    { id: "preview-and-download", name: "Preview and download", status: "has" },
    { id: "check-against-source", name: "Check the draft against the source", status: "new" },
  ],
};
