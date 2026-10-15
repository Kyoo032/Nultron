import type { ContentPart, TenantContext } from "@agentforge/core";
import type { MediaKind } from "./constants";
import { insertMessage, listMessages, replaceMessageContent } from "../threads";

export function mediaPartOf(kind: MediaKind, url: string): ContentPart {
  return kind === "image" ? { type: "image_url", image_url: { url } } : { type: "video_url", video_url: { url } };
}

function isToolCallFor(part: ContentPart, proposalId: string): boolean {
  return (
    part.type === "tool_call" &&
    typeof part.output === "object" &&
    part.output !== null &&
    (part.output as { proposalId?: unknown }).proposalId === proposalId
  );
}

export async function writeMediaResultToThread(
  tenant: TenantContext,
  threadId: string,
  proposalId: string,
  toolResult: unknown,
  media: ContentPart,
): Promise<void> {
  const rows = await listMessages(tenant, threadId);
  const holder = [...rows]
    .reverse()
    .find(
      (row) =>
        row.role === "assistant" &&
        Array.isArray(row.content) &&
        (row.content as ContentPart[]).some((part) => isToolCallFor(part, proposalId)),
    );
  if (!holder) {
    await insertMessage(tenant, threadId, "assistant", [media]);
    return;
  }
  const parts = holder.content as ContentPart[];
  const updated = parts.map((part): ContentPart => {
    if (!isToolCallFor(part, proposalId)) {
      return part;
    }
    return { ...part, status: "completed", output: toolResult } as ContentPart;
  });
  await replaceMessageContent(tenant, holder.id, [...updated, media]);
}
