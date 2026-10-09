/**
 * What the Meeting desk decides about a dropped file and the prompt, before any request is made.
 *
 * A drop is free: it creates the meeting (named after the file) and uploads the file. Nothing paid runs
 * until the owner presses Run. These are the pure decisions; the requests are `meeting-request.ts` and
 * `meeting-upload.ts`.
 */
import { MEETING_REQUEST_MAX_CHARS, TRANSCRIPT_FILE_EXTENSIONS, transcriptFileKind } from "@agentforge/core/meeting";

/** What the file picker offers: a recording, or any transcript the host can read. */
export const MEETING_FILE_ACCEPT = ["audio/*", "video/*", ...TRANSCRIPT_FILE_EXTENSIONS].join(",");

/** The host trims a title to 200; the desk keeps it short enough to read in the list. */
export const MEETING_TITLE_MAX = 80;

export type MeetingFileKind = "recording" | "transcript" | "unsupported";

/** Extensions of a recording whose browser mime type came through empty (a drag from some file managers). */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "m4a",
  "mp4",
  "m4v",
  "wav",
  "webm",
  "weba",
  "ogg",
  "oga",
  "opus",
  "aac",
  "flac",
  "mov",
  "mkv",
]);

function extensionOf(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Which route a file goes to. A transcript is told by its name (the host reads `.pdf` and `.docx` as
 * documents whatever their mime says), a recording by its mime type or a media extension. Anything else is
 * refused before a request is made.
 */
export function classifyMeetingFile(file: { readonly name: string; readonly type: string }): MeetingFileKind {
  if (transcriptFileKind(file.name) !== null) {
    return "transcript";
  }
  const type = file.type.toLowerCase();
  if (type.startsWith("audio/") || type.startsWith("video/")) {
    return "recording";
  }
  return MEDIA_EXTENSIONS.has(extensionOf(file.name)) ? "recording" : "unsupported";
}

function shortTitle(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MEETING_TITLE_MAX).trim();
  return clean || fallback;
}

/** A meeting's title from its file: the stem, without a folder or the last extension. */
export function titleFromFileName(name: string, fallback: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return shortTitle(dot === -1 ? base : base.slice(0, dot), fallback);
}

/** A meeting's title from a pasted transcript: its first line that says something, cut short. */
export function titleFromTranscript(text: string, fallback: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  return shortTitle(first, fallback);
}

/**
 * What the owner asked for, as the run carries it. Absent when nothing was typed, so every mode runs its
 * default; cut to the length the host accepts rather than refused.
 */
export function promptForRun(prompt: string): string | undefined {
  const text = prompt.trim().slice(0, MEETING_REQUEST_MAX_CHARS).trim();
  return text === "" ? undefined : text;
}

/** How many words a transcript has, for the line that says one is in. */
export function wordCount(text: string): number {
  const words = text.trim();
  return words === "" ? 0 : words.split(/\s+/).length;
}
