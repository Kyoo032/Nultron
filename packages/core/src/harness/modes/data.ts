import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_STEPS } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * The model queries the attached table in a tool loop (`data-generate.ts` binds `run_sql`, `calculator`
 * and `run_code`). `run_sql` stops at 8 queries a job: `SQL_STEP_CAP` in `packages/host/src/sql-tool.ts`,
 * which core cannot import, so the number is repeated here.
 *
 * `run_code` 4: it is only for exploration the SQL cannot express (a regression, a distribution). It
 * cannot see the dataset, only desk files, and its output is never evidence, so four runs are a couple of
 * experiments with one fix each. Each run can take up to 30 s.
 */
export const dataHarnessSpec: ModeHarnessSpec = {
  mode: "data",
  loop: "agent",
  tools: ["run_sql", "calculator", "run_code"],
  budget: {
    maxSteps: DEFAULT_MAX_STEPS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    perTool: { run_sql: 8, run_code: 4 },
  },
  repairRounds: 0,
  skills: [
    { id: "take-table", name: "Take the table in", status: "has" },
    { id: "private-database", name: "Load a private database", status: "has" },
    { id: "query-do-not-guess", name: "Query, do not guess", status: "has" },
    { id: "show-evidence", name: "Show the evidence", status: "has" },
    { id: "follow-up", name: "Ask a follow-up", status: "has" },
  ],
};
