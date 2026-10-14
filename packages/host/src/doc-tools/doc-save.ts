/**
 * Saving a rendered document as an artifact, and the answer shape every document tool shares.
 *
 * It follows `build_deck` (`deck/build-deck.ts`): the bytes are base64 in the body, the size is checked
 * against the artifact body cap, and the hosted storage ceiling is asked before the row is written. A
 * refusal is a value the model reads, never a throw, so it can fix the input and try again.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import type { ArtifactKind, ArtifactMeta, ArtifactMime, ArtifactMode } from "@agentforge/core/artifacts";
import { ARTIFACT_BODY_MAX_BYTES, artifactStore } from "../artifacts";
import { log } from "../log";
import { assertStorageAdmits, isStorageQuotaError } from "../tenant-storage";

export type DocRefusal =
  | "bad_format"
  | "invalid"
  | "not_found"
  | "not_editable"
  | "unsupported"
  | "nothing_to_change"
  | "unreadable"
  | "too_large"
  | "quota"
  | "unavailable";

export type DocToolResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly title: string;
      readonly format: string;
      readonly filename: string;
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: DocRefusal; readonly message: string };

export type DocImportResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly title: string;
      readonly format: string;
      /** Sections of a document, or sheets of a workbook, each with its id and heading or name. */
      readonly parts: ReadonlyArray<{ readonly id: string; readonly heading: string }>;
      readonly summary: string;
    }
  | { readonly ok: false; readonly reason: DocRefusal; readonly message: string };

export function refuse(
  reason: DocRefusal,
  message: string,
): { readonly ok: false; readonly reason: DocRefusal; readonly message: string } {
  return { ok: false, reason, message };
}

export const TOO_LARGE_MESSAGE =
  "The file is too large to save. Shorten the text or the table, then call the tool again.";
export const QUOTA_MESSAGE =
  "The owner's storage is full, so the file was not saved. Tell the owner to free space in Settings; do not retry.";
export const UNAVAILABLE_MESSAGE = "The file could not be saved right now. Tell the owner, and do not retry.";

export type SaveInput = {
  readonly mode: ArtifactMode;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly mime: ArtifactMime;
  readonly bytes: Uint8Array;
  readonly meta: ArtifactMeta;
};

export type SaveOutcome =
  | { readonly ok: true; readonly artifactId: string }
  | { readonly ok: false; readonly reason: DocRefusal; readonly message: string };

/** Store rendered bytes as an artifact. Storage admission and the body cap are asked here, not by callers. */
export async function saveRenderedArtifact(tenant: TenantContext, input: SaveInput): Promise<SaveOutcome> {
  const base64 = Buffer.from(input.bytes).toString("base64");
  // What the artifact row will carry (`size_bytes`), and so what the tenant's use will grow by.
  const storedBytes = Buffer.byteLength(base64, "utf8");
  if (storedBytes > ARTIFACT_BODY_MAX_BYTES) {
    return refuse("too_large", TOO_LARGE_MESSAGE);
  }
  try {
    await assertStorageAdmits(tenant.tenantId, storedBytes);
    const saved = artifactStore().create(tenant, {
      mode: input.mode,
      kind: input.kind,
      title: input.title,
      mime: input.mime,
      body: base64,
      meta: input.meta,
    });
    return { ok: true, artifactId: saved.id };
  } catch (error) {
    if (isStorageQuotaError(error)) {
      return refuse("quota", QUOTA_MESSAGE);
    }
    if (error instanceof ApiError && error.status === 413) {
      return refuse("too_large", TOO_LARGE_MESSAGE);
    }
    log.warn("doc_tool_not_saved", { code: error instanceof ApiError ? error.code : "internal_error" });
    return refuse("unavailable", UNAVAILABLE_MESSAGE);
  }
}
