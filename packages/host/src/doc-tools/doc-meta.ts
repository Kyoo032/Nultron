/**
 * The editable spec of a saved document, kept in the artifact's metadata as a sealed envelope.
 *
 * The metadata column is plain JSON in the database, so the spec goes in sealed with the same vault key
 * as the body (`sealPayload`). A plain spec would put the whole text of a document at rest in clear. The
 * envelope is the only thing the row holds; `readEditableSpec` opens it again for a revision.
 */
import { openPayload, sealPayload } from "@agentforge/core";
import type { ArtifactMeta, ArtifactRecord } from "@agentforge/core/artifacts";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { parseDocSpec, parseSheetSpec, type DocSpec, type SheetSpec } from "../doc-model";

export const SPEC_META_KEY = "spec";

export type EditableSpec =
  | { readonly kind: "document"; readonly spec: DocSpec }
  | { readonly kind: "workbook"; readonly spec: SheetSpec };

/** The metadata for a saved document: its sealed spec, and optionally the file it was revised from. */
export function specMeta(spec: DocSpec | SheetSpec, parentArtifactId?: string): ArtifactMeta {
  const sealed = sealPayload(spec, getLocalVaultKey());
  return parentArtifactId === undefined ? { [SPEC_META_KEY]: sealed } : { [SPEC_META_KEY]: sealed, parentArtifactId };
}

/** Open the sealed spec of a saved artifact. Null when the row has none, or it does not open or parse. */
export function readEditableSpec(record: ArtifactRecord): EditableSpec | null {
  const sealed = record.meta[SPEC_META_KEY];
  if (sealed === undefined) {
    return null;
  }
  try {
    const raw = openPayload<unknown>(sealed, getLocalVaultKey());
    if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "workbook") {
      return { kind: "workbook", spec: parseSheetSpec(raw) };
    }
    return { kind: "document", spec: parseDocSpec(raw) };
  } catch {
    return null;
  }
}
