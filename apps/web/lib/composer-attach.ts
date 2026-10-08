import { CHAT_DOCUMENT_ACCEPT, CHAT_DOCUMENT_MAX_BYTES, isChatDocumentName } from "@agentforge/core/chat-documents";

/** `document` is a file the host reads locally (pdf, Word, PowerPoint, Excel and the like). */
export type AttachmentKind = "image" | "video" | "text" | "document" | "unsupported";

/** Client caps. Images match `saveMedia`; video is the HTTP body cap (26 MB), not the 50 MB kind cap. */
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_VIDEO_MAX_BYTES = 26 * 1024 * 1024;

export function attachmentOverCap(kind: AttachmentKind, bytes: number): boolean {
  if (kind === "image") return bytes > CHAT_IMAGE_MAX_BYTES;
  if (kind === "video") return bytes > CHAT_VIDEO_MAX_BYTES;
  if (kind === "document") return bytes > CHAT_DOCUMENT_MAX_BYTES;
  return false;
}

export type FileLike = { name: string; type: string };

export type RouteDecision =
  | { route: "text" }
  | { route: "image" }
  | { route: "video" }
  | { route: "error"; message: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);

/** accept= for the composer file input (images, videos, text-like, and every document the host reads). */
export const COMPOSER_FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "text/*",
  "application/json",
  ".txt",
  ".md",
  ".csv",
  ".json",
  CHAT_DOCUMENT_ACCEPT,
].join(",");

/** accept= for job regen (images + text files; no video). */
export const JOB_REGEN_FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/*",
  "application/json",
  ".txt",
  ".md",
  ".csv",
  ".json",
].join(",");

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export function classifyAttachment(file: FileLike): AttachmentKind {
  const mime = (file.type || "").toLowerCase();
  if (IMAGE_TYPES.has(mime)) {
    return "image";
  }
  if (VIDEO_TYPES.has(mime)) {
    return "video";
  }
  // Before the text check: an .rtf can arrive as text/rtf, and it is a document, not a text file.
  if (isChatDocumentName(file.name)) {
    return "document";
  }
  if (mime === "application/json" || mime.startsWith("text/")) {
    return "text";
  }
  if (TEXT_EXTENSIONS.has(extensionOf(file.name))) {
    return "text";
  }
  return "unsupported";
}

export function routeDecision(kinds: AttachmentKind[]): RouteDecision {
  if (kinds.some((kind) => kind === "unsupported")) {
    return { route: "error", message: "Unsupported file type" };
  }
  const hasImage = kinds.some((kind) => kind === "image");
  const hasVideo = kinds.some((kind) => kind === "video");
  if (hasImage && hasVideo) {
    return { route: "error", message: "Send image and video attachments separately" };
  }
  if (hasImage) {
    return { route: "image" };
  }
  if (hasVideo) {
    return { route: "video" };
  }
  return { route: "text" };
}

/**
 * Files that arrive by paste, on the same route as the picker and a drop.
 *
 * A clipboard that carries text is left alone: copying a range from a sheet puts the text and a
 * picture of the range on the clipboard, and the person meant the text. Only a paste with no text
 * (a file copied in the file manager, a screenshot) is taken as an attachment.
 */
export function pastedFiles(
  clipboard: { readonly files: ArrayLike<File>; getData(type: string): string } | null | undefined,
): File[] {
  if (!clipboard || clipboard.files.length === 0 || clipboard.getData("text/plain") !== "") {
    return [];
  }
  return Array.from(clipboard.files);
}

/**
 * Re-exported so the composer and the chat renderer share one rule; the rule itself
 * lives in `renderable-media` because markdown and tool output need it too.
 */
export { isRenderableImageUrl, isRenderableVideoUrl } from "./renderable-media";
