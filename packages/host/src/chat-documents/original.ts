import { isServerMode, type TenantContext } from "@agentforge/core";
import { DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import { type ArtifactRefusal, saveRenderedArtifact } from "../artifact-save";
import { artifactStore } from "../artifacts";
import type { HostFile } from "../types";

export const ORIGINAL_SKIP_REASONS = ["too_large", "quota", "unavailable"] as const;
export type OriginalSkipReason = (typeof ORIGINAL_SKIP_REASONS)[number];

export const CHAT_UPLOAD_META_KEY = "chatUpload";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function originalMimeFor(format: string): ArtifactMime | null {
  if (format === "docx") {
    return DOCX_MIME;
  }
  if (format === "xlsx") {
    return XLSX_MIME;
  }
  return format === "pdf" ? PDF_MIME : null;
}

export type OriginalAnswer = { readonly id: string | null; readonly skipped: OriginalSkipReason | null };

function skipReasonOf(refusal: ArtifactRefusal): OriginalSkipReason {
  return refusal === "too_large" || refusal === "quota" ? refusal : "unavailable";
}

export async function keepOriginal(
  tenant: TenantContext,
  file: HostFile,
  format: string,
): Promise<OriginalAnswer | null> {
  if (isServerMode()) {
    return null;
  }
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

export function verifiedOriginalId(tenant: TenantContext, value: unknown, format: string): string | null {
  if (isServerMode() || typeof value !== "string" || !UUID.test(value)) {
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

export function skipReasonFrom(value: unknown): OriginalSkipReason | null {
  return (ORIGINAL_SKIP_REASONS as readonly unknown[]).includes(value) ? (value as OriginalSkipReason) : null;
}
