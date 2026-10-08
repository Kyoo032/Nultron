/**
 * One way to read text for matching, shared by every judge that compares a model's words to a source.
 *
 * Text that came out of a PDF or a Word file is never quite the text the model was shown: lines break
 * mid-word, ligatures and non-breaking spaces creep in, quotes go curly, page markers sit in the middle
 * of a sentence. {@link normaliseForMatch} removes those differences from both sides of a comparison,
 * and keeps a map back to the original so a hit can still be located (and cited) in the source.
 *
 * Generalised from `normalizeForSearch` in `docx/text.ts`, which only collapsed whitespace, quote marks
 * and dashes. Pure; no model call.
 *
 * Order of the passes:
 *  1. NFKC, so ligatures, full-width forms and odd spaces become their plain selves.
 *  2. `<!-- page N -->` markers (and the line break after one) are dropped.
 *  3. Markdown `**` / `__`, backslash escapes, leading bullets and `#` headings are dropped; table pipes become spaces.
 *  4. A word hyphenated across a line break is joined when the next line starts in lower case.
 *  5. Zero-width characters, bidi marks and soft hyphens are removed.
 *  6. Quote marks, dashes and ellipses are unified.
 *  7. Whitespace is collapsed and trimmed.
 *  8. Optionally, case is folded.
 */

export type NormaliseOptions = {
  /** Lower-case the result, for the loosest comparison. Default false. */
  readonly foldCase?: boolean;
  /**
   * Join a word hyphenated across a line break: "indemni-\nfy" becomes "indemnify". Default true. Pass false
   * to keep the hyphen ("well-\nknown" becomes "well-known"): a real compound split by a line break reads
   * either way, so a matcher tries both.
   */
  readonly joinHyphens?: boolean;
};

export type Normalised = {
  readonly value: string;
  /** For each character of `value`, where in the original text the character it came from begins. */
  readonly offsets: readonly number[];
  /** For each character of `value`, where in the original text the character it came from ends (exclusive). */
  readonly ends: readonly number[];
};

/** The text so far, with for each character the span of the original it stands for. */
type Cells = { readonly text: string; readonly starts: readonly number[]; readonly ends: readonly number[] };

const COMBINING_MARK = /\p{M}/u;
/** First code point that can be a combining mark; everything below is a base character. */
const FIRST_COMBINING = 0x300;
const ASCII_MAX = 0x80;

const PAGE_MARKER = /<!--\s*page\s+\d+\s*-->[ \t]*\r?\n?/gi;
const BACKSLASH_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|<>~"'])/g;
const LEADING_BULLET = /(^|\n)[ \t]*(?:[-*•▪◦‣·–—]|#{1,6})[ \t]+/g;
const MARKDOWN_EMPHASIS = /\*\*|__/g;
const TABLE_PIPE = /\|/g;
const SOFT_HYPHEN_BREAK = /­[ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;
const HYPHEN_BREAK = /[-‐‑][ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const QUOTE_MARK = /["'`´‘’‚‛“”„‟‹›«»]/g;
const DASH = /[‐-―−﹘﹣－]/g;
const SPACED_ELLIPSIS = /\.(?:[ \t]?\.){2,}/g;
const WHITESPACE_RUN = /\s+/g;

const CANONICAL_QUOTE = '"';
const CANONICAL_DASH = "-";
const CANONICAL_ELLIPSIS = "...";
const CANONICAL_SPACE = " ";

function identityCells(text: string): Cells {
  const starts = new Array<number>(text.length);
  const ends = new Array<number>(text.length);
  for (let index = 0; index < text.length; index += 1) {
    starts[index] = index;
    ends[index] = index + 1;
  }
  return { text, starts, ends };
}

/** NFKC by character cluster, so every output character still knows the span of the original it came from. */
function nfkcCells(source: string): Cells {
  if (source.normalize("NFKC") === source) {
    return identityCells(source);
  }
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  while (index < source.length) {
    const code = source.codePointAt(index) ?? 0;
    let next = index + (code > 0xffff ? 2 : 1);
    while (next < source.length) {
      const following = source.codePointAt(next) ?? 0;
      if (following < FIRST_COMBINING || !COMBINING_MARK.test(String.fromCodePoint(following))) {
        break;
      }
      next += following > 0xffff ? 2 : 1;
    }
    const cluster = source.slice(index, next);
    const normalised = code < ASCII_MAX && cluster.length === 1 ? cluster : cluster.normalize("NFKC");
    parts.push(normalised);
    for (let at = 0; at < normalised.length; at += 1) {
      starts.push(index);
      ends.push(next);
    }
    index = next;
  }
  return { text: parts.join(""), starts, ends };
}

/**
 * Replace every match of `pattern` (global) with what `replace` returns, or leave a match alone when it
 * returns the matched text. A replacement of the same length keeps each character's own span; a shorter or
 * longer one gives all its characters the span of the whole match.
 */
function rewrite(cells: Cells, pattern: RegExp, replace: (match: RegExpMatchArray) => string): Cells {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let last = 0;
  let changed = false;
  const copy = (from: number, to: number) => {
    if (to <= from) {
      return;
    }
    parts.push(cells.text.slice(from, to));
    for (let at = from; at < to; at += 1) {
      starts.push(cells.starts[at] as number);
      ends.push(cells.ends[at] as number);
    }
  };
  for (const match of cells.text.matchAll(pattern)) {
    const at = match.index ?? 0;
    const length = match[0].length;
    const next = replace(match);
    if (next === match[0]) {
      continue;
    }
    changed = true;
    copy(last, at);
    parts.push(next);
    if (next.length === length) {
      for (let offset = 0; offset < length; offset += 1) {
        starts.push(cells.starts[at + offset] as number);
        ends.push(cells.ends[at + offset] as number);
      }
    } else if (next.length > 0) {
      const start = cells.starts[at] as number;
      const end = cells.ends[at + length - 1] as number;
      for (let offset = 0; offset < next.length; offset += 1) {
        starts.push(start);
        ends.push(end);
      }
    }
    last = at + length;
  }
  if (!changed) {
    return cells;
  }
  copy(last, cells.text.length);
  return { text: parts.join(""), starts, ends };
}

function trimmed(cells: Cells): Cells {
  const from = cells.text.startsWith(CANONICAL_SPACE) ? 1 : 0;
  const to =
    cells.text.length > from && cells.text.endsWith(CANONICAL_SPACE) ? cells.text.length - 1 : cells.text.length;
  if (from === 0 && to === cells.text.length) {
    return cells;
  }
  return { text: cells.text.slice(from, to), starts: cells.starts.slice(from, to), ends: cells.ends.slice(from, to) };
}

function foldedCells(cells: Cells): Cells {
  const lower = cells.text.toLowerCase();
  if (lower.length === cells.text.length) {
    return { ...cells, text: lower };
  }
  // A few characters grow when lower-cased ("İ"); give each of the new characters the original's span.
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at < cells.text.length; at += 1) {
    const piece = (cells.text[at] as string).toLowerCase();
    parts.push(piece);
    for (let offset = 0; offset < piece.length; offset += 1) {
      starts.push(cells.starts[at] as number);
      ends.push(cells.ends[at] as number);
    }
  }
  return { text: parts.join(""), starts, ends };
}

/**
 * The text as it will be compared, plus where each character came from in the original.
 * Both sides of a comparison go through here; the offsets are only read for the side that is the source.
 */
export function normaliseForMatch(text: string, options: NormaliseOptions = {}): Normalised {
  const joinHyphens = options.joinHyphens !== false;
  let cells = nfkcCells(text);
  cells = rewrite(cells, PAGE_MARKER, () => "");
  cells = rewrite(cells, BACKSLASH_ESCAPE, (match) => match[1] ?? "");
  cells = rewrite(cells, LEADING_BULLET, (match) => match[1] ?? "");
  cells = rewrite(cells, MARKDOWN_EMPHASIS, () => "");
  cells = rewrite(cells, TABLE_PIPE, () => CANONICAL_SPACE);
  cells = rewrite(cells, SOFT_HYPHEN_BREAK, () => "");
  cells = rewrite(cells, HYPHEN_BREAK, (match) => (joinHyphens ? "" : match[0].charAt(0)));
  cells = rewrite(cells, INVISIBLE, () => "");
  cells = rewrite(cells, QUOTE_MARK, () => CANONICAL_QUOTE);
  cells = rewrite(cells, DASH, () => CANONICAL_DASH);
  cells = rewrite(cells, SPACED_ELLIPSIS, () => CANONICAL_ELLIPSIS);
  cells = rewrite(cells, WHITESPACE_RUN, () => CANONICAL_SPACE);
  cells = trimmed(cells);
  if (options.foldCase) {
    cells = foldedCells(cells);
  }
  return { value: cells.text, offsets: cells.starts, ends: cells.ends };
}
