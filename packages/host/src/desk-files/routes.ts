/**
 * Desk file routes: what the Files section of the Knowledge Base page and the API tests drive.
 *
 *   GET    /api/v1/files           list (query dir, glob)
 *   GET    /api/v1/files/content   read the head (query path)
 *   GET    /api/v1/files/versions  version history (query path)
 *   GET    /api/v1/files/version   read one version (query path, version)
 *   POST   /api/v1/files           save {path, content} as the signed-in person
 *   POST   /api/v1/files/revert    {path, version}: a new version holding an old body
 *   DELETE /api/v1/files           soft delete (query path); the history stays
 *
 * Paths ride in the query, not in the URL, so a file name never needs escaping in a route and the
 * by-id surface the tenancy harness counts does not grow. They are not model routes, so the gateway
 * gate does not apply (artifacts are not gated either). Another desk's or tenant's file is a 404:
 * every query inside the store carries the desk id, and the desk comes from `getTenant`.
 */
import { ApiError } from "@agentforge/core";
import { checkGlob, FileRootError, isFileRefusal, parseDeskPath } from "@agentforge/core/tools/files";
import type { DeskPath, FileRefusalCode } from "@agentforge/core/tools/files";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostHandler, HostRequest, HostResult } from "../types";
import { createDeskRoot, listVersions, readVersion, revertTo } from "./store";

export type DeskFileRoute = readonly [method: string, path: string, handler: HostHandler];

/** HTTP status for each refusal a root can throw. `denied` is the desk's "not valid text" answer. */
const REFUSAL_STATUS: Readonly<Record<FileRefusalCode, number>> = {
  bad_path: 400,
  not_found: 404,
  too_large: 413,
  too_many_files: 409,
  denied: 400,
  no_match: 400,
  bad_pattern: 400,
  ambiguous_match: 400,
  root_unavailable: 503,
  quota: 403,
  conflict: 409,
};

/**
 * A root's refusal as the wire error. Quota keeps the code the storage screen and the media routes
 * already use, so the renderer treats a full account the same way everywhere.
 */
function toApiError(error: FileRootError): ApiError {
  const code = error.code === "quota" ? "storage_quota_exceeded" : error.code;
  return new ApiError(code, error.message, REFUSAL_STATUS[error.code]);
}

function fail(error: unknown): HostResult {
  return jsonError(error instanceof FileRootError ? toApiError(error) : error);
}

function requirePath(raw: unknown): DeskPath {
  if (typeof raw !== "string") {
    throw new ApiError("invalid_request", "path is required", 400);
  }
  const parsed = parseDeskPath(raw);
  if (isFileRefusal(parsed)) {
    throw new ApiError(parsed.code, parsed.message, 400);
  }
  return parsed;
}

function requireVersion(raw: unknown): number {
  const version = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError("invalid_request", "version must be a whole number from 1", 400);
  }
  return version;
}

function requireBody(request: HostRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("invalid_request", "A JSON object body is required", 400);
  }
  return body as Record<string, unknown>;
}

async function deskRootFor(request: HostRequest) {
  const tenant = await getTenant(request);
  const author = { kind: "user", userId: tenant.userId } as const;
  return { tenant, author, root: createDeskRoot(tenant, author) };
}

export async function handleGetFiles(request: HostRequest): Promise<HostResult> {
  try {
    const { dir, glob } = request.query;
    const parsedDir = dir === undefined || dir === "" ? null : requirePath(dir);
    const globRefusal = glob ? checkGlob(glob) : null;
    if (globRefusal) {
      throw new ApiError(globRefusal.code, globRefusal.message, 400);
    }
    const { root } = await deskRootFor(request);
    const items = await root.list(parsedDir, glob || undefined);
    return jsonOk({ items });
  } catch (error) {
    return fail(error);
  }
}

export async function handleGetFileContent(request: HostRequest): Promise<HostResult> {
  try {
    const path = requirePath(request.query.path);
    const { root } = await deskRootFor(request);
    return jsonOk(await root.read(path));
  } catch (error) {
    return fail(error);
  }
}

export async function handleGetFileVersions(request: HostRequest): Promise<HostResult> {
  try {
    const path = requirePath(request.query.path);
    const { tenant } = await deskRootFor(request);
    return jsonOk({ items: await listVersions(tenant, path) });
  } catch (error) {
    return fail(error);
  }
}

export async function handleGetFileVersion(request: HostRequest): Promise<HostResult> {
  try {
    const path = requirePath(request.query.path);
    const version = requireVersion(request.query.version);
    const { tenant } = await deskRootFor(request);
    return jsonOk(await readVersion(tenant, path, version));
  } catch (error) {
    return fail(error);
  }
}

export async function handlePostFile(request: HostRequest): Promise<HostResult> {
  try {
    const body = requireBody(request);
    const path = requirePath(body.path);
    if (typeof body.content !== "string") {
      throw new ApiError("invalid_request", "content must be text", 400);
    }
    const { root, author } = await deskRootFor(request);
    return jsonOk(await root.write(path, body.content, author));
  } catch (error) {
    return fail(error);
  }
}

export async function handlePostFileRevert(request: HostRequest): Promise<HostResult> {
  try {
    const body = requireBody(request);
    const path = requirePath(body.path);
    const version = requireVersion(body.version);
    const { tenant, author } = await deskRootFor(request);
    return jsonOk(await revertTo(tenant, path, version, author));
  } catch (error) {
    return fail(error);
  }
}

export async function handleDeleteFile(request: HostRequest): Promise<HostResult> {
  try {
    const path = requirePath(request.query.path);
    const { root, author } = await deskRootFor(request);
    return jsonOk(await root.remove(path, author));
  } catch (error) {
    return fail(error);
  }
}

/** In the shape `router.ts` feeds `compile(method, path, handler)`. The orchestrator spreads them in. */
export const DESK_FILE_ROUTES: readonly DeskFileRoute[] = [
  ["GET", "/api/v1/files", handleGetFiles],
  ["GET", "/api/v1/files/content", handleGetFileContent],
  ["GET", "/api/v1/files/versions", handleGetFileVersions],
  ["GET", "/api/v1/files/version", handleGetFileVersion],
  ["POST", "/api/v1/files", handlePostFile],
  ["POST", "/api/v1/files/revert", handlePostFileRevert],
  ["DELETE", "/api/v1/files", handleDeleteFile],
];
