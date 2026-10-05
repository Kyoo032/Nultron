import { VIDEO_HARNESS_SKILLS } from "../../videos/harness";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * A generation endpoint call plus a poll, no model loop (`studio-generate.ts` `videoGenerateTool.execute`).
 *
 * The skills are declared beside their checks in `videos/harness.ts`. Its one retry runs inline in
 * `runVideoHarness`, not through `runChecked`: a render that died before a video file is submitted
 * once more with no repair note and no `job.round` event, so `repairRounds` stays 0.
 */
export const videosHarnessSpec: ModeHarnessSpec = {
  mode: "videos",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: VIDEO_HARNESS_SKILLS,
};
