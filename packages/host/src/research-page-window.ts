import { meaningfulWords } from "@agentforge/core";

export type PageFocus = { question: string; snippet: string };

const LEAD_CHARS = 600;
const GAP = "\n\n…\n\n";
const QUESTION_WEIGHT = 2;
const SNIPPET_WEIGHT = 1;
const RARITY_FLOOR = 0.05;

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

function sameWord(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function matches(word: string, found: ReadonlySet<string>): boolean {
  if (found.has(word)) {
    return true;
  }
  if (word.length < 4) {
    return false;
  }
  for (const other of found) {
    if (sameWord(word, other)) {
      return true;
    }
  }
  return false;
}

type BlockWords = { block: Block; ordered: string[]; found: ReadonlySet<string> };

function rarity(terms: readonly string[], blocks: readonly BlockWords[]): Map<string, number> {
  const total = blocks.length;
  return new Map(
    terms.map((term) => {
      const seen = blocks.filter((entry) => matches(term, entry.found)).length;
      return [term, Math.log((total + 1) / (seen + 1)) + RARITY_FLOOR] as const;
    }),
  );
}

function adjacentPairs(words: readonly string[]): Array<readonly [string, string]> {
  const pairs = new Map<string, readonly [string, string]>();
  for (let at = 1; at < words.length; at++) {
    const a = words[at - 1] as string;
    const b = words[at] as string;
    if (a !== b) {
      pairs.set(`${a} ${b}`, [a, b]);
    }
  }
  return [...pairs.values()];
}

function hasPair(ordered: readonly string[], [a, b]: readonly [string, string]): boolean {
  for (let at = 1; at < ordered.length; at++) {
    if (sameWord(a, ordered[at - 1] as string) && sameWord(b, ordered[at] as string)) {
      return true;
    }
  }
  return false;
}

function scoreBlock(
  entry: BlockWords,
  terms: { question: readonly string[]; snippet: readonly string[]; pairs: ReadonlyArray<readonly [string, string]> },
  weight: ReadonlyMap<string, number>,
): number {
  const of = (word: string) => weight.get(word) ?? 0;
  const fromQuestion = terms.question
    .filter((word) => matches(word, entry.found))
    .reduce((sum, word) => sum + of(word), 0);
  const fromSnippet = terms.snippet
    .filter((word) => matches(word, entry.found))
    .reduce((sum, word) => sum + of(word), 0);
  const fromPairs = terms.pairs
    .filter((pair) => hasPair(entry.ordered, pair))
    .reduce((sum, [a, b]) => sum + of(a) + of(b), 0);
  return (fromQuestion + fromPairs) * QUESTION_WEIGHT + fromSnippet * SNIPPET_WEIGHT;
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
  const questionWords = meaningfulWords(focus.question);
  const question = [...new Set(questionWords)];
  const snippet = [...new Set(meaningfulWords(focus.snippet))].filter((word) => !question.includes(word));
  const [head, ...rest] = blocks;
  if (!head) {
    return text.slice(0, maxChars);
  }
  const words: BlockWords[] = rest.map((block) => {
    const ordered = meaningfulWords(block.text);
    return { block, ordered, found: new Set(ordered) };
  });
  const weight = rarity([...question, ...snippet], words);
  const terms = { question, snippet, pairs: adjacentPairs(questionWords) };
  const ranked = words
    .map((entry) => ({ block: entry.block, score: scoreBlock(entry, terms, weight) }))
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
