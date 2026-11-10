/**
 * Spoken turns are stored the same way a typed Chat turn is: one user row, then one assistant row,
 * each a text part (`threads.ts` `insertMessage`). No new table.
 */
import type { ContentPart, TenantContext } from "@agentforge/core";
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
): Promise<void> {
  const user = userText.trim();
  const assistant = assistantText.trim();
  if (user) {
    const parts: ContentPart[] = [{ type: "text", text: user }];
    await insertMessage(tenant, threadId, "user", parts);
  }
  if (assistant) {
    const parts: ContentPart[] = [{ type: "text", text: assistant }];
    await insertMessage(tenant, threadId, "assistant", parts);
  }
}
