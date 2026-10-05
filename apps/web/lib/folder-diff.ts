/**
 * A line diff for the "changes to approve" panel.
 *
 * Pure and renderer-side: the host sends the file's text now (`before`) and the text the proposal
 * would leave (`after`), and the owner decides from what this draws. Lines are compared whole;
 * the longest common subsequence of lines is kept and everything else is a removal or an addition.
 *
 * Cost is bounded twice. Each side is cut to `DIFF_MAX_LINES` lines first (the panel says so when it
 * does), and the common head and tail are peeled off before the table is built, so the usual
 * one-line edit to a long file never builds a table at all. The worst case is a 2000 x 2000 table of
 * 16-bit cells, about 8 MB, built once when a row is opened.
 */

/** Lines kept per side. A ceiling, not a default: the UI states it whenever it bites. */
export const DIFF_MAX_LINES = 2000;

/** Unchanged lines kept on each side of a change when a long unchanged run is folded away. */
export const DIFF_CONTEXT_LINES = 3;

export type DiffLineKind = "same" | "add" | "remove";

export type DiffLine = {
  readonly kind: DiffLineKind;
  readonly text: string;
};

export type LineDiff = {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  /** True when either side was longer than the cap and only its first lines were compared. */
  readonly truncated: boolean;
  /** True when the two texts are not byte-for-byte the same. */
  readonly changed: boolean;
};

export type DiffRow = DiffLine | { readonly kind: "gap"; readonly count: number };

const LINE_BREAK = /\r\n|\n|\r/;

/** Lines of a text. A final line break ends the last line rather than starting an empty one. */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const parts = text.split(LINE_BREAK);
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    return parts.slice(0, -1);
  }
  return parts;
}

type Span = { readonly head: number; readonly tail: number };

/** How many lines the two sides share at the start, then at the end (never overlapping). */
function sharedEnds(a: readonly string[], b: readonly string[]): Span {
  const limit = Math.min(a.length, b.length);
  let head = 0;
  while (head < limit && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (tail < limit - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  return { head, tail };
}

/** The middle of the two sides as a minimal edit script, by longest common subsequence of lines. */
function middleScript(a: readonly string[], b: readonly string[]): DiffLine[] {
  const rows = a.length;
  const cols = b.length;
  if (rows === 0) {
    return b.map((text) => ({ kind: "add", text }));
  }
  if (cols === 0) {
    return a.map((text) => ({ kind: "remove", text }));
  }
  const width = cols + 1;
  // lcs[i * width + j] = length of the LCS of a[i..] and b[j..]; 2000 fits a Uint16 with room to spare.
  const lcs = new Uint16Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ kind: "remove", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    out.push({ kind: "remove", text: a[i] ?? "" });
  }
  for (; j < cols; j += 1) {
    out.push({ kind: "add", text: b[j] ?? "" });
  }
  return out;
}

/** Every line of `before` and `after` in order, each marked unchanged, removed or added. */
export function diffLines(before: string, after: string, maxLines: number = DIFF_MAX_LINES): LineDiff {
  const allBefore = splitLines(before);
  const allAfter = splitLines(after);
  const truncated = allBefore.length > maxLines || allAfter.length > maxLines;
  const a = truncated ? allBefore.slice(0, maxLines) : allBefore;
  const b = truncated ? allAfter.slice(0, maxLines) : allAfter;
  const { head, tail } = sharedEnds(a, b);
  const lines: DiffLine[] = [
    ...a.slice(0, head).map((text): DiffLine => ({ kind: "same", text })),
    ...middleScript(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): DiffLine => ({ kind: "same", text })),
  ];
  return {
    lines,
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
    truncated,
    changed: before !== after,
  };
}

/**
 * The lines to draw: each change with `context` unchanged lines around it, and a `gap` row standing
 * in for any longer unchanged run. A run only one line over the context is drawn whole, because a
 * gap that hides a single line is longer to read than the line.
 */
export function foldUnchanged(lines: readonly DiffLine[], context: number = DIFF_CONTEXT_LINES): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as DiffLine;
    if (line.kind !== "same") {
      rows.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end]?.kind === "same") {
      end += 1;
    }
    const run = lines.slice(index, end);
    const atStart = index === 0;
    const atEnd = end === lines.length;
    const keepBefore = atStart ? 0 : context;
    const keepAfter = atEnd ? 0 : context;
    if (run.length <= keepBefore + keepAfter + 1) {
      rows.push(...run);
    } else {
      rows.push(...run.slice(0, keepBefore));
      rows.push({ kind: "gap", count: run.length - keepBefore - keepAfter });
      rows.push(...run.slice(run.length - keepAfter));
    }
    index = end;
  }
  return rows;
}
