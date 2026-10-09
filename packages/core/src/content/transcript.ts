import type { ContentPart, TextPart, ThinkingPart, ToolCallPart } from "./types";

export type { ContentPart, TextPart, ImageUrlPart, VideoUrlPart, ThinkingPart, ToolCallPart } from "./types";

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text";
}

export function isThinkingPart(part: ContentPart): part is ThinkingPart {
  return part.type === "thinking";
}

export function isToolCallPart(part: ContentPart): part is ToolCallPart {
  return part.type === "tool_call";
}

/** Visible answer only — never thinking or tool traces. */
export function visibleAnswerText(parts: ContentPart[]): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function thinkingTextFromParts(parts: ContentPart[]): string {
  return parts
    .filter(isThinkingPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export function toolCallsFromParts(parts: ContentPart[]): ToolCallPart[] {
  return parts.filter(isToolCallPart);
}

/** History sent to the model: user/assistant text and media only. */
export function modelHistoryParts(parts: ContentPart[]): ContentPart[] {
  return parts.filter(
    (part) => part.type === "text" || part.type === "image_url" || part.type === "video_url",
  );
}

const TOOL_NOTE_MAX_CHARS = 1500;

/**
 * What the tools of one finished turn returned, as a short note for the model's next call, or `""`.
 *
 * `modelHistoryParts` drops tool traces, so a follow-up such as "continue" gave the model no sign that a
 * tool had already run and it ran it again. Only the latest assistant turn gets this note (the caller
 * decides), the outputs are the already-redacted stored copies, and the whole note is clipped.
 */
export function toolResultNote(parts: ContentPart[], maxChars: number = TOOL_NOTE_MAX_CHARS): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (!isToolCallPart(part) || part.status !== "completed" || part.output === undefined) {
      continue;
    }
    let text: string;
    try {
      text = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
    } catch {
      continue;
    }
    lines.push(`- ${part.toolKey}: ${text}`);
  }
  if (lines.length === 0) {
    return "";
  }
  const note = ["[Tool results already obtained in your previous turn; do not run them again]", ...lines].join("\n");
  return note.length > maxChars ? `${note.slice(0, maxChars - 1).trimEnd()}…` : note;
}

export function hasModelVisibleContent(parts: ContentPart[]): boolean {
  return modelHistoryParts(parts).some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }
    return true;
  });
}
