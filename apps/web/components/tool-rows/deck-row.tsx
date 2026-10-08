"use client";

import { toolRowLabel } from "@/lib/tool-labels";
import { toolDetail } from "./details";
import { BudgetNote, RefusalNote, ROW_HEAD, RowDetail, RowLabel, type RowTool } from "./parts";
import { classifyOutcome } from "./results";

/**
 * build_deck, in the Thinking disclosure: "Built “Plan”", how many slides, and the tool's own sentence
 * when it refused (a check named a slide to fix) or the run's allowance was gone. The deck itself, its
 * slides and its Download button are the card under the answer (`DeckCards`), where a finished turn
 * does not hide them behind a closed disclosure.
 */
export function DeckToolRow({ tool }: { tool: RowTool }) {
  const outcome = classifyOutcome(tool.key, tool.status, tool.output);
  const label = toolRowLabel(tool.key, tool.input, tool.output, tool.status);
  const detail = outcome.state === "done" ? toolDetail(tool.key, tool.output) : null;
  return (
    <div className="min-w-0" data-testid="tool-row-deck" data-tool={tool.key} data-state={outcome.state}>
      <div className={ROW_HEAD}>
        <RowLabel text={label} />
        {detail ? <RowDetail text={detail} /> : null}
      </div>
      {outcome.state === "refused" ? <RefusalNote message={outcome.message} /> : null}
      {outcome.state === "budget" ? <BudgetNote message={outcome.message} /> : null}
    </div>
  );
}
