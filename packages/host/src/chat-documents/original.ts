/**
 * The original file of a Chat attachment, kept as an artifact of the person who attached it
 * (K-D21, Rizky 2026-10-14; team-board-spec.md section 2b, U1).
 *
 * The read route is the only place the bytes exist (the save route receives text), so the original is
 * stored there, and only once the reader has read the file: a file the reader refuses is never kept. Only
 * Word, Excel and PDF are kept, the three types `import_document` opens. The row is an ordinary artifact
 * written by the same store as every saved document, so it is sealed at rest like them, and it never
 * carries a project: a chat upload does not become shared on its own. On the hosted server the store makes
 * the maker its owner (`artifacts.ts`, `visibleTo`), which is what keeps it from colleagues and other
 * companies. Personal writes no owner, and the one person on the desk sees it.
 *
 * A kept original is never a reason to fail an attachment. A refusal (too large to keep, storage full) is an
 * answer the composer hands back on send, and the model reads it in the notes (`notes.ts`).
 */
import type { TenantContext } from "@agentforge/core";
import { DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import { artifactStore } from "../artifacts";
import { saveRenderedArtifact, type DocRefusal } from "../doc-tools/doc-save";
import type { HostFile } from "../types";

/** Why an original was not kept. Fixed codes; the model reads one fixed sentence for each. */
export const ORIGINAL_SKIP_REASONS = ["too_large", "quota", "unavailable"] as const;
export type OriginalSkipReason = (typeof ORIGINAL_SKIP_REASONS)[number];

/** The metadata key that marks a row as a chat upload's original. Only the host reads it. */
export const CHAT_UPLOAD_META_KEY = "chatUpload";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The artifact type an original is kept as, for the format the reader names. Null for any other format. */
export function originalMimeFor(format: string): ArtifactMime | null {
  if (format === "docx") {
    return DOCX_MIME;
  }
  if (format === "xlsx") {
    return XLSX_MIME;
  }
  return format === "pdf" ? PDF_MIME : null;
}

/** What the read answers: the id when the original was kept, else why it was not. */
export type OriginalAnswer = { readonly id: string | null; readonly skipped: OriginalSkipReason | null };

function skipReasonOf(refusal: DocRefusal): OriginalSkipReason {
  return refusal === "too_large" || refusal === "quota" ? refusal : "unavailable";
}

/**
 * Keep the bytes of `file` for the person who attached it. Null when the format has no original. Never
 * throws: a refusal is an answer, and the attachment goes on without the original.
 */
export async function keepOriginal(
  tenant: TenantContext,
  file: HostFile,
  format: string,
): Promise<OriginalAnswer | null> {
  const mime = originalMimeFor(format);
  if (mime === null) {
    return null;
  }
  const saved = await saveRenderedArtifact(tenant, {
    mode: "documents",
    kind: "draft",
    title: file.filename,
    mime,
    bytes: file.bytes,
    meta: { [CHAT_UPLOAD_META_KEY]: true },
  });
  return saved.ok ? { id: saved.artifactId, skipped: null } : { id: null, skipped: skipReasonOf(saved.reason) };
}

/**
 * The id the send call hands back, when it names a kept original of the same format that this person can
 * open. Anything else (a malformed value, another person's file, an ordinary document) is null, so the
 * notes never name a file the caller could not open with `import_document`.
 */
export function verifiedOriginalId(tenant: TenantContext, value: unknown, format: string): string | null {
  if (typeof value !== "string" || !UUID.test(value)) {
    return null;
  }
  const mime = originalMimeFor(format);
  if (mime === null) {
    return null;
  }
  const record = artifactStore().get(tenant, value);
  if (record === null || record.mime !== mime || record.meta[CHAT_UPLOAD_META_KEY] !== true) {
    return null;
  }
  return record.id;
}

/** A skip reason the send call hands back, if it is one of the fixed codes. */
export function skipReasonFrom(value: unknown): OriginalSkipReason | null {
  return (ORIGINAL_SKIP_REASONS as readonly unknown[]).includes(value) ? (value as OriginalSkipReason) : null;
}
