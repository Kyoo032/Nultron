import { sql } from "@agentforge/db";

/**
 * The one sentence every Workspace read rule is built from (K-D22): a live project the person is a member of.
 * Files (`artifacts.ts`), stored media (`media-visibility.ts`), knowledge (`knowledge-visibility.ts`) and the
 * projects store all use it, so membership is written once. `media-visibility.ts` also holds a drizzle twin.
 *
 * The fragment binds one `?` (the person) before any `?` in `where`. `where` names the project row as `p`.
 */
export function memberOfLiveProjectSql(where: string): string {
  return `EXISTS (SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ? WHERE p.archived_at IS NULL AND ${where})`;
}

/**
 * True for a file no live Workspace holds: it has no project, or its Workspace was archived. Only then is a file
 * its maker's own (SR-179). A file in a live Workspace belongs to the Workspace, and its maker reads it only as a
 * member. `projectRef` is the file's qualified `project_id` column. Binds no `?`.
 */
export function heldByNoLiveProjectSql(projectRef: string): string {
  return `NOT EXISTS (SELECT 1 FROM projects lp WHERE lp.id = ${projectRef} AND lp.archived_at IS NULL)`;
}

/**
 * True when a live Workspace holds the file and the person is not one of its members: a maker removed from the
 * Workspace may neither read nor delete what they put in (SR-179). Binds one `?`: the person.
 */
export function lockedOutOfLiveProjectSql(projectRef: string): string {
  return `EXISTS (SELECT 1 FROM projects lp WHERE lp.id = ${projectRef} AND lp.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM project_members lm WHERE lm.project_id = lp.id AND lm.user_id = ?))`;
}

/** `lockedOutOfLiveProjectSql` for one file's project id, for a caller that has already loaded the row. */
export function isLockedOutOfProject(userId: string, projectId: string | null): boolean {
  if (projectId === null) {
    return false;
  }
  return sql.prepare(`SELECT 1 AS locked WHERE ${lockedOutOfLiveProjectSql("?")}`).get(projectId, userId) !== undefined;
}
