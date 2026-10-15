import { ApiError, STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, type TenantContext } from "@agentforge/core";
import type { DocRefusal } from "../doc-tools/doc-save";
import { importDocumentForTenant, type ImportDocumentInput } from "../doc-tools/import-document";
import { jsonError, jsonOk } from "../errors";
import { findMemberProject, findVisibleFile, setFileProject } from "../projects/store";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

const NOT_FOUND_MESSAGE = "Artifact not found";
const BODY_MESSAGE = "artifactId is required: the id of a Word, Excel or PDF file you can open.";
const TOO_LARGE_MESSAGE = "The imported file is too large to save.";
const UNAVAILABLE_MESSAGE = "The file could not be imported right now. Try again in a moment.";

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

function keepWorkspaceOf(tenant: TenantContext, sourceProjectId: string | null, copyId: string): void {
  if (sourceProjectId === null || findMemberProject(tenant, sourceProjectId) === null) {
    return;
  }
  setFileProject(tenant, copyId, sourceProjectId);
}

export const handlePostDocImport = docImportRoute(async (request) => {
  const tenant = await getTenant(request);
  const artifactId = artifactIdOf(request.body);
  const source = findVisibleFile(tenant, artifactId);
  if (source === null) {
    throw new ApiError("not_found", NOT_FOUND_MESSAGE, 404);
  }
  const imported = await importDocumentForTenant({ artifactId }, tenant);
  if (!imported.ok) {
    throw refusalOf(imported.reason, imported.message);
  }
  keepWorkspaceOf(tenant, source.project_id, imported.artifactId);
  return jsonOk({ artifactId: imported.artifactId }, 201);
});
