import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EditableSpec } from "../doc-tools/doc-meta";

type Part = { readonly id: string };

function partsOf(spec: EditableSpec): readonly Part[] {
  return spec.kind === "document" ? spec.spec.sections : spec.spec.sheets;
}

export function sectionIdsOf(spec: EditableSpec): string[] {
  return partsOf(spec).map((part) => part.id);
}

export function newSectionId(spec: EditableSpec): string {
  const taken = new Set(sectionIdsOf(spec));
  for (;;) {
    const id = `s-${randomBytes(5).toString("hex")}`;
    if (!taken.has(id)) {
      return id;
    }
  }
}

export function changedSectionIds(before: EditableSpec, after: EditableSpec): string[] {
  const old = new Map(partsOf(before).map((part) => [part.id, part]));
  const next = new Map(partsOf(after).map((part) => [part.id, part]));
  const changed = [...next].filter(([id, part]) => !isDeepStrictEqual(old.get(id), part)).map(([id]) => id);
  const removed = [...old.keys()].filter((id) => !next.has(id));
  return [...changed, ...removed];
}
