"use client";

import { CodeToolRow } from "./code-row";
import { DeckToolRow } from "./deck-row";
import { FileToolRow } from "./file-row";
import { KnowledgeToolRow } from "./knowledge-row";
import type { RowTool } from "./parts";

export { isRichTool } from "./results";
export type { RowTool } from "./parts";

/**
 * The body of one tool row in the Thinking disclosure, for the file, Knowledge, code and deck tools.
 * `ChatTurn` keeps the `<li>` and its testid; every other tool keeps its one-line summary.
 */
export function ToolRowBody({ tool }: { tool: RowTool }) {
  if (tool.key === "run_code") {
    return <CodeToolRow tool={tool} />;
  }
  if (tool.key === "knowledge_search") {
    return <KnowledgeToolRow tool={tool} />;
  }
  if (tool.key === "build_deck") {
    return <DeckToolRow tool={tool} />;
  }
  return <FileToolRow tool={tool} />;
}
