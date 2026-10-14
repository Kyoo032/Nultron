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
