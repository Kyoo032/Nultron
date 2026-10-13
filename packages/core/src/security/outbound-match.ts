import { redactCredentials } from "./redact";

/**
 * The pure half of the outbound guard (`./outbound-guard.ts`): what counts as the run's private material
 * inside a search query or a page address. No state and no I/O, so every rule here is tested on strings.
 *
 * A text is indexed into word spans and figures. A query carries private material when it shares a span of
 * `SPAN_WORDS` consecutive words, or a figure, with the private text that the person's own messages do not
 * also hold.
 */

/** About five words: long enough that ordinary research phrasing rarely repeats a document by chance. */
export const SPAN_WORDS = 5;

/**
 * Longest query sent to a search backend. Real research queries are well under it (the planner writes
 * "short keyword queries"), the keyless path always cut at 300 (`keyless-search.ts`), and Tavily documents a
 * 400-character query limit. A longer query is the shape of a pasted paragraph, so it is refused, not cut.
 */
export const SEARCH_QUERY_MAX_CHARS = 300;

/** A run of characters this long that looks encoded (hex, or base64 with mixed case and digits) is refused. */
export const BLOB_MIN_CHARS = 24;

export type ShapeProblem = "too_long" | "credential" | "blob";

export type TextIndex = {
  /** Lowercased `SPAN_WORDS`-word spans, words joined by one space. */
  readonly spans: ReadonlySet<string>;
  /** Numbers of three or more digits (separators removed) and account-like codes, lowercased. */
  readonly figures: ReadonlySet<string>;
};

/** The host's own mask tokens (`[email]`, `[REDACTED]`): never a span word, and a span never crosses one. */
const MASK_TOKEN = /\[(?:email|phone|id|card|nik|npwp|account|name|redacted)\]/giu;
const WORD = /[\p{L}\p{N}]+/gu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;
const CODE = /[\p{L}\p{N}]+(?:[-/._][\p{L}\p{N}]+)*/gu;
const YEAR = /^(?:19|20)\d{2}$/;
const HEX_BLOB = new RegExp(`(?<![0-9a-z])[0-9a-f]{${BLOB_MIN_CHARS},}(?![0-9a-z])`, "iu");
const B64_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${BLOB_MIN_CHARS},}`, "gu");

function segments(text: string): string[] {
  return text.normalize("NFKC").split(MASK_TOKEN);
}

/** Small words a name or a title keeps in lower case: "Bank of America", "UU No. 40 Tahun 2007 tentang Perseroan Terbatas". */
const NAME_CONNECTORS: ReadonlySet<string> = new Set([
  "of",
  "the",
  "and",
  "for",
  "in",
  "on",
  "at",
  "de",
  "tentang",
  "dan",
  "atas",
  "untuk",
  "di",
  "ke",
  "dari",
  "pada",
  "serta",
]);

/** True when the word is written as a name: starts with a capital letter, or is a number. */
function capitalised(word: string): boolean {
  return /^[\p{Lu}\p{N}]/u.test(word);
}

/** A run of capitalised words and name connectors, with at least two capitalised: a proper name or a title. */
function nameLike(window: readonly string[]): boolean {
  const named = window.filter(capitalised).length;
  return named >= 2 && window.every((word) => capitalised(word) || NAME_CONNECTORS.has(word));
}

/**
 * The spans of one text. With `skipNames`, a span written as a name is left out (`nameLike`): a company,
 * a regulator or a statute ("PT Bank Central Asia Tbk", "No. 40 Tahun 2007 tentang Perseroan"), which a
 * research query names on purpose, not a sentence lifted from a document.
 */
function spansOf(text: string, skipNames: boolean): Set<string> {
  const spans = new Set<string>();
  for (const segment of segments(text)) {
    const words = segment.match(WORD) ?? [];
    for (let start = 0; start + SPAN_WORDS <= words.length; start += 1) {
      const window = words.slice(start, start + SPAN_WORDS);
      if (skipNames && nameLike(window)) {
        continue;
      }
      spans.add(window.join(" ").toLowerCase());
    }
  }
  return spans;
}

/**
 * A number counts when it has three or more digits once `.` and `,` are removed (so `1.250.000`, `1,250,000`
 * and `1250000` are one figure), is not a year from 1900 to 2099, and is not round: what is left once the
 * trailing zeros go must be at least two digits, so `500` and `1.000.000` are not figures and `250` is.
 */
function isFigure(digits: string): boolean {
  return digits.length >= 3 && !YEAR.test(digits) && digits.replace(/0+$/, "").length >= 2;
}

/**
 * An account-like code: letters and digits in one token, six or more characters without separators, with at
 * least three digits that are not just a year (`INV-2024-00871`, `AB12C3D4`; not `FY2024`, not `COVID-19`).
 */
function isCode(token: string): boolean {
  const flat = token.replace(/[-/._]/g, "");
  const digits = flat.replace(/\D/g, "");
  return flat.length >= 6 && /\p{L}/u.test(flat) && digits.length >= 3 && !YEAR.test(digits);
}

function figuresOf(text: string): Set<string> {
  const figures = new Set<string>();
  for (const segment of segments(text)) {
    for (const match of segment.match(NUMBER) ?? []) {
      const digits = match.replace(/[.,]/g, "");
      if (isFigure(digits)) {
        figures.add(digits);
      }
    }
    for (const token of segment.match(CODE) ?? []) {
      if (isCode(token)) {
        figures.add(token.replace(/[-/._]/g, "").toLowerCase());
      }
    }
  }
  return figures;
}

/** Index of the run's private material: names are left out of the spans, see `spansOf`. */
export function indexPrivate(text: string): TextIndex {
  return { spans: spansOf(text, true), figures: figuresOf(text) };
}

/** Index of the person's own messages and of an outgoing query: every span counts. */
export function indexPlain(text: string): TextIndex {
  return { spans: spansOf(text, false), figures: figuresOf(text) };
}

/** A query or address after `decodeURIComponent` and with `+` read as a space, so encoding hides nothing. */
export function readableUrl(url: string): string {
  const spaced = url.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Base64 is long runs of mixed case and digits with a separator only now and then. A hyphenated title
 * ("COVID-19-Vaccination-Programme") has words between its hyphens, none of them 16 characters of that mix.
 */
function looksLikeBase64(run: string): boolean {
  return run
    .split(/[-_+/=]/)
    .some((part) => part.length >= 16 && /[A-Z]/.test(part) && /[a-z]/.test(part) && /\d/.test(part));
}

export function hasCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}

export function hasBlob(text: string): boolean {
  return HEX_BLOB.test(text) || (text.match(B64_RUN) ?? []).some(looksLikeBase64);
}

/** What is wrong with the shape of a search query, checked on every backend, tainted or not. */
export function queryShapeProblem(query: string): ShapeProblem | null {
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    return "too_long";
  }
  if (hasCredential(query)) {
    return "credential";
  }
  return hasBlob(query) ? "blob" : null;
}

/**
 * True when `text` shares a span or a figure with the private material that the person's own messages do not
 * also hold. A phrase or a number the person typed is theirs to search for.
 */
export function carriesPrivate(text: string, privateIndex: TextIndex, userIndex: TextIndex): boolean {
  const outgoing = indexPlain(text);
  for (const span of outgoing.spans) {
    if (privateIndex.spans.has(span) && !userIndex.spans.has(span)) {
      return true;
    }
  }
  for (const figure of outgoing.figures) {
    if (privateIndex.figures.has(figure) && !userIndex.figures.has(figure)) {
      return true;
    }
  }
  return false;
}
