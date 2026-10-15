import { ApiError, STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, type TenantContext } from "@agentforge/core";
import type { DocRefusal } from "../doc-tools/doc-save";
import { importDocumentForTenant, type ImportDocumentInput } from "../doc-tools/import-document";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { markSourceFailed } from "../knowledge";
import { log } from "../log";
import { attachArtifactKnowledge } from "../projects/knowledge";
import { isEditableFile } from "../projects/service";
import { findMemberProject, findVisibleFile, setFileProject } from "../projects/store";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

const NOT_FOUND_MESSAGE = "Artifact not found";
const BODY_MESSAGE = "artifactId is required: the id of a Word, Excel or PDF file you can open.";
const TOO_LARGE_MESSAGE = "The imported file is too large to save.";
const UNAVAILABLE_MESSAGE = "The file could not be imported right now. Try again in a moment.";
const ALREADY_EDITABLE_MESSAGE = "This file is already an editable document.";

function docImportRoute(
  work: (request: HostRequest) => Promise<HostResult>,
): (request: HostRequest) => Promise<HostResult> {
  return async (request) => {
    try {
      return await work(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}

function artifactIdOf(body: unknown): ImportDocumentInput["artifactId"] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("invalid_request", BODY_MESSAGE, 400);
  }
  const { artifactId } = body as { artifactId?: unknown };
  if (typeof artifactId !== "string" || artifactId.trim() === "") {
    throw new ApiError("invalid_request", BODY_MESSAGE, 400);
  }
  return artifactId;
}

function refusalOf(reason: DocRefusal, message: string): ApiError {
  switch (reason) {
    case "not_found":
      return new ApiError("not_found", NOT_FOUND_MESSAGE, 404);
    case "quota":
      return new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403);
    case "too_large":
      return new ApiError("too_large", TOO_LARGE_MESSAGE, 413);
    case "unavailable":
      return new ApiError("unavailable", UNAVAILABLE_MESSAGE, 503);
    default:
      return new ApiError("not_editable", message, 409);
  }
}

function keepWorkspaceOf(tenant: TenantContext, sourceProjectId: string | null, copyId: string): boolean {
  if (sourceProjectId === null || findMemberProject(tenant, sourceProjectId) === null) {
    return false;
  }
  setFileProject(tenant, copyId, sourceProjectId);
  return true;
}

function indexCopyInBackground(tenant: TenantContext, copyId: string): void {
  void (async () => {
    const copy = findVisibleFile(tenant, copyId);
    if (!copy?.project_id) {
      return;
    }
    try {
      requireGatewayAllowedFor(tenant);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      markSourceFailed(
        tenant,
        {
          id: crypto.randomUUID(),
          name: copy.title,
          type: "File",
          origin: { kind: "artifact", id: copy.id },
          ownerUserId: copy.owner_user_id,
          projectId: copy.project_id,
        },
        error.code,
      );
      return;
    }
    await attachArtifactKnowledge(tenant, copy.id, copy.project_id, copy.owner_user_id);
  })().catch((error: unknown) => {
    log.warn("docs_import_index_failed", { detail: error instanceof Error ? error.name : "error" });
  });
}

export const handlePostDocImport = docImportRoute(async (request) => {
  const tenant = await getTenant(request);
  const artifactId = artifactIdOf(request.body);
  const source = findVisibleFile(tenant, artifactId);
  if (source === null) {
    throw new ApiError("not_found", NOT_FOUND_MESSAGE, 404);
  }
  if (isEditableFile(source)) {
    throw new ApiError("already_editable", ALREADY_EDITABLE_MESSAGE, 409);
  }
  const imported = await importDocumentForTenant({ artifactId }, tenant);
  if (!imported.ok) {
    throw refusalOf(imported.reason, imported.message);
  }
  if (keepWorkspaceOf(tenant, source.project_id, imported.artifactId)) {
    indexCopyInBackground(tenant, imported.artifactId);
  }
  return jsonOk({ artifactId: imported.artifactId }, 201);
});
