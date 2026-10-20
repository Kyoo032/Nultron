import { isHostNoteLine } from "./markers";

export type UserTextSegment =
  | { type: "text"; text: string }
  | { type: "file"; name: string; body: string; notes?: string[] };

const FILE_HEADER = /^---\s+(.+?)\s+---$/;

function headerName(line: string): string {
  return FILE_HEADER.exec(line)?.[1]?.trim() ?? "";
}

function splitTrailingNotes(lines: ReadonlyArray<string>): { rest: string[]; notes: string[] } {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
    end -= 1;
  }
  let start = end;
  while (start > 0 && isHostNoteLine(lines[start - 1] ?? "")) {
    start -= 1;
  }
  return start === end
    ? { rest: [...lines], notes: [] }
    : { rest: lines.slice(0, start), notes: lines.slice(start, end) };
}

export function splitUserFileBlocks(text: string): UserTextSegment[] {
  const lines = text.split("\n");
  const segments: UserTextSegment[] = [];
  let textLines: string[] = [];
  let carried: string[] = [];
  const flush = () => {
    const joined = textLines.join("\n").trim();
    textLines = [];
    if (joined) {
      segments.push({ type: "text", text: joined });
    }
  };
  let index = 0;
  while (index < lines.length) {
    const name = headerName(lines[index] ?? "");
    if (name) {
      const above = splitTrailingNotes(textLines);
      textLines = above.rest;
      const notes = carried.length > 0 ? carried : above.notes;
      carried = [];
      flush();
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !headerName(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      const below = index < lines.length ? splitTrailingNotes(body) : { rest: body, notes: [] };
      carried = below.notes;
      segments.push({
        type: "file",
        name,
        body: below.rest.join("\n").trim(),
        ...(notes.length > 0 ? { notes } : {}),
      });
      continue;
    }
    textLines.push(lines[index] ?? "");
    index += 1;
  }
  flush();
  if (segments.length === 0) {
    return [{ type: "text", text }];
  }
  return segments;
}
