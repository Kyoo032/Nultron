/**
 * Who may read a stored image or video on the hosted app (SR-175; team-board-spec.md sections 2b and 11).
 *
 * A person's own generated media is theirs. A row joins a Workspace (`media.project_id`, set by
 * `projects/service.ts`), and while that Workspace is `workspace` everyone in the company may read it. The
 * rule is one SQL clause and one JavaScript twin, the same shape as `visibleTo` for artifacts (`artifacts.ts`).
 *
 * Two readers, on purpose:
 * - `desk` (the default everywhere `media.ts` reads by id): every row of the organization, as before. Edit,
 *   the job modes and the studio galleries still read this way; they are listed under SR-175 as desk-wide.
 * - `person`: the rule above. The file route and the chat's by-reference reads use it.
 *
 * Off server mode every reader here answers as the desk reader does, so Personal's SQL is what it was.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { db, media } from "@agentforge/db";
import { isServerMode, type TenantContext } from "@agentforge/core";
import { readTenantObject } from "./tenant-storage";

export type MediaReach = "desk" | "person";

/**
 * The media of a live, shared Workspace on the caller's desk. Only the caller's current desk is named, so a
 * Workspace of another desk of the same company is not a way in. Keep this and `mediaVisibleClause` in step.
 */
function sharedMediaSql(tenant: TenantContext): SQL {
  return sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${media.projectId} AND p.organization_id = ${media.organizationId} AND p.workspace_id = ${tenant.workspaceId} AND p.visibility = 'workspace' AND p.archived_at IS NULL)`;
}

/**
 * The drizzle condition `reach` adds to a query on `media`, or undefined when it adds none. The `person` answer
 * is the maker's own row or a row in a shared Workspace of the caller's desk. Undefined off server mode and for
 * `desk`, so the query is the one it was.
 */
export function mediaReachWhere(tenant: TenantContext, reach: MediaReach): SQL | undefined {
  if (reach === "desk" || !isServerMode()) {
    return undefined;
  }
  return or(eq(media.userId, tenant.userId), sharedMediaSql(tenant));
}

/**
 * The same rule as a raw SQL clause for the projects store, which runs its own statements on `media`. The
 * statement must read from a table called `media`. Empty off server mode, like `visibleTo`.
 */
export function mediaVisibleClause(tenant: TenantContext): { clause: string; args: string[] } {
  if (!isServerMode()) {
    return { clause: "", args: [] };
  }
  return {
    clause: ` AND (user_id = ? OR EXISTS (SELECT 1 FROM projects p WHERE p.id = media.project_id AND p.organization_id = media.organization_id AND p.workspace_id = ? AND p.visibility = 'workspace' AND p.archived_at IS NULL))`,
    args: [tenant.userId, tenant.workspaceId],
  };
}

/** What a stored row says about itself (its kind and stored size), for a caller the `person` rule lets see it. */
export async function statVisibleMedia(
  tenant: TenantContext,
  mediaId: string,
): Promise<{ kind: string; sizeBytes: number } | null> {
  const rows = await db
    .select({ kind: media.kind, sizeBytes: media.sizeBytes })
    .from(media)
    .where(
      and(eq(media.organizationId, tenant.organizationId), eq(media.id, mediaId), mediaReachWhere(tenant, "person")),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The bytes of a stored row as a data URL, for a caller the `person` rule lets see it; null otherwise. */
export async function readVisibleMediaDataUrl(tenant: TenantContext, mediaId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(media)
    .where(
      and(eq(media.organizationId, tenant.organizationId), eq(media.id, mediaId), mediaReachWhere(tenant, "person")),
    )
    .limit(1);
  const item = rows[0];
  if (!item) {
    return null;
  }
  try {
    const bytes = await readTenantObject(tenant.tenantId, item.storagePath);
    return `data:${item.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}
