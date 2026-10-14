/**
 * The media reference resolver for a chat run. A tool (`image_generate`, `video_generate`) that is
 * given a stored image's reference reads it through here, and only through here: the core tool never
 * reads the database. The read is scoped to what the caller may see (SR-175) by `statVisibleMedia` and
 * `readVisibleMediaDataUrl`: their own media and their Workspaces' (K-D22). Another person's or another
 * organization's media id answers null, which the tool reports as "no image with that reference" and
 * never as bytes.
 */
import type { AgentRuntime } from "@agentforge/core";
import {
  runWithMediaReferenceResolver,
  TOOL_IMAGE_MAX_BYTES,
  type MediaReferenceResolver,
} from "@agentforge/core/tools/media-reference";
import { readVisibleMediaDataUrl, statVisibleMedia } from "./media-visibility";

export const chatMediaReferenceResolver: MediaReferenceResolver = async (tenant, mediaId) => {
  const row = await statVisibleMedia(tenant, mediaId);
  if (row?.kind !== "image" || row.sizeBytes > TOOL_IMAGE_MAX_BYTES) {
    return null;
  }
  return readVisibleMediaDataUrl(tenant, mediaId);
};

/** Wraps a run so every tool it calls can resolve media references for that run's organization. */
export function withChatMediaReferences(runtime: AgentRuntime): AgentRuntime {
  return {
    execute: (input) => runWithMediaReferenceResolver(chatMediaReferenceResolver, () => runtime.execute(input)),
  };
}
