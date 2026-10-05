import { homedir, tmpdir } from "node:os";
import { MAX_STREAM_BYTES } from "./limits";

/**
 * What of a run reaches the model. The guest's own words stay (its print output, its traceback with
 * `<exec>` and `/workspace` frames, which is what the model needs to fix its code). Anything that could
 * describe the HOST does not: absolute paths, file URLs, Node internals and the frames of the
 * sandbox's own plumbing. The same rule as the ffmpeg failure reasons (SR-48): the model gets words
 * the host chose, or the guest's exception text with the host scrubbed out of it, never a raw process
 * error. Guest-written streams (print output) are passed through untouched: the guest has no host to
 * leak, and rewriting its output would corrupt real data.
 */

const HOST_PATH = "[host path]";
const MIN_REDACTION_LENGTH = 4;

/** A line that can only come from Node, never from the guest. */
const NODE_INTERNAL_LINE = /node:internal|\(node:|\bnode_modules[\\/]/;
const FILE_URL = /file:\/\/\S*/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`)\]]*/g;

/** Frames Pyodide adds around the guest's code; they say nothing about the program being run. */
const PYODIDE_FRAME = /^\s*File "[^"]*[\\/]_pyodide[\\/]/;
const FRAME_CONTEXT_LINE = /^ {4,}/;

/** The decoder writes U+FFFD for a cut-off character. Built from the code point so no tool rewrites it. */
const TRAILING_REPLACEMENT = new RegExp(`${String.fromCharCode(0xfffd)}+$`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Host locations this process knows about, so they can be scrubbed by value as well as by shape. */
export function hostRedactions(extra: readonly string[] = []): string[] {
  const candidates = [...extra, homedir(), tmpdir(), process.cwd()];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (candidate && candidate.length >= MIN_REDACTION_LENGTH) {
      unique.add(candidate);
      unique.add(candidate.replaceAll("\\", "/"));
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

/** Replaces host paths and URLs in `text`; `redactions` are exact strings known to name the host. */
export function scrubHost(text: string, redactions: readonly string[]): string {
  let scrubbed = text;
  for (const known of redactions) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(known), "gi"), HOST_PATH);
  }
  return scrubbed.replace(FILE_URL, HOST_PATH).replace(WINDOWS_PATH, HOST_PATH);
}

/** Drops the Pyodide wrapper frames (and their source/caret lines) from a Python traceback. */
function dropPyodideFrames(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (PYODIDE_FRAME.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && FRAME_CONTEXT_LINE.test(line) && !/^\s*File "/.test(line)) {
      continue;
    }
    skipping = false;
    kept.push(line);
  }
  return kept;
}

/** A guest exception as the model sees it: its own frames, no host. */
export function cleanGuestError(error: string, redactions: readonly string[]): string {
  const lines = error.replaceAll("\r\n", "\n").split("\n");
  const guestLines = dropPyodideFrames(lines).filter((line) => !NODE_INTERNAL_LINE.test(line));
  return scrubHost(guestLines.join("\n"), redactions).trimEnd();
}

const cutNote = (limit: number): string => `\n[run_code] Output cut at ${Math.round(limit / 1024)} KB.`;

/** Cuts `text` to `maxBytes` of UTF-8 on a character boundary and says so. */
export function capUtf8(text: string, maxBytes: number = MAX_STREAM_BYTES): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, cut: false };
  }
  const note = cutNote(maxBytes);
  // The note counts against the cap. Drop a trailing partial character: the decoder turns it into
  // U+FFFD, which is not guest text.
  const head = bytes
    .subarray(0, Math.max(maxBytes - Buffer.byteLength(note, "utf8"), 0))
    .toString("utf8")
    .replace(TRAILING_REPLACEMENT, "");
  return { text: head + note, cut: true };
}

/**
 * The final stream the model reads: `body` capped, then the runner's own `notes` (each starting with
 * `[run_code]`). The notes are kept whole and the guest's text gives up the room, so the total stays
 * within the cap.
 */
export function composeStream(body: string, notes: readonly string[]): string {
  const noteText = notes.join("\n");
  const noteBytes = Buffer.byteLength(noteText, "utf8");
  const room = Math.max(MAX_STREAM_BYTES - noteBytes - 1, 1024);
  const capped = capUtf8(body, room).text;
  if (noteText === "") {
    return capped;
  }
  return capped === "" ? noteText : `${capped}\n${noteText}`;
}
