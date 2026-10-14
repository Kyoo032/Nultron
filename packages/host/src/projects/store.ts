/**
 * Every SQL statement the projects feature runs (tester, F1). Synchronous better-sqlite3, like the board.
 *
 * Every statement filters on `organization_id` AND `workspace_id` from the caller's `TenantContext`,
 * never from the request. Visibility of a file is `visibleTo` in `artifacts.ts`, and of a stored image or
 * video `mediaVisibleClause` in `media-visibility.ts`: each rule lives in one place, so this file reuses them.
 */
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { visibleTo } from "../artifacts";
import { mediaVisibleClause } from "../media-visibility";
import type { ProjectVisibility } from "./input";

export type ProjectRow = {
  id: string;
  name: string;
  visibility: ProjectVisibility;
  instructions: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type ProjectFileRow = {
  id: string;
  title: string;
  mime: string;
  size_bytes: number;
  owner_user_id: string | null;
  project_id: string | null;
  updated_at: number;
};

/** Visible to the caller: their own project, or any project switched to the workspace. Never archived. */
const VISIBLE_PROJECT = `id = ? AND organization_id = ? AND workspace_id = ? AND archived_at IS NULL
  AND (created_by = ? OR visibility = 'workspace')`;

const PROJECT_COLUMNS = "id, name, visibility, instructions, created_by, created_at, updated_at, archived_at";

export function countLiveProjects(scope: TenantContext): number {
  const row = sql
    .prepare(
      "SELECT count(*) AS n FROM projects WHERE organization_id = ? AND workspace_id = ? AND archived_at IS NULL",
    )
    .get(scope.organizationId, scope.workspaceId) as { n: number };
  return row.n;
}

export function insertProject(scope: TenantContext, id: string, name: string, now: number): void {
  sql
    .prepare(
      `INSERT INTO projects (id, organization_id, workspace_id, name, visibility, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'private', ?, ?, ?)`,
    )
    .run(id, scope.organizationId, scope.workspaceId, name, scope.userId, now, now);
}

export function findVisibleProject(scope: TenantContext, id: string): ProjectRow | null {
  const row = sql
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${VISIBLE_PROJECT}`)
    .get(id, scope.organizationId, scope.workspaceId, scope.userId) as ProjectRow | undefined;
  return row ?? null;
}

export function listVisibleProjects(scope: TenantContext, limit: number): ProjectRow[] {
  return sql
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects
        WHERE organization_id = ? AND workspace_id = ? AND archived_at IS NULL
          AND (created_by = ? OR visibility = 'workspace')
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(scope.organizationId, scope.workspaceId, scope.userId, limit) as ProjectRow[];
}

export function updateProjectRow(
  scope: TenantContext,
  id: string,
  changes: { name?: string; visibility?: ProjectVisibility; instructions?: string },
  now: number,
): void {
  // Column names are fixed literals below, never taken from the request.
  const sets: string[] = ["updated_at = ?"];
  const args: Array<string | number> = [now];
  if (changes.name !== undefined) {
    sets.push("name = ?");
    args.push(changes.name);
  }
  if (changes.visibility !== undefined) {
    sets.push("visibility = ?");
    args.push(changes.visibility);
  }
  if (changes.instructions !== undefined) {
    sets.push("instructions = ?");
    args.push(changes.instructions);
  }
  sql
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND organization_id = ? AND workspace_id = ?`)
    .run(...args, id, scope.organizationId, scope.workspaceId);
}

export function archiveProjectRow(scope: TenantContext, id: string, now: number): void {
  sql
    .prepare(
      "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND workspace_id = ?",
    )
    .run(now, now, id, scope.organizationId, scope.workspaceId);
}

/**
 * The files of a project the caller may see. The project's visibility is checked by the caller first;
 * the file rule is applied again per row, so a file a colleague added and the maker later made private
 * is not listed to anyone else.
 */
export function listProjectFiles(scope: TenantContext, projectId: string, limit: number): ProjectFileRow[] {
  const visible = visibleTo(scope);
  return sql
    .prepare(
      `SELECT id, title, mime, size_bytes, owner_user_id, project_id, updated_at FROM artifacts
        WHERE workspace_id = ? AND project_id = ?${visible.clause}
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(scope.workspaceId, projectId, ...visible.args, limit) as ProjectFileRow[];
}

/** A file the caller may see on this desk, or null: the same answer as an id nobody owns. */
export function findVisibleFile(scope: TenantContext, artifactId: string): ProjectFileRow | null {
  const visible = visibleTo(scope);
  const row = sql
    .prepare(
      `SELECT id, title, mime, size_bytes, owner_user_id, project_id, updated_at FROM artifacts
        WHERE workspace_id = ? AND id = ?${visible.clause}`,
    )
    .get(scope.workspaceId, artifactId, ...visible.args) as ProjectFileRow | undefined;
  return row ?? null;
}

export function setFileProject(scope: TenantContext, artifactId: string, projectId: string | null): void {
  sql
    .prepare("UPDATE artifacts SET project_id = ? WHERE workspace_id = ? AND id = ?")
    .run(projectId, scope.workspaceId, artifactId);
}

export type ProjectMediaRow = {
  id: string;
  kind: string;
  mime: string;
  size_bytes: number;
  user_id: string;
  project_id: string | null;
  created_at: number;
};

const MEDIA_COLUMNS = "id, kind, mime, size_bytes, user_id, project_id, created_at";

/** A stored image or video the caller may see (SR-175), or null: the same answer as an id nobody owns. */
export function findVisibleMedia(scope: TenantContext, mediaId: string): ProjectMediaRow | null {
  const visible = mediaVisibleClause(scope);
  const row = sql
    .prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE organization_id = ? AND id = ?${visible.clause}`)
    .get(scope.organizationId, mediaId, ...visible.args) as ProjectMediaRow | undefined;
  return row ?? null;
}

export function setMediaProject(scope: TenantContext, mediaId: string, projectId: string | null): void {
  sql
    .prepare("UPDATE media SET project_id = ? WHERE organization_id = ? AND id = ?")
    .run(projectId, scope.organizationId, mediaId);
}

/** The media of a project the caller may see; the project is checked by the caller first. Same per-row rule as files. */
export function listProjectMedia(scope: TenantContext, projectId: string, limit: number): ProjectMediaRow[] {
  const visible = mediaVisibleClause(scope);
  return sql
    .prepare(
      `SELECT ${MEDIA_COLUMNS} FROM media
        WHERE organization_id = ? AND project_id = ?${visible.clause}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope.organizationId, projectId, ...visible.args, limit) as ProjectMediaRow[];
}

export type ProjectThreadRow = { id: string; title: string; created_at: number };

/** The caller's own chats in one Workspace, newest first. Threads belong to a person, so the person is part of the key. */
export function listOwnProjectThreads(scope: TenantContext, projectId: string): ProjectThreadRow[] {
  return sql
    .prepare(
      `SELECT id, title, created_at FROM threads
        WHERE organization_id = ? AND workspace_id = ? AND user_id = ? AND project_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scope.organizationId, scope.workspaceId, scope.userId, projectId, PROJECT_THREAD_LIMIT) as ProjectThreadRow[];
}

const PROJECT_THREAD_LIMIT = 200;

export function inTransaction<T>(work: () => T): T {
  return sql.transaction(work)();
}
