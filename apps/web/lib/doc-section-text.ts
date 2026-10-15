import type { DocBlock, DocSectionInput } from "./docs-client";

export type TableBlock = Extract<DocBlock, { readonly type: "table" }>;

type TextBlock = Exclude<DocBlock, { readonly type: "table" }>;

export type TableAnchor = { readonly block: TableBlock; readonly after: number };

export type SplitSection = { readonly text: string; readonly tables: readonly TableAnchor[] };

const PAGE_BREAK_LINE = "---";
const EMPTY_PARAGRAPH_LINE = "\\";
const ESCAPE_NEEDED = /^(?:\\|-(?: |$)|\d+\.(?: |$)|>|---$)/;
const ESCAPED = /^\\(?:\\|-(?: |$)|\d+\.(?: |$)|>|---$)/;
const BULLET = /^-(?: (.*))?$/;
const NUMBERED = /^\d+\.(?: (.*))?$/;
const QUOTE = /^>(?: (.*))?$/;
const CONTINUATION = /^ {2}(.*)$/;

type Open =
  | { readonly type: "paragraph"; readonly lines: readonly string[] }
  | { readonly type: "bullets" | "numbered"; readonly items: readonly string[] }
  | { readonly type: "quote"; readonly lines: readonly string[] };

type ParseState = { readonly blocks: readonly TextBlock[]; readonly open: Open | null };

export function splitBlocks(blocks: readonly DocBlock[]): SplitSection {
  const text: TextBlock[] = [];
  const tables: TableAnchor[] = [];
  for (const block of blocks) {
    if (block.type === "table") {
      tables.push({ block, after: text.length });
    } else {
      text.push(block);
    }
  }
  return { text: serialize(text), tables };
}

export function joinBlocks(text: string, tables: readonly TableAnchor[]): DocBlock[] {
  const parsed = parseText(text);
  const out: DocBlock[] = [];
  for (let position = 0; position <= parsed.length; position += 1) {
    for (const anchor of tables) {
      if (Math.min(anchor.after, parsed.length) === position) {
        out.push(anchor.block);
      }
    }
    const block = parsed[position];
    if (block !== undefined) {
      out.push(block);
    }
  }
  return out;
}

export function sectionInputOf(heading: string, text: string, tables: readonly TableAnchor[]): DocSectionInput {
  const blocks = joinBlocks(text, tables);
  return heading.trim() === "" ? { blocks } : { heading, blocks };
}

function serialize(blocks: readonly TextBlock[]): string {
  return blocks.map((block) => linesOf(block).join("\n")).join("\n\n");
}

function linesOf(block: TextBlock): string[] {
  switch (block.type) {
    case "paragraph":
      return block.text.split("\n").map(paragraphLine);
    case "bullets":
      return block.items.flatMap((item) => listLines("- ", item));
    case "numbered":
      return block.items.flatMap((item, index) => listLines(`${index + 1}. `, item));
    case "quote":
      return block.text.split("\n").map((line) => `> ${line}`);
    case "pageBreak":
      return [PAGE_BREAK_LINE];
  }
}

function paragraphLine(line: string): string {
  if (line === "") {
    return EMPTY_PARAGRAPH_LINE;
  }
  return ESCAPE_NEEDED.test(line) ? `\\${line}` : line;
}

function listLines(marker: string, item: string): string[] {
  const [first = "", ...rest] = item.split("\n");
  return [`${marker}${first}`, ...rest.map((line) => `  ${line}`)];
}

function parseText(text: string): readonly TextBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return closed(lines.reduce<ParseState>(accept, { blocks: [], open: null }));
}

function accept(state: ParseState, line: string): ParseState {
  if (line === "") {
    return { blocks: closed(state), open: null };
  }
  if (line === PAGE_BREAK_LINE) {
    return { blocks: [...closed(state), { type: "pageBreak" }], open: null };
  }
  const bullet = BULLET.exec(line);
  if (bullet) {
    return addListItem(state, "bullets", bullet[1] ?? "");
  }
  const numbered = NUMBERED.exec(line);
  if (numbered) {
    return addListItem(state, "numbered", numbered[1] ?? "");
  }
  const quote = QUOTE.exec(line);
  if (quote) {
    return addQuoteLine(state, quote[1] ?? "");
  }
  const continuation = CONTINUATION.exec(line);
  const open = state.open;
  if (continuation && open !== null && (open.type === "bullets" || open.type === "numbered")) {
    const last = open.items.length - 1;
    const items = open.items.map((item, index) => (index === last ? `${item}\n${continuation[1] ?? ""}` : item));
    return { blocks: state.blocks, open: { type: open.type, items } };
  }
  return addParagraphLine(state, unescapeLine(line));
}

function closed(state: ParseState): readonly TextBlock[] {
  return state.open === null ? state.blocks : [...state.blocks, finish(state.open)];
}

function finish(open: Open): TextBlock {
  if (open.type === "paragraph") {
    return { type: "paragraph", text: open.lines.join("\n") };
  }
  if (open.type === "quote") {
    return { type: "quote", text: open.lines.join("\n") };
  }
  return { type: open.type, items: [...open.items] };
}

function addListItem(state: ParseState, type: "bullets" | "numbered", item: string): ParseState {
  const open = state.open;
  if (open !== null && (open.type === "bullets" || open.type === "numbered") && open.type === type) {
    return { blocks: state.blocks, open: { type, items: [...open.items, item] } };
  }
  return { blocks: closed(state), open: { type, items: [item] } };
}

function addQuoteLine(state: ParseState, line: string): ParseState {
  const open = state.open;
  if (open !== null && open.type === "quote") {
    return { blocks: state.blocks, open: { type: "quote", lines: [...open.lines, line] } };
  }
  return { blocks: closed(state), open: { type: "quote", lines: [line] } };
}

function addParagraphLine(state: ParseState, line: string): ParseState {
  const open = state.open;
  if (open !== null && open.type === "paragraph") {
    return { blocks: state.blocks, open: { type: "paragraph", lines: [...open.lines, line] } };
  }
  return { blocks: closed(state), open: { type: "paragraph", lines: [line] } };
}

function unescapeLine(line: string): string {
  if (line === EMPTY_PARAGRAPH_LINE) {
    return "";
  }
  return ESCAPED.test(line) ? line.slice(1) : line;
}
