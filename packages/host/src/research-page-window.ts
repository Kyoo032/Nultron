import { meaningfulWords } from "@agentforge/core";

export type PageFocus = { question: string; snippet: string };

const LEAD_CHARS = 600;
const GAP = "\n\n…\n\n";
const QUESTION_WEIGHT = 2;
const SNIPPET_WEIGHT = 1;

type Block = { index: number; start: number; text: string };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /\n{2,}/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const end = match.index ?? start;
    if (end > start) {
      blocks.push({ index: blocks.length, start, text: text.slice(start, end) });
    }
    start = end + match[0].length;
  }
  if (start < text.length) {
    blocks.push({ index: blocks.length, start, text: text.slice(start) });
  }
  return blocks;
}

function matches(word: string, found: ReadonlySet<string>): boolean {
  if (found.has(word)) {
    return true;
  }
  if (word.length < 4) {
    return false;
  }
  for (const other of found) {
    const [shorter, longer] = word.length <= other.length ? [word, other] : [other, word];
    if (shorter.length >= 4 && longer.startsWith(shorter)) {
      return true;
    }
  }
  return false;
}

function scoreBlock(text: string, question: readonly string[], snippet: readonly string[]): number {
  const found = new Set(meaningfulWords(text));
  const fromQuestion = question.filter((word) => matches(word, found)).length;
  const fromSnippet = snippet.filter((word) => matches(word, found)).length;
  return fromQuestion * QUESTION_WEIGHT + fromSnippet * SNIPPET_WEIGHT;
}

function clipAround(block: Block, words: readonly string[], room: number): string {
  const lower = block.text.toLowerCase();
  const hits = words.map((word) => lower.indexOf(word)).filter((at) => at >= 0);
  const first = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(first - Math.floor(room / 3), block.text.length - room));
  return block.text.slice(start, start + room);
}

export function pageWindow(text: string, focus: PageFocus, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const blocks = splitBlocks(text);
  const question = [...new Set(meaningfulWords(focus.question))];
  const snippet = [...new Set(meaningfulWords(focus.snippet))].filter((word) => !question.includes(word));
  const [head, ...rest] = blocks;
  if (!head) {
    return text.slice(0, maxChars);
  }
  const ranked = rest
    .map((block) => ({ block, score: scoreBlock(block.text, question, snippet) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.block.index - b.block.index);
  if (ranked.length === 0) {
    return text.slice(0, maxChars);
  }
  const lead = head.text.slice(0, LEAD_CHARS);
  let room = maxChars - lead.length;
  const chosen: Array<{ index: number; text: string }> = [];
  for (const { block } of ranked) {
    const cost = GAP.length + block.text.length;
    if (cost <= room) {
      chosen.push({ index: block.index, text: block.text });
      room -= cost;
    } else if (chosen.length === 0 && room > GAP.length) {
      chosen.push({ index: block.index, text: clipAround(block, [...question, ...snippet], room - GAP.length) });
      room = 0;
    }
    if (room <= GAP.length) {
      break;
    }
  }
  const body = chosen.sort((a, b) => a.index - b.index).map((entry) => entry.text);
  return [lead, ...body].join(GAP);
}
