/**
 * What the Workspaces page decides on its own, kept pure so a node test can read it. Every rule here
 * is a display rule: the host enforces visibility, Remove and archive, and answers a refusal that the
 * page then shows.
 */
import { DOCX_MIME, PDF_MIME, PPTX_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import type { ModeIconName } from "@/components/mode-icons";
import type { ProjectFile, ProjectRecord, ProjectVisibility } from "./projects-client";

export type FileKind = "document" | "sheet" | "slides" | "pdf" | "image" | "video" | "audio" | "text" | "other";

/** The kind a file's mime says it is. Unknown types are "other", never guessed from the name. */
export function fileKind(mime: string): FileKind {
  if (mime === DOCX_MIME) return "document";
  if (mime === XLSX_MIME) return "sheet";
  if (mime === PPTX_MIME) return "slides";
  if (mime === PDF_MIME) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "other";
}

const ICON_BY_KIND: Record<FileKind, ModeIconName> = {
  document: "documents",
  sheet: "finance",
  slides: "presentations",
  pdf: "documents",
  image: "images",
  video: "videos",
  audio: "music",
  text: "documents",
  other: "documents",
};

export function fileIconName(mime: string): ModeIconName {
  return ICON_BY_KIND[fileKind(mime)];
}

/** The switch's two states. A change is sent only when the switch really moves. */
export function visibilityChange(
  current: ProjectVisibility,
  next: ProjectVisibility,
): { visibility: ProjectVisibility } | null {
  return current === next ? null : { visibility: next };
}

/**
 * Who may press Remove on a file: its maker or the Workspace's maker. The host checks the same rule and
 * answers 403 when it refuses, so a true here is only a reason to show the button.
 */
export function canRemoveFile(file: ProjectFile, project: ProjectRecord, me: string | null): boolean {
  if (!me) return false;
  return file.ownerUserId === me || project.createdBy === me;
}

/** The list splits into the person's own Workspaces and the ones the company shares. */
export function splitProjects(
  projects: readonly ProjectRecord[],
  me: string | null,
): { own: ProjectRecord[]; shared: ProjectRecord[] } {
  const own = projects.filter((project) => project.createdBy === me);
  const shared = projects.filter((project) => project.createdBy !== me);
  return { own, shared };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
