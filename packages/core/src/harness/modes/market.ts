import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Host code builds the packet and calls the model at fixed stages (`market-generate.ts`,
 * `market-team.ts`). The tools are the union any desk may bind: `MARKET_TOOL_BINDINGS` and
 * `MARKET_WEB_TOOL_BINDINGS` in the host. Which of them one desk gets is `toolKeysFor(specialist)`,
 * narrowed by the desk's `MARKET_HARNESS` row in `packages/core/src/market/harness.ts`; web research
 * is bound only when a search key is saved.
 *
 * `repairRounds` is 1: a draft that states a figure the packet does not carry is rewritten once from
 * the packet with no tools (`repairFlaggedFigures`, `market-generate.ts`), announced as a `job.round`.
 * It does not go through `runChecked`, because the number guard is the check and it already marks
 * whatever the rewrite leaves. The quiet-source gather retry is not a repair round: no model is asked.
 */
export const marketHarnessSpec: ModeHarnessSpec = {
  mode: "market",
  loop: "pipeline",
  tools: [
    "market_quotes",
    "market_history",
    "market_technical",
    "market_macro",
    "market_news",
    "calculator",
    "web_search",
    "web_fetch",
  ],
  budget: DEFAULT_RUN_BUDGET,
  repairRounds: 1,
  skills: [
    { id: "build-packet", name: "Build the packet", status: "has" },
    { id: "write-briefing", name: "Write one desk's briefing", status: "has" },
    { id: "run-team", name: "Run the team", status: "has" },
    { id: "rewrite-section", name: "Rewrite one section", status: "has" },
    { id: "export-briefing", name: "Export the briefing", status: "has" },
  ],
};
