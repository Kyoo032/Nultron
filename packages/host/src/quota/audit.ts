import { randomUUID } from "node:crypto";
import { type QUOTA_AUDIT_ACTIONS, sql } from "@agentforge/db";
import { type QuotaScope, requireScope } from "./common";

export type QuotaAuditAction = (typeof QUOTA_AUDIT_ACTIONS)[number];

export type AuditValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditValue[]
  | { readonly [key: string]: AuditValue };

export type AuditRow = {
  id: string;
  actorUserId: string;
  action: QuotaAuditAction;
  allocationId: string | null;
  detail: AuditValue | null;
  at: number;
};

export function appendAudit(
  scope: QuotaScope,
  actorUserId: string,
  action: QuotaAuditAction,
  allocationId: string | null,
  detail: { readonly [key: string]: AuditValue },
  at: number,
): void {
  sql
    .prepare(
      `INSERT INTO quota_audit (id, organization_id, tenant_id, actor_user_id, action, allocation_id, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      scope.organizationId,
      scope.tenantId,
      actorUserId,
      action,
      allocationId,
      JSON.stringify(detail),
      at,
    );
}

export function listAudit(scope: QuotaScope, limit = 100): AuditRow[] {
  requireScope(scope);
  const rows = sql
    .prepare(
      `SELECT id, actor_user_id, action, allocation_id, detail, at FROM quota_audit
        WHERE organization_id = ? AND tenant_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(scope.organizationId, scope.tenantId, Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    id: string;
    actor_user_id: string;
    action: QuotaAuditAction;
    allocation_id: string | null;
    detail: string | null;
    at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    allocationId: row.allocation_id,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as AuditValue),
    at: row.at,
  }));
}
