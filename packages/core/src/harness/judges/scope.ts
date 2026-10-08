/**
 * Scope: what a document answer must not do. It must not advise ("you should terminate"), and it must not
 * lean on law the documents never cite ("under UU No. 11 Tahun 2020" when no document says so).
 *
 * Both rules are deliberately conservative, because a false hit costs a repair call: advice is flagged
 * only for the second-person and "we recommend" forms, in English and Indonesian; text inside quotation
 * marks, a sentence that sits in a source word for word, and a sentence that is reporting what a clause
 * says ("the contract states that the Client must pay") are left alone. Citations are flagged only for
 * statutes written in a recognisable form (Indonesian statutes and Civil Code articles, US Code and CFR),
 * and only when no source cites the same one; a bare "Pasal 5" is the document's own article and is never
 * a statute. Pure; no model call.
 */
import { normaliseForMatch } from "./normalise";

/** A source document: its text, or the `{ id, text }` the quote matcher takes (the id is not read). */
export type ScopeSource = string | { readonly text: string; readonly id?: string };

export type ScopeHit = {
  readonly kind: "advice" | "citation";
  /** The phrase or citation as written. */
  readonly text: string;
  /** Where it starts in the text that was checked. */
  readonly index: number;
  /** The sentence it sits in, trimmed. */
  readonly sentence: string;
};

// -- advice ---------------------------------------------------------------------------------------

const ADVICE_PATTERNS: readonly RegExp[] = [
  /\b(?:you\s+(?:should|must|ought\s+to|need\s+to)|the\s+client\s+(?:should|must|ought\s+to|needs?\s+to))\b/gi,
  /\b(?:we|i)\s+(?:strongly\s+)?(?:recommend|advise|suggest)\b/gi,
  /\bsebaiknya\b/gi,
  // "disarankan" is advice as a sentence opener or before "untuk/agar/...", not in "harga yang disarankan produsen".
  /(?<=^|[.!?]\s+|\n\s*)disarankan\b/gi,
  /\bdisarankan\s+(?:untuk|agar|supaya|bahwa|kepada|bagi)\b/gi,
  /\bkami\s+(?:sarankan|menyarankan|rekomendasikan|merekomendasikan)\b/gi,
  /\banda\s+(?:harus|perlu|sebaiknya|wajib)\b/gi,
];

/**
 * Words before a "you must" that say the sentence is describing a document, not telling the reader what
 * to do: reporting verbs, "under / according to", a clause reference, and the Indonesian counterparts.
 */
const DOCUMENT_CONTEXT = new RegExp(
  `\\b(?:${[
    "states?",
    "provides?",
    "requires?",
    "says?",
    "stipulates?",
    "specif(?:y|ies)",
    "mandates?",
    "obliges?",
    "under",
    "per",
    "pursuant\\s+to",
    "according\\s+to",
    "in\\s+accordance\\s+with",
    "clause",
    "section",
    "article",
    "paragraph",
    "schedule",
    "annex",
    "menyatakan",
    "menyebutkan",
    "menyebut",
    "mengatur",
    "menentukan",
    "mensyaratkan",
    "menetapkan",
    "berbunyi",
    "tercantum",
    "disebutkan",
    "dinyatakan",
    "diatur",
    "ditentukan",
    "menurut",
    "berdasarkan",
    "sesuai",
    "sebagaimana",
    "pasal",
    "ayat",
  ].join("|")})\\b|\\u00A7`,
  "i",
);

const QUOTED_SPAN = /["“”„«»][^"“”„«»]*["“”„«»]/g;
const SENTENCE_END = /[.!?]/;
const WHITESPACE = /\s/;
const COPIED_SENTENCE_MIN_CHARS = 12;

function blankQuoted(text: string): string {
  return text.replace(QUOTED_SPAN, (span) => " ".repeat(span.length));
}

function sentenceBounds(text: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  while (start > 0) {
    const previous = text.charAt(start - 1);
    if (previous === "\n" || (SENTENCE_END.test(previous) && WHITESPACE.test(text.charAt(start)))) {
      break;
    }
    start -= 1;
  }
  let end = to;
  while (end < text.length) {
    const here = text.charAt(end);
    if (here === "\n") {
      break;
    }
    if (SENTENCE_END.test(here) && (end + 1 >= text.length || WHITESPACE.test(text.charAt(end + 1)))) {
      end += 1;
      break;
    }
    end += 1;
  }
  return { start, end };
}

type Found = { readonly kind: ScopeHit["kind"]; readonly text: string; readonly index: number };

function adviceIn(text: string): Found[] {
  const scanned = blankQuoted(text);
  const found: Found[] = [];
  for (const pattern of ADVICE_PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      found.push({
        kind: "advice",
        text: text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length),
        index: match.index ?? 0,
      });
    }
  }
  return found;
}

/** Drop a hit that overlaps an earlier one, so "Anda sebaiknya" is one hit and not two. */
function withoutOverlaps(found: readonly Found[]): Found[] {
  const ordered = [...found].sort((left, right) => left.index - right.index || right.text.length - left.text.length);
  const kept: Found[] = [];
  let reached = -1;
  for (const hit of ordered) {
    if (hit.index >= reached) {
      kept.push(hit);
      reached = hit.index + hit.text.length;
    }
  }
  return kept;
}

// -- citations ------------------------------------------------------------------------------------

type CitationRule = {
  readonly pattern: RegExp;
  /** A key that is the same for the same statute however it is written, or null to skip the match. */
  readonly keyOf: (match: RegExpMatchArray) => string | null;
};

const STATUTE_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^undang-undang$/, "uu"],
  [/^peraturan pemerintah$/, "pp"],
  [/^peraturan presiden$/, "perpres"],
  [/^peraturan menteri$/, "permen"],
  [/^permen/, "permen"],
];

function statuteFamily(name: string): string {
  const lower = name.toLowerCase().replace(/\s+/g, " ");
  return STATUTE_FAMILIES.find(([pattern]) => pattern.test(lower))?.[1] ?? lower;
}

const CODE_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:kuhperdata|kuhper|kitabundang-undanghukumperdata|(?:indonesian)?civilcode)$/, "kuhperdata"],
  [/^(?:kuhp|kitabundang-undanghukumpidana|(?:indonesian)?criminalcode)$/, "kuhp"],
  [/^(?:kuhap|kitabundang-undanghukumacarapidana)$/, "kuhap"],
  [/^(?:kuhd|kuhdagang|kitabundang-undanghukumdagang|(?:indonesian)?commercialcode)$/, "kuhd"],
];

function codeName(name: string): string {
  const squeezed = name.toLowerCase().replace(/\s+/g, "");
  return CODE_NAMES.find(([pattern]) => pattern.test(squeezed))?.[1] ?? squeezed;
}

const CITATION_RULES: readonly CitationRule[] = [
  {
    pattern:
      /\b(UU|Undang-Undang|Perppu|PP|Peraturan\s+Pemerintah|Perpres|Peraturan\s+Presiden|Permen[a-z]*|Peraturan\s+Menteri|POJK|SEOJK|Perda)\s+(?:No\.?|Nomor)\s*(\d+[A-Za-z]?)(?:\s*(?:Tahun|\/)\s*(\d{4}))?/gi,
    keyOf: (match) => `statute:${statuteFamily(match[1] ?? "")}:${match[2]}/${match[3] ?? ""}`,
  },
  {
    pattern: /\bUU\s+(?!NO\b|NOMOR\b)([A-Z]{2,6})\b/g,
    keyOf: (match) => `statute-name:uu:${(match[1] ?? "").toLowerCase()}`,
  },
  {
    pattern:
      /\bPasal\s+(\d+[A-Za-z]?)(?:\s+ayat\s+\(?\d+\)?)?(?:\s+huruf\s+[a-z]\b)?\s+(KUH\s?Perdata|KUHPer|KUHP|KUHAP|KUHD|KUH\s?Dagang|Kitab\s+Undang-Undang\s+Hukum\s+(?:Perdata|Pidana|Dagang|Acara\s+Pidana))\b/gi,
    keyOf: (match) => `article:${codeName(match[2] ?? "")}:${(match[1] ?? "").toLowerCase()}`,
  },
  {
    pattern: /\bArticle\s+(\d+[A-Za-z]?)\s+of\s+the\s+((?:Indonesian\s+)?(?:Civil|Criminal|Commercial)\s+Code)\b/gi,
    keyOf: (match) => `article:${codeName(match[2] ?? "")}:${(match[1] ?? "").toLowerCase()}`,
  },
  {
    pattern: /\b(\d{1,3})\s+U\.?\s?S\.?\s?C\.?\s*(?:§+|sec(?:tion|\.)?)?\s*(\d+[A-Za-z0-9()-]*)/gi,
    keyOf: (match) => `usc:${match[1]}:${(match[2] ?? "").toLowerCase()}`,
  },
  {
    pattern: /\b(\d{1,3})\s+C\.?F\.?R\.?\s*(?:§+|part|sec(?:tion|\.)?)?\s*(\d+(?:\.\d+)?)/gi,
    keyOf: (match) => `cfr:${match[1]}:${match[2]}`,
  },
];

type Citation = Found & { readonly key: string };

function citationsIn(text: string): Citation[] {
  const found: Citation[] = [];
  for (const rule of CITATION_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const key = rule.keyOf(match);
      if (key !== null) {
        found.push({ kind: "citation", text: match[0].trim(), index: match.index ?? 0, key });
      }
    }
  }
  return found;
}

/** A statute cited without a year matches the same number with any year, and the other way round. */
function citedBySources(key: string, cited: ReadonlySet<string>): boolean {
  if (cited.has(key)) {
    return true;
  }
  const slash = key.lastIndexOf("/");
  if (!key.startsWith("statute:") || slash === -1) {
    return false;
  }
  const head = key.slice(0, slash + 1);
  return key.endsWith("/") ? [...cited].some((other) => other.startsWith(head)) : cited.has(head);
}

// -- the judge ------------------------------------------------------------------------------------

function textOf(source: ScopeSource): string {
  return typeof source === "string" ? source : source.text;
}

function sentenceIsCopied(sentence: string, sourceViews: () => readonly string[]): boolean {
  const value = normaliseForMatch(sentence, { foldCase: true }).value;
  return value.length >= COPIED_SENTENCE_MIN_CHARS && sourceViews().some((view) => view.includes(value));
}

/**
 * Advice and uncited statutes in `text`, in the order they occur. `sources` are the documents the answer
 * must stay inside: a sentence copied from one is never advice, and a statute one of them cites is fine.
 */
export function scopeHits(text: string, sources: readonly ScopeSource[]): ScopeHit[] {
  let views: string[] | null = null;
  const sourceViews = (): readonly string[] => {
    views ??= sources.map((source) => normaliseForMatch(textOf(source), { foldCase: true }).value);
    return views;
  };
  const hits: ScopeHit[] = [];
  for (const hit of withoutOverlaps(adviceIn(text))) {
    const { start, end } = sentenceBounds(text, hit.index, hit.index + hit.text.length);
    const sentence = text.slice(start, end).trim();
    const before = text.slice(start, hit.index);
    if (DOCUMENT_CONTEXT.test(before) || sentenceIsCopied(sentence, sourceViews)) {
      continue;
    }
    hits.push({ ...hit, sentence });
  }
  const citations = citationsIn(text);
  if (citations.length > 0) {
    const cited = new Set(sources.flatMap((source) => citationsIn(textOf(source)).map((found) => found.key)));
    for (const citation of citations) {
      if (!citedBySources(citation.key, cited)) {
        const { start, end } = sentenceBounds(text, citation.index, citation.index + citation.text.length);
        hits.push({
          kind: "citation",
          text: citation.text,
          index: citation.index,
          sentence: text.slice(start, end).trim(),
        });
      }
    }
  }
  return hits.sort((left, right) => left.index - right.index);
}
