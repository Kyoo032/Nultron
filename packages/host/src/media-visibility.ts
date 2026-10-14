/**
 * Who may read or delete a generated file on the hosted app (SR-175, SR-176; team-board-spec.md sections 2b and 11).
 *
 * A person's own generated media is theirs. A row joins a Workspace (`media.project_id`, set by
 * `projects/service.ts`), and while that Workspace is `workspace` everyone in the company may read it. The
 * rule is one SQL clause and one JavaScript twin, the same shape as `visibleTo` for artifacts (`artifacts.ts`).
 *
 * Two readers, on purpose:
 * - `desk`: every row of the organization, as before. Nothing reads this way on the hosted app after W1c; it
 *   stays so a caller that really means "the whole desk" can say so in one word.
 * - `person`: the rule above. Every read on the hosted app uses it: the file route, the studio galleries, the
 *   storage list, Edit's stills and outputs, and a job mode's inlined pictures.
 *
 * Deleting is a separate rule (`mayDeleteFile`): the maker, or a company owner or admin, and nobody else.
 *
 * Off server mode every reader here answers as the desk reader does, and the delete rule allows every delete, so
 * Personal's SQL is what it was.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { db, media } from "@agentforge/db";
import { canAdminister, isServerMode, type TenantContext } from "@agentforge/core";
import { readTenantObject } from "./tenant-storage";

export type MediaReach = "desk" | "person";

/** The part of a caller the `person` rule reads: which desk the Workspace must be on, and who is asking. */
export type MediaReachViewer = Pick<TenantContext, "userId" | "workspaceId">;

/** A caller, and the company it reads in. Edit reads a job's output as the requester, with this shape. */
export type MediaViewer = Pick<TenantContext, "organizationId" | "userId" | "workspaceId">;

/**
 * The media of a live, shared Workspace on the caller's desk. Only the caller's current desk is named, so a
 * Workspace of another desk of the same company is not a way in. Keep this and `mediaVisibleClause` in step.
 */
function sharedMediaSql(viewer: MediaReachViewer): SQL {
  return sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${media.projectId} AND p.organization_id = ${media.organizationId} AND p.workspace_id = ${viewer.workspaceId} AND p.visibility = 'workspace' AND p.archived_at IS NULL)`;
}

/**
 * The drizzle condition `reach` adds to a query on `media`, or undefined when it adds none. The `person` answer
 * is the maker's own row or a row in a shared Workspace of the caller's desk. Undefined off server mode and for
 * `desk`, so the query is the one it was.
 */
export function mediaReachWhere(viewer: MediaReachViewer, reach: MediaReach): SQL | undefined {
  if (reach === "desk" || !isServerMode()) {
    return undefined;
  }
  return or(eq(media.userId, viewer.userId), sharedMediaSql(viewer));
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

/**
 * The whole stored row, for a viewer the `person` rule lets see it; null for a row that is not there and for one the
 * rule hides, which answer the same way.
 */
export async function loadVisibleMediaRow(viewer: MediaViewer, mediaId: string) {
  const rows = await db
    .select()
    .from(media)
    .where(
      and(eq(media.organizationId, viewer.organizationId), eq(media.id, mediaId), mediaReachWhere(viewer, "person")),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The bytes of a stored row as a data URL, for a caller the `person` rule lets see it; null otherwise. */
export async function readVisibleMediaDataUrl(tenant: TenantContext, mediaId: string): Promise<string | null> {
  const item = await loadVisibleMediaRow(tenant, mediaId);
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

/**
 * Who may delete a generated file, an image or video or a document or deck alike (SR-176). The maker may. So may a
 * company owner or admin, who may delete a person's file and may never read it (the leaver rule, 2026-10-06). A
 * legacy file with no maker is the company's, so only an owner or admin deletes it. Off server mode the desk has one
 * person, so the rule allows every delete, as it always did.
 *
 * Callers answer a refusal exactly like a missing id: a delete that this returns false for must look the same as one
 * for a file that is not there.
 */
export function mayDeleteFile(viewer: Pick<TenantContext, "role" | "userId">, makerUserId: string | null): boolean {
  if (!isServerMode()) {
    return true;
  }
  if (canAdminister(viewer.role)) {
    return true;
  }
  return makerUserId !== null && makerUserId === viewer.userId;
}
