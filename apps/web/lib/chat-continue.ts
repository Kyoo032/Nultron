/**
 * Continue on a step-limit turn.
 *
 * The host marks the turn with a `step_limit` part. The renderer reads that part and does not
 * match the sentence. The click sends one word in the desk language: the host's own sentences ask for
 * "continue" in English and "lanjutkan" in Indonesian, and the word is also the person's bubble.
 */
export const CONTINUE_PROMPT = "continue";
const CONTINUE_PROMPT_ID = "lanjutkan";

/** The word Continue sends in this locale. */
export function continuePrompt(locale: string): string {
  return locale === "id" ? CONTINUE_PROMPT_ID : CONTINUE_PROMPT;
}

/**
 * What one send carries. Continue (an override) sends only its word: never the draft in the box and never
 * the files attached there, which both stay for the person's own next message.
 */
export function sendSource<F>(
  override: string | undefined,
  draft: string,
  files: readonly F[],
): { readonly continuing: boolean; readonly typed: string; readonly attached: readonly F[] } {
  return override === undefined
    ? { continuing: false, typed: draft, attached: files }
    : { continuing: true, typed: override, attached: [] };
}

/** Only the newest shown turn, and only a reply, may offer Continue: an older one was already followed up. */
export function mayOfferContinue(index: number, shownCount: number, role: string): boolean {
  return role === "assistant" && index === shownCount - 1;
}

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
