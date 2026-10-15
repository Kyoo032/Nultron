import { ApiError, type TenantContext } from "@agentforge/core";
import type { ArtifactKind, ArtifactMeta, ArtifactMime, ArtifactMode } from "@agentforge/core/artifacts";
import { ARTIFACT_BODY_MAX_BYTES, artifactStore } from "./artifacts";
import { log } from "./log";
import { assertStorageAdmits, isStorageQuotaError } from "./tenant-storage";

export type ArtifactRefusal = "too_large" | "quota" | "unavailable";

export function refuse<R extends string>(
  reason: R,
  message: string,
): { readonly ok: false; readonly reason: R; readonly message: string } {
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
  | { readonly ok: false; readonly reason: ArtifactRefusal; readonly message: string };

export async function saveRenderedArtifact(tenant: TenantContext, input: SaveInput): Promise<SaveOutcome> {
  const base64 = Buffer.from(input.bytes).toString("base64");
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
    log.warn("artifact_not_saved", { code: error instanceof ApiError ? error.code : "internal_error" });
    return refuse("unavailable", UNAVAILABLE_MESSAGE);
  }
}
