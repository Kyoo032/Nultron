import { fileRefusal } from "./refusals";
import type { DeskPath, FileRefusal } from "./types";

export const MAX_PATH_CHARS = 240;
export const MAX_PATH_SEGMENTS = 8;
export const MAX_SEGMENT_CHARS = 120;

const DRIVE_LETTER = /^[A-Za-z]:/;
const WINDOWS_FORBIDDEN_CHAR = /[<>:"|?*]/;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** C0 and C1 controls, the line separators, and the bidi overrides that can disguise a file name. */
function isControlOrSpoofingCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isControlOrSpoofingCode(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

/** The first reason a single path segment is refused, or null. */
function segmentProblem(segment: string): string | null {
  if (segment === "") {
    return "The path has an empty part (a doubled or trailing /).";
  }
  if (segment === "." || segment === "..") {
    return "Parts named . or .. are not allowed. Use a path from the top, like notes/plan.md.";
  }
  if (segment.length > MAX_SEGMENT_CHARS) {
    return `A part of the path is longer than ${MAX_SEGMENT_CHARS} characters.`;
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    return "A part of the path ends with a dot or a space.";
  }
  if (WINDOWS_FORBIDDEN_CHAR.test(segment)) {
    return 'A part of the path contains one of < > : " | ? *, which no file name may have.';
  }
  const base = segment.split(".")[0]?.trimEnd() ?? "";
  if (RESERVED_DEVICE_NAME.test(base)) {
    return "A part of the path uses a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9).";
  }
  return null;
}

/**
 * The one place a model's path becomes a `DeskPath`: a relative POSIX path that is safe on both
 * roots, including a Windows folder. Everything past this function trusts the brand.
 */
export function parseDeskPath(raw: string): DeskPath | FileRefusal {
  const bad = (message: string) => fileRefusal("bad_path", message);
  if (typeof raw !== "string" || raw === "") {
    return bad("The path is empty. Give a path from the top, like notes/plan.md.");
  }
  if (raw.length > MAX_PATH_CHARS) {
    return bad(`The path is longer than ${MAX_PATH_CHARS} characters.`);
  }
  if (hasControlCharacter(raw)) {
    return bad("The path contains a control character.");
  }
  if (raw.includes("\\")) {
    return bad("Use / between folders, not a backslash.");
  }
  if (raw.startsWith("/")) {
    return bad("The path must start at the top of the files, with no leading /.");
  }
  if (DRIVE_LETTER.test(raw)) {
    return bad("Drive letters are not allowed. Give a path from the top, like notes/plan.md.");
  }
  const segments = raw.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) {
    return bad(`The path has more than ${MAX_PATH_SEGMENTS} parts (folders plus the file name).`);
  }
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) {
      return bad(problem);
    }
  }
  return raw as DeskPath;
}
