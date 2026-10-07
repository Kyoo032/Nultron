import { DEFAULT_CHAT_TOOLS } from "../../agents/default-chat";
import type { ModeHarnessSpec } from "../spec";

/**
 * Chat is the AI SDK tool loop (`runs.ts` `startModalityRun`). `DEFAULT_CHAT_TOOLS` is the whole set
 * a chat run may bind; `withPastSessionsBinding` adds `past_sessions` to any other agent's bindings.
 *
 * Why these numbers (a file edit is read, edit, re-read, then the answer, and `DEFAULT_MAX_STEPS`
 * of 6 ran out inside one such loop):
 * - `maxSteps` 12: two edit loops, or a lookup then an edit loop, with a step to spare for the answer.
 * - `maxToolCalls` 40: about three parallel calls in each of those 12 steps, well under what a runaway
 *   loop would spend.
 * - `write_file` and `edit_file` 20: one task across roughly ten files, each written or edited and
 *   then fixed once.
 * - `delete_file` 10: it removes data (desk deletes keep versions, a folder delete waits for approval),
 *   so it gets half the write ceiling.
 * - `web_fetch` 8: each call is a network read of up to 1.5 MB and 10 s, so eight pages is a research
 *   tour and no more.
 * - `run_code` 6: a run, a fix and a re-run for each of about two computations. A run is stopped at 30 s
 *   and a Personal desk runs one at a time, so a model that keeps retrying a broken program stops early.
 * - `self_check` 4: it only reads facts that do not change during a turn, so a second call is already a
 *   loop. Four leaves room for one check before and one after a fix.
 *
 * `repairRounds` is 0 because Chat never asks the model again. What it does have is a check in code
 * on the saved reply (`settleChatTurn`, `agents/chat-turn.ts`): it drops `[n]` source numbers the desk
 * did not offer and turns a calculator, datetime or past-sessions result that the model left unsaid
 * into one sentence. No second model call, so no round in the budget.
 */
export const chatHarnessSpec: ModeHarnessSpec = {
  mode: "chat",
  loop: "agent",
  tools: [...DEFAULT_CHAT_TOOLS],
  budget: {
    maxSteps: 12,
    maxToolCalls: 40,
    perTool: { write_file: 20, edit_file: 20, delete_file: 10, web_fetch: 8, run_code: 6, self_check: 4 },
  },
  repairRounds: 0,
  skills: [
    { id: "answer-this-turn", name: "Answer this turn", status: "has" },
    { id: "ground-in-desk", name: "Use the desk, and only sources it offered", status: "new" },
    { id: "say-the-result", name: "Do the small job and say the result", status: "new" },
    { id: "look-not-make", name: "Look at an attachment, and refuse the wrong kind", status: "new" },
    { id: "keep-the-turn", name: "Leave the turn where they can find it", status: "has" },
  ],
};
