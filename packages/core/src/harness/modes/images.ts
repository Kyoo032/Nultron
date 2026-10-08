import { IMAGES_HARNESS_SKILLS } from "../../images/harness";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * A generation endpoint call, no model loop (`studio-generate.ts` `imageGenerateTool.execute`).
 *
 * The skills are declared beside their checks in `images/harness.ts`. `generateStudioImage` runs
 * them through `runImageSkills`: a one-still brief, a frame chosen from the sentence when the menu
 * was not touched, a refusal of a model that does not make images, and one retry when the call
 * never reached the gateway. That retry is inline, with no repair note and no `job.round` event,
 * so `repairRounds` stays 0.
 */
export const imagesHarnessSpec: ModeHarnessSpec = {
  mode: "images",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: IMAGES_HARNESS_SKILLS,
};
