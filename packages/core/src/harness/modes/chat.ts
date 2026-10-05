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
 */
export const chatHarnessSpec: ModeHarnessSpec = {
  mode: "chat",
  loop: "agent",
  tools: [...DEFAULT_CHAT_TOOLS],
  budget: {
    maxSteps: 12,
    maxToolCalls: 40,
    perTool: { write_file: 20, edit_file: 20, delete_file: 10, web_fetch: 8, run_code: 6 },
  },
  repairRounds: 0,
  skills: [
    { id: "reply-on-a-thread", name: "Reply on a thread", status: "has" },
    { id: "use-desk-knowledge", name: "Use the desk's knowledge", status: "has" },
    { id: "call-bound-tools", name: "Call the bound tools, then stop", status: "has" },
    { id: "refuse-wrong-attachment", name: "Refuse the wrong attachment", status: "has" },
    { id: "keep-the-session", name: "Keep the session", status: "has" },
  ],
};
