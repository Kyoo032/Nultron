/**
 * The one join the webhook needs: a channel's `workspace_id` (the desk's workspace id) to the
 * TenantContext the run acts under. Built without a session — the webhook is unauthenticated by
 * design, the signature being its credential, so the context is assembled row by row here.
 */
import type { MembershipRole, TenantContext } from "@agentforge/core";
import type Database from "better-sqlite3";

type Sql = Pick<Database.Database, "prepare">;

export type EmailActor = { tenant: TenantContext; agentId: string } | null;

/** The tenant (`tenants.id`) a workspace belongs to — the audit row's tenant_id. */
export function resolveTenantId(sql: Sql, workspaceId: string): string | null {
  const row = sql
    .prepare(
      `SELECT o.tenant_id AS tenantId
       FROM workspaces w JOIN organizations o ON o.id = w.organization_id
       WHERE w.id = ?`,
    )
    .get(workspaceId) as { tenantId: string } | undefined;
  return row?.tenantId ?? null;
}

export function resolveEmailActor(sql: Sql, workspaceId: string, userId: string | null, agentId: string): EmailActor {
  const workspace = sql
    .prepare(`SELECT id, organization_id AS organizationId FROM workspaces WHERE id = ?`)
    .get(workspaceId) as { id: string; organizationId: string } | undefined;
  if (!workspace) {
    return null;
  }
  const organization = sql
    .prepare(`SELECT id, tenant_id AS tenantId FROM organizations WHERE id = ?`)
    .get(workspace.organizationId) as { id: string; tenantId: string } | undefined;
  if (!organization) {
    return null;
  }
  const resolvedUserId =
    userId ??
    (
      sql
        .prepare(
          `SELECT user_id AS userId FROM workspace_members WHERE workspace_id = ? AND role = 'owner' ORDER BY rowid LIMIT 1`,
        )
        .get(workspaceId) as { userId: string } | undefined
    )?.userId;
  if (!resolvedUserId) {
    return null;
  }
  const member = sql
    .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .get(workspaceId, resolvedUserId) as { role: MembershipRole } | undefined;
  return {
    agentId,
    tenant: {
      tenantId: organization.tenantId,
      organizationId: organization.id,
      workspaceId: workspace.id,
      userId: resolvedUserId,
      role: member?.role ?? "member",
    },
  };
}
