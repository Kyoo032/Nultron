/**
 * Plain-text hygiene for a document's extracted text, before it goes to the model and the desk.
 *
 * Small, pure steps: make the text valid for the desk's file store and safe inside an attachment
 * block, cut it on a line when it is longer than a budget, and fit it under a byte limit. None of
 * them changes a word in the middle of the text. Immutable: every function returns a new string.
 * The cut on a line is core's (`cutOnLine`), shared with the composer's cut of a plain text file.
 */
import { isHostNoteLine } from "@agentforge/core/chat-documents";

export { cutOnLine } from "@agentforge/core/chat-documents";

/**
 * A line the attachment guard could read as the start of another block. The guard ends a block at any
 * line that begins with three dashes and a space (`injection-guard.ts`), and the renderer reads a full
 * `--- name ---` line as a file header, so every line that begins with three dashes and whitespace
 * counts, not only a complete header: a half header such as `--- Section 2` would otherwise end the
 * block and let everything after it escape the scan.
 */
const BLOCK_BREAK_LINE = /^---\s/;

/** Every kind of line ending folded to one, so a lone carriage return cannot hide a break from the test above. */
const LINE_BREAKS = /\r\n|\r/g;

/**
 * The text made safe to store and send: no NUL (the desk store refuses it), no lone surrogate (it
 * refuses that too), one kind of line ending, no line that could end the attachment block early and no
 * line that forges one of the host's own notes. Such a line is indented by one space, which none of the
 * readers match, so a document cannot cut its own block short or speak in the host's voice.
 */
export function cleanDocumentText(text: string): string {
  // Trim before the indent: trimming after it would strip the indent again from a first line that
  // forges a note, and a last line that is a half header.
  return replaceLoneSurrogates(text.split("\u0000").join(""))
    .replace(LINE_BREAKS, "\n")
    .trim()
    .split("\n")
    .map((line) => (BLOCK_BREAK_LINE.test(line) || isHostNoteLine(line) ? ` ${line}` : line))
    .join("\n");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

const REPLACEMENT = String.fromCharCode(0xfffd);

/** `String.prototype.toWellFormed`, which the host's TypeScript target does not declare yet. */
function replaceLoneSurrogates(text: string): string {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      out.push(text[index] ?? "", text[index + 1] ?? "");
      index += 1;
    } else {
      out.push(isHighSurrogate(code) || isLowSurrogate(code) ? REPLACEMENT : (text[index] ?? ""));
    }
  }
  return out.join("");
}

/** Fit `text` under `maxBytes` of UTF-8, cutting on a line break when there is one. */
export function fitUtf8Bytes(text: string, maxBytes: number): { readonly text: string; readonly cut: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, cut: false };
  }
  // Decoding the first `maxBytes` bytes drops a trailing partial character into U+FFFD, which is
  // then removed; what is left is whole characters only.
  const decoded = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  const lastBreak = decoded.lastIndexOf("\n");
  return { text: lastBreak > 0 ? decoded.slice(0, lastBreak) : decoded, cut: true };
}
