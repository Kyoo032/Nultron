/**
 * The collective project routes, phase F1 (team-board-spec.md section 2b). Server mode only: on Personal
 * every one answers the router's own `404 not_found`, so projects do not exist there at all.
 *
 * Identity is `getTenant(request)` and nothing the request body says. CSRF and the rate limit are the
 * HTTP adapter's, applied to every write before dispatch. Downloads stay on `GET /api/v1/artifacts/:id/file`
 * for a chat file and `GET /api/v1/media/:id/file` for a generated image or video (SR-175).
 */
import { ApiError, isServerMode } from "@agentforge/core";
import {
  parseAddFile,
  parseAgentInput,
  parseCreateProject,
  parsePersonInput,
  parseRoleInput,
  parseUpdateProject,
} from "../projects/input";
import {
  addProjectFile,
  addProjectMedia,
  addProjectMember,
  archiveProject,
  bringProjectAgent,
  createProject,
  listInvitablePeople,
  listProjectFiles,
  listProjectKnowledgeFor,
  listProjectMembers,
  listProjectThreadsFor,
  listProjects,
  removeProjectAgent,
  removeProjectFile,
  removeProjectKnowledge,
  removeProjectMedia,
  removeProjectMember,
  setProjectMemberRole,
  transferProjectOwnership,
  updateProject,
  uploadProjectKnowledge,
} from "../projects/service";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { KNOWLEDGE_FILE_MAX_BYTES } from "../knowledge-extract";
import type { HostRequest, HostResult } from "../types";

const NOT_FOUND: HostResult = {
  type: "json",
  status: 404,
  body: { error: { code: "not_found", message: "Not found" } },
};

/** Server mode, then the caller's tenant, then the work. Any refusal is the same envelope as elsewhere. */
function projectRoute(work: (request: HostRequest) => Promise<HostResult> | HostResult) {
  return async (request: HostRequest): Promise<HostResult> => {
    if (!isServerMode()) {
      return NOT_FOUND;
    }
    try {
      return await work(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}

export const handleGetProjects = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ items: listProjects(scope) });
});

export const handlePostProject = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ project: createProject(scope, parseCreateProject(request.body)) }, 201);
});

export const handlePatchProject = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ project: updateProject(scope, request.params.id ?? "", parseUpdateProject(request.body)) });
});

export const handleArchiveProject = projectRoute(async (request) => {
  const scope = await getTenant(request);
  archiveProject(scope, request.params.id ?? "");
  return jsonOk({ ok: true });
});

export const handleGetProjectFiles = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ items: listProjectFiles(scope, request.params.id ?? "") });
});

/** `{ artifactId }` puts a chat file in; `{ mediaId }` puts a generated image or video in (SR-175). */
export const handlePostProjectFile = projectRoute(async (request) => {
  const scope = await getTenant(request);
  const input = parseAddFile(request.body);
  if ("mediaId" in input) {
    addProjectMedia(scope, request.params.id ?? "", input.mediaId);
  } else {
    await addProjectFile(scope, request.params.id ?? "", input.artifactId);
  }
  return jsonOk({ ok: true });
});

export const handleDeleteProjectFile = projectRoute(async (request) => {
  const scope = await getTenant(request);
  removeProjectFile(scope, request.params.id ?? "", request.params.artifactId ?? "");
  return jsonOk({ ok: true });
});

export const handleDeleteProjectMedia = projectRoute(async (request) => {
  const scope = await getTenant(request);
  removeProjectMedia(scope, request.params.id ?? "", request.params.mediaId ?? "");
  return jsonOk({ ok: true });
});

export const handleGetProjectKnowledge = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ items: listProjectKnowledgeFor(scope, request.params.id ?? "") });
});

/** A file uploaded straight into the Workspace (W1). Every write that reaches the gateway is gated first. */
export const handlePostProjectUpload = projectRoute(async (request) => {
  const scope = await getTenant(request);
  requireGatewayAllowedFor(scope);
  const file = request.files?.find((item) => item.field === "file") ?? request.files?.[0];
  if (!file) {
    throw new ApiError("invalid_request", "file is required", 400);
  }
  if (file.bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) {
    throw new ApiError("invalid_request", "The file exceeds the 25 MB cap", 413);
  }
  return jsonOk({ source: await uploadProjectKnowledge(scope, request.params.id ?? "", file) }, 201);
});

export const handleDeleteProjectKnowledge = projectRoute(async (request) => {
  const scope = await getTenant(request);
  removeProjectKnowledge(scope, request.params.id ?? "", request.params.sourceId ?? "");
  return jsonOk({ ok: true });
});

export const handleGetProjectThreads = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ items: listProjectThreadsFor(scope, request.params.id ?? "") });
});

/** The people and the agents brought in (K-D22, K-D23), for any member. */
export const handleGetProjectMembers = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk(listProjectMembers(scope, request.params.id ?? ""));
});

export const handleGetProjectInvitable = projectRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ items: listInvitablePeople(scope, request.params.id ?? "") });
});

export const handlePostProjectMember = projectRoute(async (request) => {
  const scope = await getTenant(request);
  const { userId } = parsePersonInput(request.body);
  return jsonOk({ members: addProjectMember(scope, request.params.id ?? "", userId) }, 201);
});

export const handlePatchProjectMember = projectRoute(async (request) => {
  const scope = await getTenant(request);
  const { role } = parseRoleInput(request.body);
  setProjectMemberRole(scope, request.params.id ?? "", request.params.userId ?? "", role);
  return jsonOk({ ok: true });
});

export const handleDeleteProjectMember = projectRoute(async (request) => {
  const scope = await getTenant(request);
  removeProjectMember(scope, request.params.id ?? "", request.params.userId ?? "");
  return jsonOk({ ok: true });
});

export const handlePostProjectOwner = projectRoute(async (request) => {
  const scope = await getTenant(request);
  const { userId } = parsePersonInput(request.body);
  transferProjectOwnership(scope, request.params.id ?? "", userId);
  return jsonOk({ ok: true });
});

export const handlePostProjectAgent = projectRoute(async (request) => {
  const scope = await getTenant(request);
  const { agentId } = parseAgentInput(request.body);
  return jsonOk({ agents: await bringProjectAgent(scope, request.params.id ?? "", agentId) }, 201);
});

export const handleDeleteProjectAgent = projectRoute(async (request) => {
  const scope = await getTenant(request);
  removeProjectAgent(scope, request.params.id ?? "", request.params.agentId ?? "");
  return jsonOk({ ok: true });
});

/**
 * The F1 project route table. `router.ts` compiles it with one line. Every by-id route here has its row
 * in `tenancy-harness.test.ts`, which fails for any by-id route without one.
 */
export function projectRoutes(): ReadonlyArray<
  readonly [string, string, (request: HostRequest) => Promise<HostResult>]
> {
  return [
    ["GET", "/api/v1/projects", handleGetProjects],
    ["POST", "/api/v1/projects", handlePostProject],
    ["PATCH", "/api/v1/projects/:id", handlePatchProject],
    ["POST", "/api/v1/projects/:id/archive", handleArchiveProject],
    ["GET", "/api/v1/projects/:id/files", handleGetProjectFiles],
    ["POST", "/api/v1/projects/:id/files", handlePostProjectFile],
    ["DELETE", "/api/v1/projects/:id/files/:artifactId", handleDeleteProjectFile],
    ["DELETE", "/api/v1/projects/:id/media/:mediaId", handleDeleteProjectMedia],
    ["GET", "/api/v1/projects/:id/knowledge", handleGetProjectKnowledge],
    ["POST", "/api/v1/projects/:id/uploads", handlePostProjectUpload],
    ["DELETE", "/api/v1/projects/:id/knowledge/:sourceId", handleDeleteProjectKnowledge],
    ["GET", "/api/v1/projects/:id/threads", handleGetProjectThreads],
    ["GET", "/api/v1/projects/:id/members", handleGetProjectMembers],
    ["GET", "/api/v1/projects/:id/invitable", handleGetProjectInvitable],
    ["POST", "/api/v1/projects/:id/members", handlePostProjectMember],
    ["PATCH", "/api/v1/projects/:id/members/:userId", handlePatchProjectMember],
    ["DELETE", "/api/v1/projects/:id/members/:userId", handleDeleteProjectMember],
    ["POST", "/api/v1/projects/:id/owner", handlePostProjectOwner],
    ["POST", "/api/v1/projects/:id/agents", handlePostProjectAgent],
    ["DELETE", "/api/v1/projects/:id/agents/:agentId", handleDeleteProjectAgent],
  ];
}
