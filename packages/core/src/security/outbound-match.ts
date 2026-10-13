import { redactCredentials } from "./redact";

/**
 * The pure half of the outbound guard (`./outbound-guard.ts`): what counts as the run's private material
 * inside a search query or a page address. No state and no I/O, so every rule here is tested on strings.
 *
 * A text is indexed into word spans, figures and codes. A query carries private material when it shares a
 * meaningful span of `SPAN_WORDS` consecutive words, an account-like code, a long figure, or two short
 * figures with the private text that the person's own messages do not also hold.
 */

/** About five words: long enough that ordinary research phrasing rarely repeats a document by chance. */
export const SPAN_WORDS = 5;

/** A private span counts only with this many words that are not stopwords (`STOPWORDS`). */
export const SPAN_MEANINGFUL_WORDS = 3;

/**
 * Longest query sent to a search backend. Real research queries are well under it (the planner writes
 * "short keyword queries"), the keyless path always cut at 300 (`keyless-search.ts`), and Tavily documents a
 * 400-character query limit. A longer query is the shape of a pasted paragraph, so it is refused, not cut.
 */
export const SEARCH_QUERY_MAX_CHARS = 300;

/**
 * Longest path, query and fragment (decoded) of a page address the model wrote. Article addresses are well
 * under it; a longer one is the shape of text packed into a link. A search result's own address is exempt.
 */
export const URL_REST_MAX_CHARS = 512;

/** A host label longer than this (`<base32>.evil.example`) is the shape of data packed into a name. */
export const HOST_LABEL_MAX_CHARS = 40;

/** A run of characters this long that looks encoded (hex, or base64 with mixed case and digits) is refused. */
export const BLOB_MIN_CHARS = 24;

/** A number with this many digits (separators removed) is a figure on its own; a shorter one needs a second. */
export const LONG_FIGURE_DIGITS = 6;

export type ShapeProblem = "too_long" | "credential" | "blob";

/** What a query shares with the private text. Spans and codes identify; a figure is weaker evidence. */
export type PrivateMatch = "span" | "code" | "figure";

export type TextIndex = {
  /** Lowercased `SPAN_WORDS`-word spans, words joined by one space. */
  readonly spans: ReadonlySet<string>;
  /** Numbers of `LONG_FIGURE_DIGITS` or more digits, separators removed. */
  readonly figures: ReadonlySet<string>;
  /** Numbers of three to five digits (separators removed): they count only two at a time. */
  readonly shortFigures: ReadonlySet<string>;
  /** Account-like codes, separators removed, lowercased. */
  readonly codes: ReadonlySet<string>;
};

/** The host's own mask tokens (`[email]`, `[REDACTED]`): never a span word, and a span never crosses one. */
const MASK_TOKEN = /\[(?:email|phone|id|card|nik|npwp|account|name|redacted)\]/giu;
/** Format characters (zero-width joiners, bidi marks) and combining marks, removed after NFKC. */
const INVISIBLE = /[\p{Cf}\p{M}]/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const NUMBER = /\d+(?:[.,]\d+)*/gu;
const CODE = /[\p{L}\p{N}]+(?:[-/._][\p{L}\p{N}]+)*/gu;
const YEAR = /^(?:19|20)\d{2}$/;
const HEX_BLOB = new RegExp(`(?<![0-9a-z])[0-9a-f]{${BLOB_MIN_CHARS},}(?![0-9a-z])`, "iu");
const B64_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${BLOB_MIN_CHARS},}`, "gu");

/**
 * Compatibility-decomposed, without format characters and combining marks, then composed again: a zero-width
 * space cannot split a word, and an accent added to a letter ("sepúluh") cannot hide it. Both sides of every
 * comparison go through it, so folding accents only ever makes them match more.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFKD").replace(INVISIBLE, "").normalize("NFKC");
}

function segments(text: string): string[] {
  return normalizeText(text).split(MASK_TOKEN);
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

/**
 * English and Indonesian function words. A span made mostly of them ("is one of the most", "dan yang akan
 * di") is ordinary phrasing, not a document's own sentence, so it never counts as private.
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  [
    // English
    "a an the and or but if of to in on at by for with from as is are was were be been being it its this",
    "that these those we you they he she i our your their his her my not no do does did has have had will",
    "would can could should may might must shall than then so such also about into over under more most",
    "very all any each which who what when where how there here one",
    // Indonesian
    "yang dan di ke dari untuk dengan pada dalam atau ini itu adalah akan telah sudah belum tidak bukan",
    "juga oleh sebagai karena agar bahwa jika kami kita saya anda mereka dia ia nya para pun lah kah serta",
    "atas tentang secara hingga sampai setiap tersebut dapat bisa harus ada lebih sangat masih hanya saat",
    "antara bagi per se yaitu yakni",
  ]
    .join(" ")
    .split(" "),
);

/** True when the word is written as a name: starts with a capital letter, or is a number. */
function capitalised(word: string): boolean {
  return /^[\p{Lu}\p{N}]/u.test(word);
}

/** A run of capitalised words and name connectors, with at least two capitalised: a proper name or a title. */
function nameLike(window: readonly string[]): boolean {
  const named = window.filter(capitalised).length;
  return named >= 2 && window.every((word) => capitalised(word) || NAME_CONNECTORS.has(word));
}

/** At least `SPAN_MEANINGFUL_WORDS` words of the window are not stopwords. */
function meaningful(window: readonly string[]): boolean {
  return window.filter((word) => !STOPWORDS.has(word.toLowerCase())).length >= SPAN_MEANINGFUL_WORDS;
}

/**
 * The spans of one text. With `privateRules`, a span written as a name is left out (`nameLike`): a company,
 * a regulator or a statute ("PT Bank Central Asia Tbk", "No. 40 Tahun 2007 tentang Perseroan"), which a
 * research query names on purpose, not a sentence lifted from a document; and so is a span of mostly
 * stopwords (`meaningful`).
 */
function spansOf(text: string, privateRules: boolean): Set<string> {
  const spans = new Set<string>();
  for (const segment of segments(text)) {
    const words = segment.match(WORD) ?? [];
    for (let start = 0; start + SPAN_WORDS <= words.length; start += 1) {
      const window = words.slice(start, start + SPAN_WORDS);
      if (privateRules && (nameLike(window) || !meaningful(window))) {
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

type Numbers = { figures: Set<string>; shortFigures: Set<string>; codes: Set<string> };

function numbersOf(text: string): Numbers {
  const out: Numbers = { figures: new Set(), shortFigures: new Set(), codes: new Set() };
  for (const segment of segments(text)) {
    for (const match of segment.match(NUMBER) ?? []) {
      const digits = match.replace(/[.,]/g, "");
      if (isFigure(digits)) {
        (digits.length >= LONG_FIGURE_DIGITS ? out.figures : out.shortFigures).add(digits);
      }
    }
    for (const token of segment.match(CODE) ?? []) {
      if (isCode(token)) {
        out.codes.add(token.replace(/[-/._]/g, "").toLowerCase());
      }
    }
  }
  return out;
}

/** Index of the run's private material: names and stopword runs are left out of the spans, see `spansOf`. */
export function indexPrivate(text: string): TextIndex {
  return { spans: spansOf(text, true), ...numbersOf(text) };
}

/** Index of private text that counts for its figures and codes only (earlier-chat titles). */
export function indexFiguresOnly(text: string): TextIndex {
  return { spans: new Set(), ...numbersOf(text) };
}

/** Index of the person's own messages and of an outgoing query: every span counts. */
export function indexPlain(text: string): TextIndex {
  return { spans: spansOf(text, false), ...numbersOf(text) };
}

function decodeRuns(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * A query or address as a person would read it: `+` as a space, and each percent-encoded run decoded on its
 * own (a malformed `%zz` elsewhere cannot keep the rest encoded), repeated up to three times so a
 * double-encoded address is read too.
 */
export function readableUrl(url: string): string {
  let text = url.replace(/\+/g, " ");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeRuns(text);
    if (next === text) {
      break;
    }
    text = next.replace(/\+/g, " ");
  }
  return normalizeText(text);
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

/**
 * The text with every token the person typed themselves taken out (a token of 8 or more characters that
 * appears verbatim in `userText`), so a key or an id the person pasted is theirs to search for.
 */
function withoutTyped(text: string, userText: string): string {
  if (!userText) {
    return text;
  }
  return text
    .split(/\s+/u)
    .filter((token) => token.length < 8 || !userText.includes(token))
    .join(" ");
}

/**
 * What is wrong with the shape of a search query, checked on every backend, tainted or not. Something the
 * person typed verbatim is exempt: a long question they wrote, a key or an id they pasted.
 */
export function queryShapeProblem(query: string, userText = ""): ShapeProblem | null {
  const text = normalizeText(query);
  if (text.length > SEARCH_QUERY_MAX_CHARS && !userText.includes(query.trim())) {
    return "too_long";
  }
  const own = withoutTyped(text, userText);
  if (hasCredential(own)) {
    return "credential";
  }
  return hasBlob(own) ? "blob" : null;
}

/** A host label that packs data: longer than `HOST_LABEL_MAX_CHARS`, hex or base64, or 20+ with 5+ digits. */
function suspectLabel(label: string): boolean {
  const digits = label.replace(/\D/g, "").length;
  return label.length > HOST_LABEL_MAX_CHARS || hasBlob(label) || (label.length >= 20 && digits >= 5);
}

/**
 * What is wrong with the shape of a page address the model wrote: a credential anywhere, a host label that
 * packs data, a path, query and fragment that are too long once decoded, or an encoded blob in them.
 */
export function urlShapeProblem(url: string, userText = ""): ShapeProblem | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (hasCredential(withoutTyped(readableUrl(url), userText))) {
    return "credential";
  }
  if (parsed.hostname.split(".").some(suspectLabel)) {
    return "blob";
  }
  const rest = readableUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  if (rest.length > URL_REST_MAX_CHARS) {
    return "too_long";
  }
  const own = withoutTyped(rest.replace(/[?&=#]/g, " "), userText);
  return hasBlob(own) ? "blob" : null;
}

/**
 * What `text` shares with the private material that the person's own messages do not also hold: a span or
 * a code first (they identify a document), then a long figure, then two short figures in one text. A phrase
 * or a number the person typed is theirs to search for.
 */
export function privateMatch(text: string, privateIndex: TextIndex, userIndex: TextIndex): PrivateMatch | null {
  const outgoing = indexPlain(text);
  const leaks = (out: ReadonlySet<string>, priv: ReadonlySet<string>, user: ReadonlySet<string>) =>
    [...out].filter((item) => priv.has(item) && !user.has(item));
  if (leaks(outgoing.spans, privateIndex.spans, userIndex.spans).length > 0) {
    return "span";
  }
  if (leaks(outgoing.codes, privateIndex.codes, userIndex.codes).length > 0) {
    return "code";
  }
  if (leaks(outgoing.figures, privateIndex.figures, userIndex.figures).length > 0) {
    return "figure";
  }
  return leaks(outgoing.shortFigures, privateIndex.shortFigures, userIndex.shortFigures).length >= 2
    ? "figure"
    : null;
}

/** True when `text` shares anything private (`privateMatch`). */
export function carriesPrivate(text: string, privateIndex: TextIndex, userIndex: TextIndex): boolean {
  return privateMatch(text, privateIndex, userIndex) !== null;
}
