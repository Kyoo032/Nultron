/**
 * Spoken turns are stored the same way a typed Chat turn is: one user row, then one assistant row
 * (`threads.ts` `insertMessage`). No new table. The assistant row is text, led by any `tool_call`
 * parts the ask ran — today only `delegate` — in the same order a typed turn saves them, so the
 * thread renders the delegate card under the spoken answer.
 */
import type { ContentPart, TenantContext, ToolCallPart } from "@agentforge/core";
import { insertMessage, listMessages } from "../threads";
import type { TalkerTurn } from "./talker";

const HISTORY_TURNS = 6;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.trim()) {
      lines.push(candidate.text);
    }
  }
  return lines.join("\n");
}

/** The thread's last six text messages, oldest first, for `Talker.open`. */
export async function recentVoiceHistory(tenant: TenantContext, threadId: string): Promise<TalkerTurn[]> {
  const rows = await listMessages(tenant, threadId);
  const turns: TalkerTurn[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = textOf(row.content);
    if (!text.trim()) continue;
    turns.push({ role: row.role, text });
  }
  return turns.slice(-HISTORY_TURNS);
}

/** User then assistant, so a reload of the thread renders the exchange in that order. */
export async function saveVoiceTurn(
  tenant: TenantContext,
  threadId: string,
  userText: string,
  assistantText: string,
  toolCalls: readonly ToolCallPart[] = [],
): Promise<void> {
  const user = userText.trim();
  const assistant = assistantText.trim();
  if (user) {
    const parts: ContentPart[] = [{ type: "text", text: user }];
    await insertMessage(tenant, threadId, "user", parts);
  }
  // The assistant row exists when it has something to say or a tool call to show; the tool parts lead,
  // the way `runs.ts` writes them, so the card sits above the spoken answer.
  if (assistant || toolCalls.length > 0) {
    const parts: ContentPart[] = [...toolCalls];
    if (assistant) {
      parts.push({ type: "text", text: assistant });
    }
    await insertMessage(tenant, threadId, "assistant", parts);
  }
}
