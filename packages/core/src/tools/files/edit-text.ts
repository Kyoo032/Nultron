import { fileRefusal } from "./refusals";
import type { FileRefusal } from "./types";

export type ExactEditResult = { readonly ok: true; readonly text: string; readonly replacements: number } | FileRefusal;

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Replace `oldString` with `newString`, exactly. It must occur once unless `replaceAll` is set.
 * Matches do not overlap. An empty or unchanged `oldString` is `bad_pattern` (the edit as asked is
 * malformed, nothing was looked for); `no_match` is kept for an `oldString` that is not in the file.
 */
export function applyExactEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ExactEditResult {
  if (oldString === "") {
    return fileRefusal(
      "bad_pattern",
      "old_string is empty. Give the exact text to replace, or use write_file for a new file.",
    );
  }
  if (oldString === newString) {
    return fileRefusal("bad_pattern", "old_string and new_string are identical, so nothing would change.");
  }
  const count = countOccurrences(text, oldString);
  if (count === 0) {
    return fileRefusal(
      "no_match",
      "old_string was not found. It must match the file exactly, including spaces, indentation and line breaks. Read the file again and copy the text.",
    );
  }
  if (count > 1 && !replaceAll) {
    return fileRefusal(
      "ambiguous_match",
      `old_string matches ${count} places. Add the lines around it so it matches once, or set replace_all to change every one.`,
    );
  }
  return { ok: true, text: text.split(oldString).join(newString), replacements: count };
}

/**
 * The model reads a CRLF file with the line breaks shown as plain lines, so it types `\n` where the
 * file has `\r\n`. When the whole file uses CRLF, give the snippet the same breaks. A file with
 * mixed or LF-only breaks is left exact.
 */
export function matchFileLineEndings(fileText: string, snippet: string): string {
  const allCrlf = fileText.includes("\r\n") && !/(?<!\r)\n/.test(fileText);
  return allCrlf ? snippet.replace(/\r?\n/g, "\r\n") : snippet;
}
