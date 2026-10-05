import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/** A generation endpoint call plus a poll, no model loop (`studio-generate.ts` `videoGenerateTool.execute`). */
export const videosHarnessSpec: ModeHarnessSpec = {
  mode: "videos",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: [
    { id: "generate-clip", name: "Generate a clip", status: "has" },
    { id: "start-from-still", name: "Start from a still", status: "has" },
    { id: "bill-snapped-length", name: "Bill the snapped length", status: "has" },
    { id: "estimate-and-tighten", name: "Estimate the cost and tighten the prompt", status: "has" },
    { id: "keep-gallery", name: "Keep the gallery", status: "has" },
  ],
};
