/**
 * The matter's files as evidence: where a quote is, which paragraph and clause and page it is on, and the
 * text around it. Extraction and the ask route both judge the model's quotes through this one object, so a
 * quote is verified the same way in both.
 *
 * Pure over the documents it is given: no file access, no model call.
 */
import { type DocxDocument, splitClauses } from "@agentforge/core/docx";
import { quoteSourceOf, type QuoteSourceOfDoc } from "@agentforge/core/legal";
import { type QuoteMatch, createQuoteIndex, normaliseForMatch, windowAround } from "@agentforge/core/judges";

export type EvidenceDocInput = {
  readonly id: string;
  readonly name: string;
  readonly doc: DocxDocument;
  /** Paragraph anchor -> page, when the reader marked pages. */
  readonly pages: Readonly<Record<string, number>> | null;
};

/** Where in the matter a verified quote sits. */
export type Located = {
  readonly docId: string;
  /** `¶12` or, for a table row, `T0`. */
  readonly anchor: string;
  readonly clauseId: string | null;
  readonly page: number | null;
};

export type VerifiedQuote = { readonly match: QuoteMatch; readonly located: Located };

export type Evidence = {
  readonly docIds: readonly string[];
  /** Every file's text, for the scope judge (is a statute cited in any of them?). */
  readonly texts: readonly { readonly id: string; readonly text: string }[];
  hasDoc(docId: string): boolean;
  /** The quote's place in the files, looked for in `preferDocId` first; null when no file holds it. */
  verify(quote: string, preferDocId: string): VerifiedQuote | null;
  /** The text around a verified quote: `radius` characters either side, for tracing a value to its passage. */
  window(verified: VerifiedQuote, radius?: number): string;
  /** The whole text of one file ("" for an unknown id). */
  textOf(docId: string): string;
  /** A name (a party) written anywhere in the files, ignoring case and spacing. */
  mentions(name: string): boolean;
};

function clauseIndex(doc: DocxDocument): ReadonlyMap<string, string> {
  const byParagraph = new Map<string, string>();
  for (const clause of splitClauses(doc)) {
    for (const anchor of clause.paragraphs) {
      if (!byParagraph.has(anchor)) {
        byParagraph.set(anchor, clause.id);
      }
    }
  }
  return byParagraph;
}

type Prepared = {
  readonly input: EvidenceDocInput;
  readonly source: QuoteSourceOfDoc;
  readonly clauses: ReadonlyMap<string, string>;
};

export function buildEvidence(inputs: readonly EvidenceDocInput[]): Evidence {
  const prepared = new Map<string, Prepared>(
    inputs.map((input) => [
      input.id,
      { input, source: quoteSourceOf(input.id, input.doc), clauses: clauseIndex(input.doc) },
    ]),
  );
  const sources = [...prepared.values()].map((entry) => entry.source);
  const index = createQuoteIndex(sources);
  const verified = new Map<string, VerifiedQuote | null>();
  const folded = new Map<string, string>();

  const foldedText = (docId: string): string => {
    const known = folded.get(docId);
    if (known !== undefined) {
      return known;
    }
    const value = normaliseForMatch(prepared.get(docId)?.source.text ?? "", { foldCase: true }).value;
    folded.set(docId, value);
    return value;
  };

  const locate = (match: QuoteMatch): Located => {
    const entry = prepared.get(match.sourceId) as Prepared;
    const at = entry.source.anchorAt(match.start);
    return {
      docId: match.sourceId,
      anchor: at.anchor,
      clauseId: entry.clauses.get(at.paragraph) ?? null,
      page: entry.input.pages?.[at.paragraph] ?? null,
    };
  };

  return {
    docIds: inputs.map((input) => input.id),
    texts: sources.map((source) => ({ id: source.id, text: source.text })),
    hasDoc: (docId) => prepared.has(docId),
    verify(quote, preferDocId) {
      const key = `${preferDocId}\u0000${quote}`;
      if (verified.has(key)) {
        return verified.get(key) ?? null;
      }
      const match = index.match(quote, preferDocId);
      const result = match ? { match, located: locate(match) } : null;
      verified.set(key, result);
      return result;
    },
    window(found, radius) {
      const text = prepared.get(found.match.sourceId)?.source.text ?? "";
      return windowAround(text, found.match.start, found.match.end, radius);
    },
    textOf: (docId) => prepared.get(docId)?.source.text ?? "",
    mentions(name) {
      const needle = normaliseForMatch(name, { foldCase: true }).value;
      return needle.length > 0 && inputs.some((input) => foldedText(input.id).includes(needle));
    },
  };
}
