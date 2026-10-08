/**
 * Cutting an attached file's text to the model's budget, the same way on both sides.
 *
 * The host cuts a document it read; the composer cuts a plain text file it read in the browser. Both
 * must cut on a line boundary, never leave half a surrogate pair, and say so in the same words, so the
 * rule lives here and neither side keeps its own copy. Pure: every function returns a new string.
 */
import { CHAT_TEXT_ATTACHMENT_MAX_CHARS } from "./limits";

function endsInHighSurrogate(text: string): boolean {
  const code = text.charCodeAt(text.length - 1);
  return text.length > 0 && code >= 0xd800 && code <= 0xdbff;
}

/** Cut at `limit` characters without leaving half a surrogate pair at the end. */
function sliceSafe(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  return endsInHighSurrogate(sliced) ? sliced.slice(0, -1) : sliced;
}

/** Cut at the last line break inside `maxChars`, so the last line is never half a line. */
export function cutOnLine(text: string, maxChars: number): { readonly text: string; readonly cut: boolean } {
  if (text.length <= maxChars) {
    return { text, cut: false };
  }
  const head = sliceSafe(text, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, cut: true };
}

const number = (value: number): string => value.toLocaleString("en-US");

/**
 * The one bracketed line that says a text was cut and by how much. `rest` is what became of the part
 * that did not follow: where it is saved, or that it was not kept.
 */
export function cutNoteLine(sentChars: number, totalChars: number, rest: string): string {
  return `[Cut: only the first ${number(sentChars)} of ${number(totalChars)} characters follow. ${rest}]`;
}

/** What a plain text file becomes in the message: its text, cut to the budget, and the note when it was. */
export type CutTextAttachment = {
  /** The host-voiced lines above the block's header, ending with a blank line, or empty when nothing was cut. */
  readonly notes: string;
  /** The text for the block: the whole file, or the part that fits. */
  readonly text: string;
  readonly cut: boolean;
};

/**
 * A plain text file (`.txt .md .csv .json`) held to the same budget a document is. A text file is not
 * saved on the desk, so a cut one says the rest was not kept. Under the budget nothing changes: no note
 * and the same text.
 */
export function cutTextAttachment(text: string, maxChars: number = CHAT_TEXT_ATTACHMENT_MAX_CHARS): CutTextAttachment {
  const { text: kept, cut } = cutOnLine(text, maxChars);
  if (!cut) {
    return { notes: "", text, cut: false };
  }
  return { notes: `${cutNoteLine(kept.length, text.length, "The rest was not kept.")}\n\n`, text: kept, cut: true };
}
