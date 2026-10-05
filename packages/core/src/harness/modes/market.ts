import { DEFAULT_RUN_BUDGET } from "../defaults";
import type { ModeHarnessSpec } from "../spec";

/**
 * Host code builds the packet and calls the model at fixed stages (`market-generate.ts`,
 * `market-team.ts`). The tools are the union any desk may bind: `MARKET_TOOL_BINDINGS` and
 * `MARKET_WEB_TOOL_BINDINGS` in the host. Which of them one desk gets is `toolKeysFor(specialist)`,
 * narrowed by the desk's `MARKET_HARNESS` row in `packages/core/src/market/harness.ts`; web research
 * is bound only when a search key is saved.
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
  repairRounds: 0,
  skills: [
    { id: "build-packet", name: "Build the packet", status: "has" },
    { id: "write-briefing", name: "Write one desk's briefing", status: "has" },
    { id: "run-team", name: "Run the team", status: "has" },
    { id: "rewrite-section", name: "Rewrite one section", status: "has" },
    { id: "export-briefing", name: "Export the briefing", status: "has" },
  ],
};
