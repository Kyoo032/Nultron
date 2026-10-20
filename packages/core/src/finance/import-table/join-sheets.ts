export function fitFiguresToCap(source: string, max: number): string {
  if (source.length <= max) {
    return source;
  }
  if (source.charAt(max) === "\n") {
    return source.slice(0, max).trimEnd();
  }
  const cut = source.lastIndexOf("\n", max);
  return (cut > 0 ? source.slice(0, cut) : source.slice(0, max)).trimEnd();
}

const SHEET_HEAD = /^\s*Sheet:/;

export type JoinedSheets = {
  readonly text: string;
  readonly used: readonly string[];
  readonly skipped: readonly string[];
};

export function joinSheetTexts(sheets: readonly { name: string; text: string }[], max: number): JoinedSheets {
  const present = sheets.filter((sheet) => sheet.text.trim() !== "");
  const several = present.length > 1;
  const used: string[] = [];
  const skipped: string[] = [];
  let joined = "";
  for (const sheet of present) {
    const body = sheet.text.trim();
    const block = several && !SHEET_HEAD.test(body) ? `Sheet: ${sheet.name}\n${body}` : body;
    const next = joined === "" ? block : `${joined}\n${block}`;
    if (next.length <= max) {
      joined = next;
      used.push(sheet.name);
    } else {
      skipped.push(sheet.name);
    }
  }
  const first = present[0];
  if (joined === "" && first) {
    return { text: fitFiguresToCap(first.text.trim(), max), used: [first.name], skipped: skipped.slice(1) };
  }
  return { text: joined, used, skipped };
}
