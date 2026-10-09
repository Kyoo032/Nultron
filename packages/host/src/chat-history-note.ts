import { getTool, toolResultNote, type ContentPart } from "@agentforge/core";

/**
 * The note on the latest assistant turn that tells the model which tools already ran.
 *
 * The next run starts untainted (`egress-guard.ts`), so output of a tool whose trust is `user_content`
 * (file reads, `knowledge_search`, `past_sessions`, `run_code`) is never quoted back: only that it ran.
 * A tool the registry does not know is treated the same way. The trust comes from the registry, so no
 * tool name is listed here.
 */
export function historyToolNote(parts: ContentPart[]): string {
  return toolResultNote(parts, {
    outputVisible: (toolKey) => {
      const tool = getTool(toolKey);
      return tool !== undefined && tool.trust !== "user_content";
    },
  });
}
