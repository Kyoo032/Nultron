import type { DocBlock, DocSection } from "./docs-client";

export type DiffKind = "same" | "removed" | "added";

export type DiffSegment = { readonly kind: DiffKind; readonly text: string };

const MAX_TABLE_CELLS = 1_000_000;

type Op = { readonly kind: DiffKind; readonly text: string };

function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

function commonSuffix(a: readonly string[], b: readonly string[], limit: number): number {
  let length = 0;
  while (length < limit && a[a.length - 1 - length] === b[b.length - 1 - length]) {
    length += 1;
  }
  return length;
}

function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      ops.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) {
    ops.push({ kind: "removed", text: a[i] });
  }
  for (; j < m; j += 1) {
    ops.push({ kind: "added", text: b[j] });
  }
  return ops;
}

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    return [...a.map((text): Op => ({ kind: "removed", text })), ...b.map((text): Op => ({ kind: "added", text }))];
  }
  return lcsOps(a, b);
}

function toSegments(ops: readonly Op[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  for (const op of ops) {
    const last = segments[segments.length - 1];
    if (last && last.kind === op.kind) {
      segments[segments.length - 1] = { kind: op.kind, text: last.text + op.text };
    } else {
      segments.push({ kind: op.kind, text: op.text });
    }
  }
  return segments;
}

export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, Math.min(a.length, b.length) - prefix);
  const head = a.slice(0, prefix).map((text): Op => ({ kind: "same", text }));
  const tail = a.slice(a.length - suffix).map((text): Op => ({ kind: "same", text }));
  const middle = middleOps(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  return toSegments([...head, ...middle, ...tail]);
}

function cellText(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function linesOf(block: DocBlock): string[] {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return [block.text];
    case "bullets":
    case "numbered":
      return [...block.items];
    case "table":
      return [
        block.columns.join(" | "),
        ...block.rows.map((row) => block.columns.map((_, index) => cellText(row[index])).join(" | ")),
      ];
    case "pageBreak":
      return [];
  }
}

export function sectionPlainText(section: DocSection): string {
  return section.blocks.flatMap(linesOf).join("\n");
}

export function diffSections(current: DocSection, proposed: DocSection): DiffSegment[] {
  return diffWords(sectionPlainText(current), sectionPlainText(proposed));
}
