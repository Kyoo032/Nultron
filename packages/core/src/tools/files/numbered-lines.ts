import { cutText, MAX_LINE_CHARS, MAX_READ_LINES, splitLines } from "./lines";

export type NumberedLines = {
  /** The numbered lines, then a note when the view does not cover the whole file. */
  readonly text: string;
  /** 1-based number of the first line shown, 0 when none is. */
  readonly firstLine: number;
  readonly lastLine: number;
  readonly totalLines: number;
  /** More lines follow `lastLine`. */
  readonly truncated: boolean;
};

const NUMBER_WIDTH = 6;

function numbered(lineNumber: number, line: string): string {
  const shown =
    line.length > MAX_LINE_CHARS
      ? `${cutText(line, MAX_LINE_CHARS)} [line cut: ${MAX_LINE_CHARS} of ${line.length} characters]`
      : line;
  return `${String(lineNumber).padStart(NUMBER_WIDTH)}\t${shown}`;
}

/**
 * The view `read_file` gives the model: a tab after a 1-based line number, at most 2000 lines, every
 * line cut at 2000 characters. `offset` is the first line to show. Out-of-range values are clamped.
 */
export function formatNumberedLines(text: string, offset = 1, limit = MAX_READ_LINES): NumberedLines {
  const lines = splitLines(text);
  const total = lines.length;
  const first = Math.max(1, Math.floor(offset));
  const count = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limit)));
  if (total === 0) {
    return { text: "", firstLine: 0, lastLine: 0, totalLines: 0, truncated: false };
  }
  if (first > total) {
    return {
      text: `[The file has ${total} lines; offset ${first} is past the end.]`,
      firstLine: 0,
      lastLine: 0,
      totalLines: total,
      truncated: false,
    };
  }
  const last = Math.min(total, first + count - 1);
  const body = lines
    .slice(first - 1, last)
    .map((line, index) => numbered(first + index, line))
    .join("\n");
  const truncated = last < total;
  const note = truncated
    ? `\n[Showing lines ${first}-${last} of ${total}. Call read_file again with offset ${last + 1} to continue.]`
    : "";
  return { text: `${body}${note}`, firstLine: first, lastLine: last, totalLines: total, truncated };
}
