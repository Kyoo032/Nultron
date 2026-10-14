/**
 * The media reference resolver for a chat run. A tool (`image_generate`, `video_generate`) that is
 * given a stored image's reference reads it through here, and only through here: the core tool never
 * reads the database. The read is scoped to the caller's organization by `statMedia` and
 * `readMediaDataUrl`, so another organization's media id answers null, which the tool reports as "no
 * image with that reference" and never as bytes.
 */
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

/** Wraps a run so every tool it calls can resolve media references for that run's organization. */
export function withChatMediaReferences(runtime: AgentRuntime): AgentRuntime {
  return {
    execute: (input) => runWithMediaReferenceResolver(chatMediaReferenceResolver, () => runtime.execute(input)),
  };
}
