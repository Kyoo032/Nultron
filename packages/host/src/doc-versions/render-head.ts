import { sealPayload, type TenantContext } from "@agentforge/core";
import { DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import { sql } from "@agentforge/db";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { ARTIFACT_BODY_MAX_BYTES } from "../artifacts";
import { renderDocx, renderPdf, renderXlsx } from "../doc-model";
import type { EditableSpec } from "../doc-tools/doc-meta";
import { log } from "../log";
import { assertStorageAdmits, isStorageQuotaError } from "../tenant-storage";
import { docVersionStore } from "./store";

export type HeadBodyRefusal =
  | "not_found"
  | "not_editable"
  | "render_failed"
  | "too_large"
  | "quota"
  | "stale"
  | "unavailable";

export type HeadBodyResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: HeadBodyRefusal };

export type HeadRenderer = (spec: EditableSpec, mime: ArtifactMime) => Promise<Uint8Array>;

type ArtifactFileRow = { readonly mime: string; readonly size_bytes: number };

export function mimeForHead(spec: EditableSpec, current: string): ArtifactMime {
  if (spec.kind === "workbook") {
    return XLSX_MIME;
  }
  return current === PDF_MIME ? PDF_MIME : DOCX_MIME;
}

export async function renderHead(spec: EditableSpec, mime: ArtifactMime): Promise<Uint8Array> {
  if (spec.kind === "workbook") {
    return renderXlsx(spec.spec);
  }
  return mime === PDF_MIME ? renderPdf(spec.spec) : renderDocx(spec.spec);
}

function refused(reason: HeadBodyRefusal): HeadBodyResult {
  return { ok: false, reason };
}

export async function refreshHeadBody(
  tenant: TenantContext,
  artifactId: string,
  render: HeadRenderer = renderHead,
): Promise<HeadBodyResult> {
  try {
    const store = docVersionStore();
    const versions = store.listVersions(tenant, artifactId);
    if (versions === null) {
      return refused("not_found");
    }
    const head = versions[0];
    if (head === undefined) {
      return refused("not_editable");
    }
    const version = store.getVersion(tenant, artifactId, head.version);
    if (version === null) {
      return refused("not_editable");
    }
    const file = sql
      .prepare("SELECT mime, size_bytes FROM artifacts WHERE workspace_id = ? AND id = ?")
      .get(tenant.workspaceId, artifactId) as ArtifactFileRow | undefined;
    if (file === undefined) {
      return refused("not_found");
    }
    const mime = mimeForHead(version.spec, file.mime);
    let bytes: Uint8Array;
    try {
      bytes = await render(version.spec, mime);
    } catch (error) {
      log.warn("doc_head_render_failed", {
        version: head.version,
        detail: error instanceof Error ? error.name : "error",
      });
      return refused("render_failed");
    }
    const body = Buffer.from(bytes).toString("base64");
    const sizeBytes = Buffer.byteLength(body, "utf8");
    if (sizeBytes > ARTIFACT_BODY_MAX_BYTES) {
      log.warn("doc_head_too_large", { version: head.version, sizeBytes });
      return refused("too_large");
    }
    try {
      await assertStorageAdmits(tenant.tenantId, sizeBytes, file.size_bytes);
    } catch (error) {
      if (isStorageQuotaError(error)) {
        log.warn("doc_head_quota_refused", { version: head.version, sizeBytes });
        return refused("quota");
      }
      throw error;
    }
    const written = sql
      .prepare(
        `UPDATE artifacts SET body = ?, mime = ?, size_bytes = ?
          WHERE workspace_id = ? AND id = ?
            AND (SELECT MAX(version) FROM doc_versions WHERE artifact_id = ?) = ?`,
      )
      .run(
        JSON.stringify(sealPayload(body, getLocalVaultKey())),
        mime,
        sizeBytes,
        tenant.workspaceId,
        artifactId,
        artifactId,
        head.version,
      );
    if (written.changes === 0) {
      return refused("stale");
    }
    return { ok: true, version: head.version };
  } catch (error) {
    log.warn("doc_head_refresh_failed", {
      artifactId,
      detail: error instanceof Error ? error.name : "error",
    });
    return refused("unavailable");
  }
}
