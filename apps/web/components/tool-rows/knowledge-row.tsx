"use client";

import { toolRowLabel } from "@/lib/tool-labels";
import { knowledgeTitles, toolDetail } from "./details";
import { BudgetNote, RefusalNote, ROW_HEAD, RowDetail, RowLabel, type RowTool } from "./parts";
import { classifyOutcome } from "./results";

/**
 * knowledge_search: "Searched your knowledge for “…”", how many excerpts came back and, under it,
 * the titles of the sources they came from. The excerpts themselves stay with the model.
 */
export function KnowledgeToolRow({ tool }: { tool: RowTool }) {
  const outcome = classifyOutcome(tool.key, tool.status, tool.output);
  const label = toolRowLabel(tool.key, tool.input, tool.output, tool.status);
  const detail = outcome.state === "done" ? toolDetail(tool.key, tool.output) : null;
  const titles = outcome.state === "done" ? knowledgeTitles(tool.output) : null;
  return (
    <div className="min-w-0" data-testid="tool-row-knowledge" data-tool={tool.key} data-state={outcome.state}>
      <div className={ROW_HEAD}>
        <RowLabel text={label} />
        {detail ? <RowDetail text={detail} /> : null}
      </div>
      {titles ? (
        <p className="mt-1 truncate text-[var(--text-3)]" title={titles.all} data-testid="tool-row-knowledge-sources">
          {titles.shown}
        </p>
      ) : null}
      {outcome.state === "refused" ? <RefusalNote message={outcome.message} /> : null}
      {outcome.state === "budget" ? <BudgetNote message={outcome.message} /> : null}
    </div>
  );
}
