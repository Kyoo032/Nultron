/**
 * What the Chat pane asks the host for to fill the context chip's knowledge rows (Soul, Memories,
 * Sources).
 *
 * `GET /api/v1/knowledge/context` retrieves when it is given a `query`, and retrieving embeds that
 * query through the gateway, a paid call on a keyed desk. So the pane never gives it one: it names
 * the thread, and the host answers from what that thread's last turn was handed
 * (`packages/host/src/knowledge-last-turn.ts`). Pure on purpose; `ChatSession` owns the state and
 * `lib/knowledge-context.test.ts` pins the rules.
 */
export type KnowledgeContextPart = {
  label: string;
  detail?: string;
  tokens: number;
};

export function knowledgeContextPath(threadId: string): string {
  return `/api/v1/knowledge/context?threadId=${encodeURIComponent(threadId)}`;
}

/**
 * Whether the rows are worth a request now: the chip shows only once a reply exists, there has to be
 * a thread to describe, and a desk whose gate is closed would be refused (`403 gateway_blocked`).
 */
export function knowledgeContextWanted(input: {
  keyMissing: boolean;
  hasReply: boolean;
  threadId: string | null;
}): boolean {
  return !input.keyMissing && input.hasReply && input.threadId !== null;
}

/**
 * The id of the newest reply, or "" before there is one. The rows describe the last turn, so a new
 * reply is the one thing that makes them stale; the pane asks again when this changes, not on every
 * change of the message list.
 */
export function lastAssistantId(messages: ReadonlyArray<{ id: string; role: string }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "assistant") {
      return message.id;
    }
  }
  return "";
}

/** The rows of a host answer that name themselves; anything else in the list is dropped. */
export function parseContextParts(payload: unknown): KnowledgeContextPart[] {
  const parts = payload && typeof payload === "object" ? (payload as { parts?: unknown }).parts : undefined;
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.filter((part: unknown): part is KnowledgeContextPart => {
    return Boolean(part && typeof part === "object" && typeof (part as KnowledgeContextPart).label === "string");
  });
}
