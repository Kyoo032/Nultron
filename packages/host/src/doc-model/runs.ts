/**
 * Splits a paragraph into runs. `**bold**` and `*italic*` are the only markup; a marker with no
 * closing partner stays as literal text, so a stray asterisk never eats the words after it.
 */
export type TextRun = { readonly text: string; readonly bold: boolean; readonly italic: boolean };

const MARKUP = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*/g;

export function parseRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MARKUP)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      runs.push({ text: text.slice(cursor, start), bold: false, italic: false });
    }
    const bold = match[1] !== undefined;
    runs.push({ text: match[1] ?? match[2] ?? "", bold, italic: !bold });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor), bold: false, italic: false });
  }
  return runs;
}
