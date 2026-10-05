import { EDIT_TOOLS } from "../../tools/edit/tools";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/** The live edit agent binds every edit tool (`edit/agent-run.ts` through `editAgentBindings`). */
export const editHarnessSpec: ModeHarnessSpec = {
  mode: "edit",
  loop: "agent",
  tools: EDIT_TOOLS.map((tool) => tool.key),
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: [
    { id: "cut-timeline", name: "Cut the timeline", status: "has" },
    { id: "clean-sound", name: "Clean the sound", status: "has" },
    { id: "title-and-caption", name: "Title and caption", status: "has" },
    { id: "generate-onto-timeline", name: "Generate onto the timeline", status: "has" },
    { id: "export", name: "Export", status: "has" },
  ],
};
