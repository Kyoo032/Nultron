/**
 * Quote matching: is what the model says a document said actually in the document, and where?
 *
 * A quote is looked for in four ways, strictest first, and the way it was found is reported as `mode` so
 * a caller can treat a case-folded hit as weaker than an exact one:
 *  - `exact`: the same characters;
 *  - `normalised`: the same once PDF line breaks, hyphen joins, ligatures, NBSPs, zero-width characters,
 *    page markers, markdown and quote or dash styles are removed (see {@link normaliseForMatch});
 *  - `case-folded`: the same once case is ignored too;
 *  - `elided`: a quote with `...` in it, whose parts (each at least {@link ELIDED_PART_MIN_CHARS}) appear
 *    in the source in the same order, each within {@link ELIDED_GAP_MAX_CHARS} of the one before.
 *
 * A quote shorter than {@link QUOTE_MIN_CHARS} (after normalising) is never matched: a few words appear in
 * any document and prove nothing. Offsets are into the original source text. Pure; no model call.
 */
import { type Normalised, type NormaliseOptions, normaliseForMatch } from "./normalise";

/** A quote shorter than this, once normalised, is not evidence. */
export const QUOTE_MIN_CHARS = 12;
/** Each part of an elided quote must be at least this long. */
export const ELIDED_PART_MIN_CHARS = 12;
/** The most text an elision (`...`) may hide between two parts of a quote. */
export const ELIDED_GAP_MAX_CHARS = 600;
/** How far either side of a quote {@link windowAround} reads by default. */
export const DEFAULT_WINDOW_CHARS = 240;

/** The most places the first part of an elided quote is tried at, so a repeated phrase cannot make this slow. */
const ELIDED_ANCHOR_TRIES = 500;
const ELLIPSIS = /\s*[[(]?\.{3}[\])]?\s*/;
const ELLIPSIS_MARK = "...";

export type QuoteSource = { readonly id: string; readonly text: string };

export type QuoteMode = "exact" | "normalised" | "case-folded" | "elided";

export type QuoteMatch = {
  readonly sourceId: string;
  /** Where the match starts in the source's original text. */
  readonly start: number;
  /** Where it ends (exclusive) in the source's original text. */
  readonly end: number;
  readonly mode: QuoteMode;
};

/** Sources prepared once, for judging many quotes against the same documents. */
export type QuoteIndex = {
  /** `preferId` is looked in first (the document the model named); the others follow in their given order. */
  match(quote: string, preferId?: string): QuoteMatch | null;
};

type Span = { readonly start: number; readonly end: number };

type PreparedSource = {
  readonly source: QuoteSource;
  view(options: NormaliseOptions): Normalised;
};

/** A hyphen (or soft hyphen) at a line end: the only thing that makes "join" and "keep" readings differ. */
const HYPHEN_AT_LINE_END = /[-­‐‑][ \t]*\r?\n/;

/**
 * The four readings of a source (hyphens joined or kept, case kept or folded), each built once and only
 * when asked for. Folding is done on the finished text; a source with no hyphenated line break has one
 * hyphen reading, not two.
 */
function prepare(source: QuoteSource): PreparedSource {
  const views = new Map<string, Normalised>();
  const hyphenReadingsDiffer = HYPHEN_AT_LINE_END.test(source.text);
  const build = (joinHyphens: boolean, foldCase: boolean): Normalised => {
    const effectiveJoin = joinHyphens || !hyphenReadingsDiffer;
    const key = `${foldCase ? "f" : "c"}${effectiveJoin ? "j" : "k"}`;
    const known = views.get(key);
    if (known) {
      return known;
    }
    let made: Normalised;
    if (foldCase) {
      const cased = build(effectiveJoin, false);
      const lower = cased.value.toLowerCase();
      made =
        lower.length === cased.value.length
          ? { value: lower, offsets: cased.offsets, ends: cased.ends }
          : normaliseForMatch(source.text, { joinHyphens: effectiveJoin, foldCase: true });
    } else {
      made = normaliseForMatch(source.text, { joinHyphens: effectiveJoin });
    }
    views.set(key, made);
    return made;
  };
  return { source, view: (options) => build(options.joinHyphens !== false, options.foldCase === true) };
}

/** The original-text span of the normalised range [from, to). */
function originalSpan(view: Normalised, from: number, to: number): Span {
  return { start: view.offsets[from] as number, end: view.ends[to - 1] as number };
}

/** Two readings of a source: hyphen joined (the usual one) and hyphen kept (a compound split by a line break). */
const HYPHEN_VIEWS = [{ joinHyphens: true }, { joinHyphens: false }] as const;

function findPlain(prepared: PreparedSource, needle: string, foldCase: boolean): Span | null {
  for (const hyphen of HYPHEN_VIEWS) {
    const view = prepared.view({ ...hyphen, foldCase });
    const at = view.value.indexOf(needle);
    if (at !== -1) {
      return originalSpan(view, at, at + needle.length);
    }
  }
  return null;
}

function elidedParts(value: string): string[] | null {
  if (!value.includes(ELLIPSIS_MARK)) {
    return null;
  }
  const parts = value
    .split(ELLIPSIS)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 ? parts : null;
}

function findParts(view: Normalised, parts: readonly string[]): Span | null {
  const [first, ...rest] = parts;
  if (first === undefined) {
    return null;
  }
  let from = 0;
  for (let tries = 0; tries < ELIDED_ANCHOR_TRIES; tries += 1) {
    const anchor = view.value.indexOf(first, from);
    if (anchor === -1) {
      return null;
    }
    let cursor = anchor + first.length;
    let complete = true;
    for (const part of rest) {
      const at = view.value.indexOf(part, cursor);
      if (at === -1 || at - cursor > ELIDED_GAP_MAX_CHARS) {
        complete = false;
        break;
      }
      cursor = at + part.length;
    }
    if (complete) {
      return originalSpan(view, anchor, cursor);
    }
    from = anchor + 1;
  }
  return null;
}

function findElided(prepared: PreparedSource, parts: readonly string[], foldedParts: readonly string[]): Span | null {
  for (const foldCase of [false, true]) {
    for (const hyphen of HYPHEN_VIEWS) {
      const found = findParts(prepared.view({ ...hyphen, foldCase }), foldCase ? foldedParts : parts);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

type Needle = {
  readonly raw: string;
  readonly value: string;
  readonly folded: string;
  readonly parts: readonly string[] | null;
  readonly foldedParts: readonly string[] | null;
};

function needleOf(quote: string): Needle {
  const value = normaliseForMatch(quote).value;
  const folded = normaliseForMatch(quote, { foldCase: true }).value;
  const parts = elidedParts(value);
  const usable = parts?.every((part) => part.length >= ELIDED_PART_MIN_CHARS);
  return {
    raw: quote.trim(),
    value,
    folded,
    parts: usable ? parts : null,
    foldedParts: usable ? elidedParts(folded) : null,
  };
}

function matchInSource(prepared: PreparedSource, needle: Needle): QuoteMatch | null {
  const sourceId = prepared.source.id;
  const exactAt = prepared.source.text.indexOf(needle.raw);
  if (exactAt !== -1) {
    return { sourceId, start: exactAt, end: exactAt + needle.raw.length, mode: "exact" };
  }
  const normalised = findPlain(prepared, needle.value, false);
  if (normalised) {
    return { sourceId, ...normalised, mode: "normalised" };
  }
  const folded = findPlain(prepared, needle.folded, true);
  if (folded) {
    return { sourceId, ...folded, mode: "case-folded" };
  }
  if (needle.parts && needle.foldedParts) {
    const elided = findElided(prepared, needle.parts, needle.foldedParts);
    if (elided) {
      return { sourceId, ...elided, mode: "elided" };
    }
  }
  return null;
}

/** Prepare `sources` once and judge many quotes against them. */
export function createQuoteIndex(sources: readonly QuoteSource[]): QuoteIndex {
  const prepared = sources.map(prepare);
  return {
    match(quote, preferId) {
      const needle = needleOf(quote);
      if (needle.raw === "" || needle.value.length < QUOTE_MIN_CHARS) {
        return null;
      }
      const preferred = preferId === undefined ? [] : prepared.filter((entry) => entry.source.id === preferId);
      const others = prepared.filter((entry) => !preferred.includes(entry));
      for (const entry of [...preferred, ...others]) {
        const found = matchInSource(entry, needle);
        if (found) {
          return found;
        }
      }
      return null;
    },
  };
}

/** Where `quote` is in `sources`, or null. See the file comment for the four modes and the minimum length. */
export function matchQuote(quote: string, sources: readonly QuoteSource[], preferId?: string): QuoteMatch | null {
  return createQuoteIndex(sources).match(quote, preferId);
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

/**
 * The text around a span: `radius` characters either side, clamped to the text and never cutting a
 * surrogate pair. Use it to ask "is the owner named within 240 characters of the quote?".
 */
export function windowAround(text: string, start: number, end: number, radius: number = DEFAULT_WINDOW_CHARS): string {
  let from = Math.max(0, start - radius);
  let to = Math.min(text.length, end + radius);
  if (from > 0 && LOW_SURROGATE.test(text.charAt(from))) {
    from += 1;
  }
  if (to < text.length && to > from && HIGH_SURROGATE.test(text.charAt(to - 1))) {
    to -= 1;
  }
  return text.slice(from, to);
}
