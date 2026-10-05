import { MUSIC_HARNESS_SKILLS } from "../../music/harness";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * A relay call with no model loop (`studio-generate.ts` `musicGenerateTool.execute`). The lyrics
 * draft is its own flat-rate tool call from the host (`lyricsWriteTool.execute`), not a tool the
 * model chooses.
 *
 * The skills are declared beside their checks in `music/harness.ts`. Their one-retry rules
 * (`shouldRetryLyrics`, `shouldRetryMusicJob`) run inline in `studio-generate.ts`, not through
 * `runChecked`: a blank job or a one-line draft is submitted once more, with no repair note and no
 * `job.round` event, so `repairRounds` stays 0.
 */
export const musicHarnessSpec: ModeHarnessSpec = {
  mode: "music",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: MUSIC_HARNESS_SKILLS,
};
