import { ApiError } from "@agentforge/core";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostHandler, HostRequest, HostResult } from "../types";
import { folderUnavailableError, mountIpcOnlyError } from "./api-errors";
import { folderRootAvailable } from "./availability";
import { approveProposal, getProposalDiff, listProposals, rejectProposal } from "./decisions";
import { defaultFolderDeps, type FolderDeps } from "./deps";
import { folderStatus, mountFolder, UNAVAILABLE_STATUS, unmountFolder } from "./mount-service";
import { isProposalStatus } from "./proposal-store";

/** One registration in the shape `compile(method, path, handler)` in `router.ts` takes. */
export type FolderRoute = readonly [method: string, pattern: string, handler: HostHandler];

type DepsSource = () => Promise<FolderDeps>;

function transportOf(request: HostRequest): string {
  return (request.headers["x-agentforge-transport"] ?? "").toLowerCase();
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Every route except the status read refuses, by name, where a folder cannot exist. */
function requireAvailable(): void {
  if (!folderRootAvailable()) {
    throw folderUnavailableError();
  }
}

/**
 * The folder routes, over a source of the proposal store. `FOLDER_ROUTES` below is this bound to
 * the app database; the suite binds it to an in-memory one.
 *
 * `GET /folder` is the one route that answers on the hosted server, with `available: false` and
 * nothing read, so the renderer can hide the control. Mounting is accepted only from the packaged
 * shell (IPC), the same rule as importing an Edit file by path: the path comes from the native
 * picker, not from a page.
 */
export function createFolderRoutes(depsSource: DepsSource): readonly FolderRoute[] {
  const guarded =
    (run: (request: HostRequest, deps: FolderDeps) => Promise<HostResult>): HostHandler =>
    async (request) => {
      try {
        requireAvailable();
        return await run(request, await depsSource());
      } catch (error) {
        return jsonError(error);
      }
    };

  const getStatus: HostHandler = async (request) => {
    try {
      if (!folderRootAvailable()) {
        return jsonOk(UNAVAILABLE_STATUS);
      }
      return jsonOk(await folderStatus(await getTenant(request)));
    } catch (error) {
      return jsonError(error);
    }
  };

  const postMount = guarded(async (request, deps) => {
    if (transportOf(request) !== "ipc") {
      throw mountIpcOnlyError();
    }
    const tenant = await getTenant(request);
    return jsonOk(await mountFolder(tenant, asRecord(request.body).path, deps));
  });

  const deleteMount = guarded(async (request, deps) => {
    await unmountFolder(await getTenant(request), deps);
    return jsonOk({ ok: true });
  });

  const getProposals = guarded(async (request, deps) => {
    const status = request.query.status;
    if (status !== undefined && status !== "" && !isProposalStatus(status)) {
      throw new ApiError("invalid_request", "Unknown proposal status", 400);
    }
    const tenant = await getTenant(request);
    return jsonOk({ items: await listProposals(tenant, isProposalStatus(status) ? status : undefined, deps) });
  });

  const getProposal = guarded(async (request, deps) =>
    jsonOk(await getProposalDiff(await getTenant(request), request.params.proposalId, deps)),
  );

  const postApprove = guarded(async (request, deps) =>
    jsonOk(await approveProposal(await getTenant(request), request.params.proposalId, deps)),
  );

  const postReject = guarded(async (request, deps) =>
    jsonOk(await rejectProposal(await getTenant(request), request.params.proposalId, deps)),
  );

  return [
    ["GET", "/api/v1/folder", getStatus],
    ["POST", "/api/v1/folder/mount", postMount],
    ["DELETE", "/api/v1/folder/mount", deleteMount],
    ["GET", "/api/v1/folder/proposals", getProposals],
    ["GET", "/api/v1/folder/proposals/:proposalId", getProposal],
    ["POST", "/api/v1/folder/proposals/:proposalId/approve", postApprove],
    ["POST", "/api/v1/folder/proposals/:proposalId/reject", postReject],
  ];
}

export const FOLDER_ROUTES: readonly FolderRoute[] = createFolderRoutes(defaultFolderDeps);
