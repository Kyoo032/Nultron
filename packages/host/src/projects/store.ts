/**
 * Every SQL statement the projects feature runs (tester, F1 and W1). Synchronous better-sqlite3, like the board.
 *
 * Every statement filters on `organization_id` AND `workspace_id` from the caller's `TenantContext`,
 * never from the request. A Workspace is read only through the caller's own `project_members` row (K-D22):
 * a project the caller is not a member of is never selected. Visibility of a file is `visibleTo` in
 * `artifacts.ts`, and of a stored image or video `mediaVisibleClause` in `media-visibility.ts`: each rule
 * lives in one place, so this file reuses them.
 */
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { visibleTo } from "../artifacts";
import { mediaVisibleClause } from "../media-visibility";
import type { WorkspaceRole } from "./input";

/** A project as its member sees it: the row, the caller's own role in it, and how many members it has. */
export type ProjectRow = {
  id: string;
  name: string;
  instructions: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  role: WorkspaceRole;
  member_count: number;
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

/** A live project of the caller's desk, joined to the caller's own membership row. Binds the person first. */
const MEMBER_PROJECT_SELECT = `SELECT p.id, p.name, p.instructions, p.created_by, p.created_at, p.updated_at, p.archived_at,
    m.role AS role, (SELECT count(*) FROM project_members c WHERE c.project_id = p.id) AS member_count
  FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
  WHERE p.organization_id = ? AND p.workspace_id = ? AND p.archived_at IS NULL`;

export function countLiveProjects(scope: TenantContext): number {
  const row = sql
    .prepare(
      "SELECT count(*) AS n FROM projects WHERE organization_id = ? AND workspace_id = ? AND archived_at IS NULL",
    )
    .get(scope.organizationId, scope.workspaceId) as { n: number };
  return row.n;
}

/** A new project and its maker as its owner. Run inside the caller's transaction. */
export function insertProject(scope: TenantContext, id: string, name: string, now: number): void {
  sql
    .prepare(
      `INSERT INTO projects (id, organization_id, workspace_id, name, visibility, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'private', ?, ?, ?)`,
    )
    .run(id, scope.organizationId, scope.workspaceId, name, scope.userId, now, now);
  insertMember(id, scope.userId, "owner", scope.userId, now);
}

/** The project if the caller is a member of it; null for one they are not in, the same as an unknown id. */
export function findMemberProject(scope: TenantContext, id: string): ProjectRow | null {
  const row = sql
    .prepare(`${MEMBER_PROJECT_SELECT} AND p.id = ?`)
    .get(scope.userId, scope.organizationId, scope.workspaceId, id) as ProjectRow | undefined;
  return row ?? null;
}

export function listMemberProjects(scope: TenantContext, limit: number): ProjectRow[] {
  return sql
    .prepare(`${MEMBER_PROJECT_SELECT} ORDER BY p.updated_at DESC LIMIT ?`)
    .all(scope.userId, scope.organizationId, scope.workspaceId, limit) as ProjectRow[];
}

export function updateProjectRow(
  scope: TenantContext,
  id: string,
  changes: { name?: string; instructions?: string },
  now: number,
): void {
  // Column names are fixed literals below, never taken from the request.
  const sets: string[] = ["updated_at = ?"];
  const args: Array<string | number> = [now];
  if (changes.name !== undefined) {
    sets.push("name = ?");
    args.push(changes.name);
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

export type MemberRow = {
  user_id: string;
  name: string | null;
  role: WorkspaceRole;
  added_by: string;
  added_at: number;
};

/** The members of a project, owner first. The caller has checked they are one. */
export function listMembers(projectId: string): MemberRow[] {
  return sql
    .prepare(
      `SELECT m.user_id, u.name AS name, m.role, m.added_by, m.added_at
         FROM project_members m LEFT JOIN user u ON u.id = m.user_id
        WHERE m.project_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.added_at, m.user_id`,
    )
    .all(projectId) as MemberRow[];
}

export function memberRole(projectId: string, userId: string): WorkspaceRole | null {
  const row = sql
    .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as { role: WorkspaceRole } | undefined;
  return row?.role ?? null;
}

/** Adds a member. A person who is one already keeps the role they have. */
export function insertMember(
  projectId: string,
  userId: string,
  role: WorkspaceRole,
  addedBy: string,
  now: number,
): void {
  sql
    .prepare(
      "INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(projectId, userId, role, addedBy, now);
}

export function deleteMember(projectId: string, userId: string): void {
  sql.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, userId);
}

export function setMemberRole(projectId: string, userId: string, role: WorkspaceRole): void {
  sql.prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?").run(role, projectId, userId);
}

/** A person of the caller's company, in the caller's tenant: the only people a Workspace may take in. */
export function isCompanyMember(scope: TenantContext, userId: string): boolean {
  return (
    sql
      .prepare(
        `SELECT 1 AS ok FROM organization_members om JOIN organizations o ON o.id = om.organization_id
          WHERE om.organization_id = ? AND o.tenant_id = ? AND om.user_id = ?`,
      )
      .get(scope.organizationId, scope.tenantId, userId) !== undefined
  );
}

export type ProjectAgentRow = { agent_id: string; brought_by: string; added_at: number };

export function listProjectAgents(projectId: string): ProjectAgentRow[] {
  return sql
    .prepare(
      "SELECT agent_id, brought_by, added_at FROM project_agents WHERE project_id = ? ORDER BY added_at, agent_id, brought_by",
    )
    .all(projectId) as ProjectAgentRow[];
}

export function insertProjectAgent(projectId: string, agentId: string, broughtBy: string, now: number): void {
  sql
    .prepare("INSERT OR IGNORE INTO project_agents (project_id, agent_id, brought_by, added_at) VALUES (?, ?, ?, ?)")
    .run(projectId, agentId, broughtBy, now);
}

/** Takes the agent out: every member's copy of it, or only `broughtBy`'s when one is named. Returns the rows removed. */
export function deleteProjectAgent(projectId: string, agentId: string, broughtBy: string | null): number {
  if (broughtBy === null) {
    return sql.prepare("DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?").run(projectId, agentId)
      .changes;
  }
  return sql
    .prepare("DELETE FROM project_agents WHERE project_id = ? AND agent_id = ? AND brought_by = ?")
    .run(projectId, agentId, broughtBy).changes;
}

export function hasProjectAgent(projectId: string, agentId: string): boolean {
  return (
    sql.prepare("SELECT 1 AS ok FROM project_agents WHERE project_id = ? AND agent_id = ?").get(projectId, agentId) !==
    undefined
  );
}

/**
 * The files of a project the caller may see. The caller's membership is checked first; the file rule
 * (`visibleTo`) is applied again per row.
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

/** The media of a project the caller may see; membership is checked by the caller first. Same per-row rule as files. */
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
