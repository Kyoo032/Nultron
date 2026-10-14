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
 *   404; one they can see but did not make is a 403.
 * - Remove a file: the file's maker, or the project's maker.
 */
import { ApiError, canAdminister, type TenantContext } from "@agentforge/core";
import type { AddFileInput, CreateProjectInput, UpdateProjectInput } from "./input";
import * as store from "./store";
import type { ProjectFileRow, ProjectRow } from "./store";

/** Live projects one desk may hold. Archived ones do not count. */
export const PROJECT_LIMIT = 200;
const FILE_LIST_LIMIT = 200;

export type ProjectRecord = {
  id: string;
  name: string;
  visibility: "private" | "workspace";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectFile = {
  id: string;
  title: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  updatedAt: number;
};

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFile(row: ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    title: row.title,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    ownerUserId: row.owner_user_id,
    updatedAt: row.updated_at,
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

export function createProject(scope: TenantContext, input: CreateProjectInput, now: number = Date.now()): ProjectRecord {
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

export function listProjectFiles(scope: TenantContext, projectId: string): ProjectFile[] {
  requireVisible(scope, projectId);
  return store.listProjectFiles(scope, projectId, FILE_LIST_LIMIT).map(toFile);
}

export function addProjectFile(scope: TenantContext, projectId: string, input: AddFileInput): void {
  store.inTransaction(() => {
    requireVisible(scope, projectId);
    const file = store.findVisibleFile(scope, input.artifactId);
    if (!file) {
      throw fileNotFound();
    }
    // A legacy file with no owner is not the caller's either, so it cannot be put into a project.
    if (file.owner_user_id !== scope.userId) {
      throw new ApiError("not_allowed", "Only the person who made this file can add it to a project.", 403);
    }
    store.setFileProject(scope, input.artifactId, projectId);
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
  });
}
