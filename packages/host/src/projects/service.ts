/**
 * The rules for collective projects (team-board-spec.md section 2b; K-D19). The only writer of `projects`
 * and of `artifacts.project_id`.
 *
 * Who may do what, in one place:
 * - See a project: its maker, or anyone in the company once it is `workspace`. Anything else is a 404.
 * - Create: any member; the project starts `private`.
 * - Change visibility: the maker only. An owner or admin may not flip someone else's switch.
 * - Rename and archive: the maker, or an owner or admin, but only for a project they can already see.
 * - Add a file: the file's maker, into a project the caller can see. A file the caller cannot see is a
 *   404; one they can see but did not make is a 403. A generated image or video (`media`, SR-175) follows
 *   the same three rules.
 * - Remove a file: the file's maker, or the project's maker.
 */
import { ApiError, canAdminister, scanInjection, type TenantContext } from "@agentforge/core";
import type { CreateProjectInput, UpdateProjectInput } from "./input";
import { deleteSource, type KnowledgeSource } from "../knowledge";
import { mediaExt } from "../media";
import {
  attachArtifactKnowledge,
  detachArtifactKnowledge,
  listProjectKnowledge,
  uploadedSourceOf,
  uploadProjectFile,
  type ProjectKnowledgeItem,
} from "./knowledge";
import * as store from "./store";
import type { ProjectFileRow, ProjectMediaRow, ProjectRow } from "./store";

/** Live projects one desk may hold. Archived ones do not count. */
export const PROJECT_LIMIT = 200;
const FILE_LIST_LIMIT = 200;

export type ProjectRecord = {
  id: string;
  name: string;
  visibility: "private" | "workspace";
  /** What the Workspace's chats are told (W1). Empty when none has been written. */
  instructions: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectThread = { id: string; title: string; createdAt: number };

/** A chat file (`artifact`), or a generated image or video (`image` / `video`, SR-175). */
export type ProjectFileKind = "artifact" | "image" | "video";

export type ProjectFile = {
  id: string;
  kind: ProjectFileKind;
  title: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  updatedAt: number;
  /** The URL a browser can show inline (media only; a chat file has none). */
  previewUrl: string | null;
  /** The URL that saves the file as an attachment. */
  downloadUrl: string;
};

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    instructions: row.instructions ?? "",
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFile(row: ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    kind: "artifact",
    title: row.title,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    ownerUserId: row.owner_user_id,
    updatedAt: row.updated_at,
    previewUrl: null,
    downloadUrl: `/api/v1/artifacts/${encodeURIComponent(row.id)}/file`,
  };
}

/**
 * A stored image or video as a Workspace file. Its title is built from the row (kind, the first eight
 * characters of the id and the extension), the name `GET /api/v1/media/:id/file` saves it under.
 */
function toMediaFile(row: ProjectMediaRow): ProjectFile {
  const kind = row.kind === "video" ? "video" : "image";
  const id = encodeURIComponent(row.id);
  return {
    id: row.id,
    kind,
    title: `${kind}-${row.id.slice(0, 8)}.${mediaExt(row.mime)}`,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    ownerUserId: row.user_id,
    updatedAt: row.created_at,
    previewUrl: `/api/v1/media/${id}/file`,
    downloadUrl: `/api/v1/media/${id}/file?download=1`,
  };
}

// One code for "not visible or not there", the same as the artifact routes, so a caller cannot tell them apart.
function projectNotFound(): ApiError {
  return new ApiError("not_found", "Not found", 404);
}

function fileNotFound(): ApiError {
  return new ApiError("not_found", "Not found", 404);
}

/** The project the caller can see, or the same 404 an id nobody owns gets. */
function requireVisible(scope: TenantContext, projectId: string): ProjectRow {
  const row = store.findVisibleProject(scope, projectId);
  if (!row) {
    throw projectNotFound();
  }
  return row;
}

function isMaker(scope: TenantContext, row: ProjectRow): boolean {
  return row.created_by === scope.userId;
}

export function listProjects(scope: TenantContext): ProjectRecord[] {
  return store.listVisibleProjects(scope, PROJECT_LIMIT).map(toRecord);
}

export function createProject(
  scope: TenantContext,
  input: CreateProjectInput,
  now: number = Date.now(),
): ProjectRecord {
  return store.inTransaction(() => {
    if (store.countLiveProjects(scope) >= PROJECT_LIMIT) {
      throw new ApiError("project_limit", "This desk has as many projects as it can hold. Archive some first.", 409);
    }
    const id = crypto.randomUUID();
    store.insertProject(scope, id, input.name, now);
    return toRecord(requireVisible(scope, id));
  });
}

export function updateProject(
  scope: TenantContext,
  projectId: string,
  input: UpdateProjectInput,
  now: number = Date.now(),
): ProjectRecord {
  return store.inTransaction(() => {
    const row = requireVisible(scope, projectId);
    if (input.visibility !== undefined && !isMaker(scope, row)) {
      throw new ApiError("not_allowed", "Only the person who made this project can change who sees it.", 403);
    }
    if (input.name !== undefined && !isMaker(scope, row) && !canAdminister(scope.role)) {
      throw new ApiError("not_allowed", "Only the maker or an owner or admin can rename this project.", 403);
    }
    if (input.instructions !== undefined && scanInjection(input.instructions)) {
      // Instructions go into every chat in the Workspace as trusted text, so they get the same guard as a source.
      throw new ApiError(
        "injection_blocked",
        "These instructions were not saved: they carry prompt-injection text.",
        400,
      );
    }
    store.updateProjectRow(scope, projectId, input, now);
    return toRecord(requireVisible(scope, projectId));
  });
}

export function archiveProject(scope: TenantContext, projectId: string, now: number = Date.now()): void {
  store.inTransaction(() => {
    const row = requireVisible(scope, projectId);
    if (!isMaker(scope, row) && !canAdminister(scope.role)) {
      throw new ApiError("not_allowed", "Only the maker or an owner or admin can archive this project.", 403);
    }
    store.archiveProjectRow(scope, projectId, now);
  });
}

/** The Workspace's files and its generated media, newest first. Each row is filtered by its own rule too. */
export function listProjectFiles(scope: TenantContext, projectId: string): ProjectFile[] {
  requireVisible(scope, projectId);
  const artifacts = store.listProjectFiles(scope, projectId, FILE_LIST_LIMIT).map(toFile);
  const media = store.listProjectMedia(scope, projectId, FILE_LIST_LIMIT).map(toMediaFile);
  return [...artifacts, ...media].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, FILE_LIST_LIMIT);
}

/** Put the caller's own chat file into the Workspace, and make it one of the Workspace's knowledge sources. */
export async function addProjectFile(scope: TenantContext, projectId: string, artifactId: string): Promise<void> {
  const file = store.inTransaction(() => {
    requireVisible(scope, projectId);
    const found = store.findVisibleFile(scope, artifactId);
    if (!found) {
      throw fileNotFound();
    }
    // A legacy file with no owner is not the caller's either, so it cannot be put into a project.
    if (found.owner_user_id !== scope.userId) {
      throw new ApiError("not_allowed", "Only the person who made this file can add it to a project.", 403);
    }
    store.setFileProject(scope, artifactId, projectId);
    return found;
  });
  await attachArtifactKnowledge(scope, file.id, projectId, file.owner_user_id);
}

/**
 * Put the caller's own generated image or video into the Workspace (SR-175). The same three rules as a chat
 * file: a media row the caller cannot see is a 404, one they can see but did not make is a 403, and the
 * Workspace must be one the caller can see. Only images and videos are added; audio is refused.
 */
export function addProjectMedia(scope: TenantContext, projectId: string, mediaId: string): void {
  store.inTransaction(() => {
    requireVisible(scope, projectId);
    const found = store.findVisibleMedia(scope, mediaId);
    if (!found) {
      throw fileNotFound();
    }
    if (found.user_id !== scope.userId) {
      throw new ApiError("not_allowed", "Only the person who made this file can add it to a project.", 403);
    }
    if (found.kind !== "image" && found.kind !== "video") {
      throw new ApiError("invalid_project", "Only images and videos can be added to a Workspace.", 400);
    }
    store.setMediaProject(scope, mediaId, projectId);
  });
}

export function removeProjectFile(scope: TenantContext, projectId: string, artifactId: string): void {
  store.inTransaction(() => {
    const row = requireVisible(scope, projectId);
    const file = store.findVisibleFile(scope, artifactId);
    if (!file || file.project_id !== projectId) {
      throw fileNotFound();
    }
    if (file.owner_user_id !== scope.userId && !isMaker(scope, row)) {
      throw new ApiError("not_allowed", "Only the maker of this file or of the project can remove it.", 403);
    }
    store.setFileProject(scope, artifactId, null);
    detachArtifactKnowledge(scope, artifactId, projectId);
  });
}

/** Take a generated image or video out of the Workspace: its maker or the Workspace's maker may (SR-175). */
export function removeProjectMedia(scope: TenantContext, projectId: string, mediaId: string): void {
  store.inTransaction(() => {
    const row = requireVisible(scope, projectId);
    const found = store.findVisibleMedia(scope, mediaId);
    if (!found || found.project_id !== projectId) {
      throw fileNotFound();
    }
    if (found.user_id !== scope.userId && !isMaker(scope, row)) {
      throw new ApiError("not_allowed", "Only the maker of this file or of the project can remove it.", 403);
    }
    store.setMediaProject(scope, mediaId, null);
  });
}

/** The Workspace's knowledge, for a member; anyone else gets the same 404 an unknown Workspace gets. */
export function listProjectKnowledgeFor(scope: TenantContext, projectId: string): ProjectKnowledgeItem[] {
  requireVisible(scope, projectId);
  return listProjectKnowledge(scope, projectId);
}

/**
 * An upload into the Workspace. Any member may add knowledge (W1); the uploader owns the source.
 * Returns the source as the Workspace's knowledge list shows it.
 */
export async function uploadProjectKnowledge(
  scope: TenantContext,
  projectId: string,
  file: { filename: string; mime: string; bytes: Uint8Array },
): Promise<ProjectKnowledgeItem> {
  requireVisible(scope, projectId);
  const source: KnowledgeSource = await uploadProjectFile(scope, projectId, file, scope.userId);
  return {
    id: source.id,
    name: source.name,
    kind: source.type,
    status: source.status,
    chunks: source.chunks,
    addedBy: scope.userId,
    createdAt: source.createdAt,
  };
}

/**
 * Remove an upload from the Workspace: its uploader or the Workspace's maker may, and the source is deleted
 * with its chunks and bytes. A source that is not an upload of this Workspace is the same 404 as an unknown id.
 */
export function removeProjectKnowledge(scope: TenantContext, projectId: string, sourceId: string): void {
  const row = requireVisible(scope, projectId);
  const upload = uploadedSourceOf(scope, projectId, sourceId);
  if (!upload) {
    throw new ApiError("not_found", "Not found", 404);
  }
  if (upload.ownerUserId !== scope.userId && !isMaker(scope, row)) {
    throw new ApiError("not_allowed", "Only the uploader or the maker of this Workspace can remove it.", 403);
  }
  deleteSource(scope, sourceId);
}

/** The caller's own chats that were started in this Workspace. Threads stay per person, so no one else's show. */
export function listProjectThreadsFor(scope: TenantContext, projectId: string): ProjectThread[] {
  requireVisible(scope, projectId);
  return store.listOwnProjectThreads(scope, projectId).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
  }));
}

/**
 * A chat may be started in a Workspace only by a member of it: a Workspace the caller cannot see is the
 * same 404 as an unknown id. Returns the id, so the caller can store it on the thread.
 */
export function requireChatWorkspace(scope: TenantContext, projectId: string): string {
  requireVisible(scope, projectId);
  return projectId;
}

/**
 * The block of a chat's system prompt that carries its Workspace's instructions (W1), or the empty string
 * when the chat is not in a Workspace, the caller is not a member, or none has been written. Labelled, so
 * the model can tell the maker's instructions from the desk's own rules.
 */
export function workspacePromptBlock(scope: TenantContext, projectId: string | null): string {
  if (projectId === null) {
    return "";
  }
  const row = store.findVisibleProject(scope, projectId);
  const instructions = row?.instructions?.trim() ?? "";
  return instructions ? `\n\n# Workspace instructions\n${instructions}` : "";
}
