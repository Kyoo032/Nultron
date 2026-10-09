/**
 * A `DocxDocument` made from plain text, so a PDF (read to text by the host's local extractor) goes through
 * the same clause splitter, quote finder and review pipeline as a Word file.
 *
 * Paragraphs are the blocks between blank lines; a page marker (`<!-- page N -->`, which both PDF readers
 * emit) also ends a block. A block that wraps over several lines keeps its line breaks, because the quote
 * matcher already joins hyphenated line breaks and collapses whitespace, and joining here would only lose
 * information. Clause numbers and headings are read by the same functions the Word reader uses.
 *
 * A text file has no tracked changes, no comments and no tables, so those are empty. Which page each
 * paragraph is on is not part of `DocxDocument`; `plainTextPages` returns it for the caller to keep beside it.
 *
 * Pure. No file access, no model call.
 */
import { detectDefinedTerms, detectHeading, detectNumber } from "./paragraph-analysis";
import { anchorOf } from "./read-body";
import type { DefinedTerm, DocxDocument, DocxParagraph, ParagraphAnchor } from "./types";

const LINE_BREAK = /\r?\n/;
const PAGE_MARKER = /^\s*<!--\s*page\s+(\d+)\s*-->\s*$/i;
const WHITESPACE = /\s+/;
const FIRST_PAGE = 1;
/**
 * A block longer than this is not a paragraph a contract is written in (a page of text with no break in it, or a
 * crafted file); looking for defined terms in it costs far more than it is worth, so it has none.
 */
const DEFINED_TERMS_MAX_BLOCK_CHARS = 20_000;
const UPPERCASE_START = /^[\p{Lu}"'“‘([]/u;

type Block = { readonly text: string; readonly page: number };

/**
 * A line that opens a numbered clause on its own ("2.1 The Lender grants...", "Article VII", "(b) the Borrower...").
 * PDF readers put a clause's heading and body on neighbouring lines with no blank between, so a blank line alone
 * would run clauses together. A number followed by lower-case text ("1.500.000.000 in total") is a wrapped figure,
 * not a clause. A false split is harmless: the quote matcher reads a paragraph break as whitespace.
 */
function opensClause(line: string): boolean {
  const number = detectNumber(line);
  if (!number) {
    return false;
  }
  return number.kind === "paren" || UPPERCASE_START.test(line.slice(number.length).trimStart());
}

/** The blocks of `text` and the page each starts on. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let lines: string[] = [];
  let blockPage = FIRST_PAGE;
  let page = FIRST_PAGE;
  const flush = (): void => {
    if (lines.length > 0) {
      blocks.push({ text: lines.join("\n"), page: blockPage });
      lines = [];
    }
  };
  for (const raw of text.split(LINE_BREAK)) {
    const marker = PAGE_MARKER.exec(raw);
    if (marker) {
      flush();
      page = Number.parseInt(marker[1] as string, 10);
      continue;
    }
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (lines.length > 0 && opensClause(line)) {
      flush();
    }
    if (lines.length === 0) {
      blockPage = page;
    }
    lines.push(line);
  }
  flush();
  return blocks;
}

function paragraphOf(block: Block, index: number): DocxParagraph {
  const number = detectNumber(block.text);
  return {
    anchor: anchorOf(index),
    index,
    style: "",
    number: number?.token ?? "",
    text: block.text,
    originalText: block.text,
    runs: [{ text: block.text }],
    isHeading: detectHeading(block.text, "", number),
  };
}

/** The document `text` reads as: one paragraph per block, no revisions, comments or tables. */
export function documentFromPlainText(text: string): DocxDocument {
  const paragraphs = blocksOf(text).map(paragraphOf);
  const definedTerms: DefinedTerm[] = paragraphs.flatMap((paragraph) =>
    paragraph.text.length > DEFINED_TERMS_MAX_BLOCK_CHARS ? [] : detectDefinedTerms(paragraph.text, paragraph.anchor),
  );
  const words = paragraphs.reduce(
    (total, paragraph) => total + paragraph.text.split(WHITESPACE).filter((word) => word !== "").length,
    0,
  );
  return {
    paragraphs,
    tables: [],
    revisions: [],
    comments: [],
    definedTerms,
    meta: { title: "", author: "", created: "", modified: "" },
    stats: { paragraphs: paragraphs.length, words, tables: 0, insertions: 0, deletions: 0, comments: 0 },
  };
}

/** The page (1-based) each paragraph of `documentFromPlainText(text)` starts on, keyed by its anchor. */
export function plainTextPages(text: string): Record<ParagraphAnchor, number> {
  return Object.fromEntries(blocksOf(text).map((block, index) => [anchorOf(index), block.page])) as Record<
    ParagraphAnchor,
    number
  >;
}
