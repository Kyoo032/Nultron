import type { AgentRuntime } from "@agentforge/core";
import {
  runWithMediaReferenceResolver,
  TOOL_IMAGE_MAX_BYTES,
  type MediaReferenceResolver,
} from "@agentforge/core/tools/media-reference";
import { readMediaDataUrl, statMedia } from "./media";

export const chatMediaReferenceResolver: MediaReferenceResolver = async (tenant, mediaId) => {
  const row = await statMedia(tenant, mediaId);
  if (row?.kind !== "image" || row.sizeBytes > TOOL_IMAGE_MAX_BYTES) {
    return null;
  }
  return readMediaDataUrl(tenant, mediaId);
};

export function withChatMediaReferences(runtime: AgentRuntime): AgentRuntime {
  return {
    execute: (input) => runWithMediaReferenceResolver(chatMediaReferenceResolver, () => runtime.execute(input)),
  };
}
