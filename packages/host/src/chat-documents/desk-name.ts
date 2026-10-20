/**
 * Where a document's text lands on the desk: `uploads/~<user folder>/<safe file name>.md`.
 *
 * The whole original name is kept, extension included, so `report.pdf` and `report.docx` get two
 * files and a person can tell which upload a file came from. The name is made safe for both file
 * roots (`parseDeskPath` is the judge) and is never allowed to leave `uploads/`.
 */
import { CHAT_DOCUMENT_DESK_DIR } from "@agentforge/core/chat-documents";
import { isFileRefusal, MAX_SEGMENT_CHARS, parseDeskPath } from "@agentforge/core/tools/files";
import type { DeskPath } from "@agentforge/core/tools/files";
import { privateFolderFor } from "../desk-files/private-uploads";

const SUFFIX = ".md";
const FALLBACK_NAME = "document";
/** Characters a Windows file name may not have, plus both slashes. */
const FORBIDDEN = /[<>:"|?*\\/]/g;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** C0 and C1 controls, the line separators, and the bidi overrides that can disguise a file name. */
function isControlOrSpoofing(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function lastPart(filename: string): string {
  return filename.split(/[\\/]/).pop() ?? "";
}

function replaceControls(name: string): string {
  return Array.from(name, (char) => (isControlOrSpoofing(char.codePointAt(0) ?? 0) ? "_" : char)).join("");
}

function sanitise(name: string): string {
  return replaceControls(name.normalize("NFC"))
    .replace(FORBIDDEN, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, (dots) => "_".repeat(dots.length))
    .replace(/[. ]+$/, "");
}

/** Shorten the stem, never the extension, so the name still says what kind of file it came from. */
function shorten(name: string, maxChars: number): string {
  if (name.length <= maxChars) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const stem = extension ? name.slice(0, dot) : name;
  return `${stem.slice(0, maxChars - extension.length)}${extension}`;
}

function accepted(path: string): DeskPath | null {
  const parsed = parseDeskPath(path);
  return isFileRefusal(parsed) ? null : parsed;
}

/**
 * The desk path for a document's saved text: `uploads/~<user folder>/<safe name>.md`. Always a path the
 * desk accepts. The folder is the person's own private one (`desk-files/private-uploads.ts`), and the
 * name is folded to Unicode NFC so two spellings that read the same do not become two files. Letter
 * case is kept, because the desk's paths are case sensitive.
 */
export function deskPathForDocument(filename: string, userId: string, suffix: string = SUFFIX): DeskPath {
  const cleaned = sanitise(lastPart(filename));
  const name = HAS_LETTER_OR_DIGIT.test(cleaned) ? cleaned : FALLBACK_NAME;
  const room = MAX_SEGMENT_CHARS - suffix.length;
  const folder = `${CHAT_DOCUMENT_DESK_DIR}/${privateFolderFor(userId)}`;
  const direct = accepted(`${folder}/${shorten(name, room)}${suffix}`);
  if (direct) {
    return direct;
  }
  // The only thing left that `parseDeskPath` refuses here is a reserved device name (CON, NUL, ...).
  const prefixed = accepted(`${folder}/${shorten(`doc-${name}`, room)}${suffix}`);
  return prefixed ?? (`${folder}/${FALLBACK_NAME}${suffix}` as DeskPath);
}
