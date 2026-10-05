import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/** A generation endpoint call, no model loop (`studio-generate.ts` `imageGenerateTool.execute`). */
export const imagesHarnessSpec: ModeHarnessSpec = {
  mode: "images",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: [
    { id: "generate-still", name: "Generate a still", status: "has" },
    { id: "choose-frame", name: "Choose the frame", status: "has" },
    { id: "estimate-cost", name: "Estimate the cost", status: "has" },
    { id: "tighten-prompt", name: "Tighten the prompt", status: "has" },
    { id: "keep-gallery", name: "Keep the gallery", status: "has" },
  ],
};
