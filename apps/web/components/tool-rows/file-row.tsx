"use client";

import { t } from "@/lib/i18n";
import { toolRowLabel } from "@/lib/tool-labels";
import { toolDetail } from "./details";
import {
  BudgetNote,
  FileChip,
  PendingApproval,
  RefusalNote,
  ROW_HEAD,
  RowDetail,
  RowLabel,
  type RowTool,
} from "./parts";
import { classifyOutcome, savedDeskPath } from "./results";

/**
 * list_files, read_file, write_file, edit_file, search_files and delete_file: one sentence ("Read
 * notes/plan.md"), the small fact it adds, and whichever of the four endings the call had.
 * The file's content is never shown here; the answer is where the model uses it.
 */
export function FileToolRow({ tool }: { tool: RowTool }) {
  const outcome = classifyOutcome(tool.key, tool.status, tool.output);
  const label = toolRowLabel(tool.key, tool.input, tool.output, tool.status);
  const detail = outcome.state === "done" ? toolDetail(tool.key, tool.output) : null;
  const saved = savedDeskPath(tool.key, tool.output);
  return (
    <div className="min-w-0" data-testid="tool-row-file" data-tool={tool.key} data-state={outcome.state}>
      <div className={ROW_HEAD}>
        <RowLabel text={label} />
        {detail ? <RowDetail text={detail} /> : null}
        {saved ? <FileChip path={saved.path} text={t("chat.tools.open")} /> : null}
      </div>
      {outcome.state === "refused" ? <RefusalNote message={outcome.message} /> : null}
      {outcome.state === "budget" ? <BudgetNote message={outcome.message} /> : null}
      {outcome.state === "pending" ? <PendingApproval path={outcome.path} /> : null}
    </div>
  );
}
