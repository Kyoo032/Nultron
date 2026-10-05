import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * A relay call with no model loop (`studio-generate.ts` `musicGenerateTool.execute`). The lyrics
 * draft is its own flat-rate tool call from the host (`lyricsWriteTool.execute`), not a tool the
 * model chooses.
 */
export const musicHarnessSpec: ModeHarnessSpec = {
  mode: "music",
  loop: "media",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: [
    { id: "describe-song", name: "Describe a song", status: "has" },
    { id: "desk-lyrics", name: "Use the desk's lyrics", status: "has" },
    { id: "draft-lyrics", name: "Draft lyrics first", status: "has" },
    { id: "keep-both-takes", name: "Keep both takes", status: "has" },
    { id: "speak-text", name: "Speak the text", status: "off" },
  ],
};
