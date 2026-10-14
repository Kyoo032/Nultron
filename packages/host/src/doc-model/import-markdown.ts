/**
 * Markdown to a document spec: how an uploaded file becomes the editable model. The converter gives
 * Markdown for a Word file, a PDF and a deck; this reads it back into sections and blocks so a person
 * can edit one part and keep the rest.
 *
 * What is read: `#` and `##` start a section (ids `s1`, `s2`, ... in order). Text before the first
 * heading is a section with no heading. Lines of text join into a paragraph until a blank line.
 * `-` and `*` make bullets, `1.` makes a numbered list, `>` a quote, and a GFM pipe table becomes a
 * table block. A `---` line is a page break only when it stands alone between two sections; anywhere
 * else it is dropped. Deeper headings (`###`) read as paragraphs.
 *
 * The caps in `limits.ts` apply, so a document over one is refused by `parseDocSpec` with the count
 * sent, never truncated.
 */
import type { DocThemeName } from "./themes";
import { parseDocSpec, type Block, type DocSpec } from "./types";

export type MarkdownImportOptions = {
  /** Shown as the document title. When absent, the first heading is used, else a default. */
  readonly title?: string;
  readonly theme?: DocThemeName;
};

type Chunk = { readonly heading?: string; readonly blocks: Block[] };

/** What one line or run of lines reads as. `next` is always past the lines it consumed. */
type Step = {
  readonly next: number;
  readonly heading?: string;
  readonly block?: Block;
  readonly rule?: boolean;
};

const DEFAULT_TITLE = "Imported document";
const TITLE_MAX = 300;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** A line that is only bold text reads as a section heading. The converter writes Word headings this way. */
const BOLD_HEADING = /^\*\*(\S(?:[^*]{0,118}\S)?)\*\*$/;
const BULLET = /^\s{0,3}[-*]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const ALIGNMENT_CELL = /^:?-+:?$/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** A `#` or `##` heading, or a bold-only line, starts a section. `###` and deeper are ordinary text. */
function sectionHeading(line: string): string | undefined {
  const match = HEADING.exec(line);
  if (match) {
    return match[1].length <= 2 ? unwrapBold(match[2]) : undefined;
  }
  return BOLD_HEADING.exec(line.trim())?.[1];
}

/** The converter writes a Word heading as `# **Summary**`; the heading text is the words inside. */
function unwrapBold(text: string): string {
  return BOLD_HEADING.exec(text.trim())?.[1] ?? text;
}

/** Cells of one pipe row. An escaped pipe is a character in the cell, never a separator. */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|") && !body.endsWith("\\|")) {
    body = body.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const alignment = lines[index + 1];
  if (alignment === undefined || !header.includes("|")) {
    return false;
  }
  const alignmentCells = splitRow(alignment);
  return alignmentCells.every((cell) => ALIGNMENT_CELL.test(cell)) && alignmentCells.length === splitRow(header).length;
}

/** Lines that open a block of their own, so a paragraph stops in front of them. */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  return (
    HEADING.test(line) ||
    sectionHeading(line) !== undefined ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line) ||
    isTableStart(lines, index)
  );
}

function readParagraph(lines: readonly string[], start: number): Step {
  const parts: string[] = [];
  let index = start;
  while (index < lines.length && !isBlank(lines[index]) && (index === start || !startsBlock(lines, index))) {
    parts.push(lines[index].trim());
    index += 1;
  }
  return { next: index, block: { type: "paragraph", text: parts.join(" ") } };
}

function readTable(lines: readonly string[], start: number): Step {
  const columns = splitRow(lines[start]).map(unwrapBold);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && !isBlank(lines[index]) && lines[index].includes("|")) {
    const cells = splitRow(lines[index]).map(unwrapBold);
    // GFM: a short row is padded with empty cells and a long row loses the cells past the header.
    rows.push(Array.from({ length: columns.length }, (_, position) => cells[position] ?? ""));
    index += 1;
  }
  return { next: index, block: { type: "table", columns, rows } };
}

/** One list, bullets or numbered. An indented or plain line after an item continues that item. */
function readList(lines: readonly string[], start: number, marker: RegExp, type: "bullets" | "numbered"): Step {
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = marker.exec(lines[index]);
    if (match) {
      items.push(match[1].trim());
    } else if (!isBlank(lines[index]) && !startsBlock(lines, index) && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${lines[index].trim()}`;
    } else {
      break;
    }
    index += 1;
  }
  return { next: index, block: { type, items } };
}

function readQuote(lines: readonly string[], start: number): Step {
  const parts: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE.exec(lines[index]);
    if (!match) {
      break;
    }
    if (match[1].trim().length > 0) {
      parts.push(match[1].trim());
    }
    index += 1;
  }
  return { next: index, block: { type: "quote", text: parts.join(" ") } };
}

/** One step of the reader: the block, heading or rule at `index`, and where the next step starts. */
function readStep(lines: readonly string[], index: number): Step {
  const line = lines[index];
  if (isBlank(line)) {
    return { next: index + 1 };
  }
  const deepHeading = HEADING.exec(line);
  if (deepHeading && deepHeading[1].length > 2) {
    return { next: index + 1, block: { type: "paragraph", text: deepHeading[2] } };
  }
  const heading = sectionHeading(line);
  if (heading !== undefined) {
    return { next: index + 1, heading };
  }
  if (RULE.test(line)) {
    return { next: index + 1, rule: true };
  }
  if (isTableStart(lines, index)) {
    return readTable(lines, index);
  }
  if (BULLET.test(line)) {
    return readList(lines, index, BULLET, "bullets");
  }
  if (NUMBERED.test(line)) {
    return readList(lines, index, NUMBERED, "numbered");
  }
  if (QUOTE.test(line)) {
    return readQuote(lines, index);
  }
  return readParagraph(lines, index);
}

/** True when the next non-blank line from `from` is a `#` or `##` heading. */
function sectionFollows(lines: readonly string[], from: number): boolean {
  const next = lines.findIndex((line, position) => position >= from && !isBlank(line));
  return next !== -1 && sectionHeading(lines[next]) !== undefined;
}

/** Walk the lines once and gather them into sections, the first one headless when there is text first. */
function readChunks(lines: readonly string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { blocks: [] };
  let index = 0;
  while (index < lines.length) {
    const step = readStep(lines, index);
    index = step.next;
    if (step.heading !== undefined) {
      chunks.push(current);
      current = { heading: step.heading, blocks: [] };
    } else if (step.rule) {
      if (current.blocks.length > 0 && sectionFollows(lines, index)) {
        current.blocks.push({ type: "pageBreak" });
      }
    } else if (step.block) {
      current.blocks.push(step.block);
    }
  }
  chunks.push(current);
  // Only the first chunk can be headless, and only it is dropped when it holds nothing.
  return chunks.filter((chunk, position) => position > 0 || chunk.heading !== undefined || chunk.blocks.length > 0);
}

function firstHeading(chunks: readonly Chunk[]): string | undefined {
  const heading = chunks.find((chunk) => chunk.heading?.trim())?.heading?.trim();
  return heading ? heading.slice(0, TITLE_MAX) : undefined;
}

/** Read Markdown into a document spec. Refuses with a `DocModelError` when a cap is exceeded. */
export function docSpecFromMarkdown(markdown: string, options: MarkdownImportOptions = {}): DocSpec {
  const chunks = readChunks(markdown.split(/\r?\n/));
  const sections = chunks.map((chunk, position) => ({
    id: `s${position + 1}`,
    ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
    blocks: chunk.blocks,
  }));
  const title = options.title ?? firstHeading(chunks) ?? DEFAULT_TITLE;
  return parseDocSpec({
    kind: "document",
    title,
    theme: options.theme ?? "plain",
    titlePage: false,
    sections,
  });
}
