import { EDIT_HARNESS_SKILLS } from "../../edit/harness";
import { EDIT_TOOLS } from "../../tools/edit/tools";
import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * The live edit agent binds every edit tool (`edit/agent-run.ts` through `editAgentBindings`).
 *
 * The skills are declared beside their checks in `edit/harness.ts`. A method-free sentence is run by
 * the host before the model loop (`runEditHarness`, `host/src/edit/harness-run.ts`), through the same
 * edit tools in this list: `remove_silence`, `split_at_scenes`, `add_title`, `add_caption`, `generate_image`,
 * `generate_video`, `propose_plan` and `export`. A made shot is charged against the per-turn dollar cap
 * (`edit/budget.ts`) before it starts. Its one retry (a looser silence or scene probe, a second word or
 * export start) is inline, not a `runChecked` round, so `repairRounds` stays 0.
 */
export const editHarnessSpec: ModeHarnessSpec = {
  mode: "edit",
  loop: "agent",
  tools: EDIT_TOOLS.map((tool) => tool.key),
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 0,
  skills: EDIT_HARNESS_SKILLS,
};
