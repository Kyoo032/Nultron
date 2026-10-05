import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Transcribe, then one minutes call, then an optional translation call (`meeting/run.ts`); no tools bound.
 * The minutes call alone runs through `runChecked` (`meeting/minutes-checks.ts`) with one repair round;
 * transcription and translation are not checked.
 */
export const meetingHarnessSpec: ModeHarnessSpec = {
  mode: "meeting",
  loop: "pipeline",
  tools: [],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "capture-meeting", name: "Capture the meeting", status: "has" },
    { id: "transcribe", name: "Transcribe", status: "has" },
    { id: "write-minutes", name: "Write the minutes", status: "has" },
    { id: "guard-names", name: "Guard the names", status: "has" },
    { id: "translate-minutes", name: "Translate the minutes", status: "has" },
  ],
};
