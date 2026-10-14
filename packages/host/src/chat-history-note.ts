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

/** Only a path the host stored (`/api/v1/media/<id>/file`) is a reference; a remote link never is. */
const STORED_MEDIA_PATH = /^\/api\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/file$/i;

/**
 * The stored pictures and videos an assistant turn made, as one text part for the model. Tool output is
 * not kept in later turns, so without this the model has no id to pass to `image_generate` or
 * `video_generate` when the person asks to change what was made. Null when the turn stored no media.
 */
export function historyMediaPart(parts: ContentPart[]): ContentPart | null {
  const references: string[] = [];
  for (const part of parts) {
    const url = part.type === "image_url" ? part.image_url.url : part.type === "video_url" ? part.video_url.url : null;
    if (url && STORED_MEDIA_PATH.test(url)) {
      references.push(`reference: ${url}`);
    }
  }
  if (references.length === 0) {
    return null;
  }
  const header = "[Media you made in this reply. Pass a reference to image_generate or video_generate to edit it.]";
  return { type: "text", text: [header, ...references].join("\n") };
}
