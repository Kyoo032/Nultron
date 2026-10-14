/**
 * Continue on a step-limit turn.
 *
 * The host marks the turn with a `step_limit` part. The renderer reads that part and does not
 * match the sentence. The click sends this word, in both languages.
 */
export const CONTINUE_PROMPT = "continue";

/** Finished tool keys on a host-marked step-limit turn, or null when the turn is not one. */
export function stepLimitToolsOf(content: unknown): string[] | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "step_limit") {
      continue;
    }
    const tools = (part as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0);
  }
  return null;
}
