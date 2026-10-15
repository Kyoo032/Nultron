import { sql } from "@agentforge/db";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@agentforge/core";
import {
  resolveAllocation,
  type AllocationView,
  type Payer,
  type QuotaModelsMode,
  type QuotaScopeKind,
  type QuotaStatus,
  type Resolution,
} from "@agentforge/core/quota";
import { monthStart, periodStartFor, type QuotaScope } from "./common";

export type AllocationRow = {
  id: string;
  organization_id: string;
  tenant_id: string;
  name: string;
  scope_kind: QuotaScopeKind;
  limit_micros: number;
  per_person_limit_micros: number | null;
  period_kind: "lifetime" | "monthly";
  period_start: number | null;
  spent_micros: number;
  held_micros: number;
  models_mode: QuotaModelsMode;
  priority: number;
  status: QuotaStatus;
  gateway_token_id: string | null;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
};

export type AllocationDetail = AllocationView & {
  periodKind: "lifetime" | "monthly";
  periodStart: number | null;
  version: number;
  gatewayTokenId: string | null;
  createdBy: string;
  updatedAt: number;
};

const ALLOCATION_COLUMNS = `id, organization_id, tenant_id, name, scope_kind, limit_micros, per_person_limit_micros,
  period_kind, period_start, spent_micros, held_micros, models_mode, priority, status, gateway_token_id, version,
  created_by, created_at, updated_at`;

export function selectAllocationRow(scope: QuotaScope, id: string): AllocationRow | undefined {
  return sql
    .prepare(
      `SELECT ${ALLOCATION_COLUMNS} FROM quota_allocations WHERE id = ? AND organization_id = ? AND tenant_id = ?`,
    )
    .get(id, scope.organizationId, scope.tenantId) as AllocationRow | undefined;
}

export function selectAllocationRows(scope: QuotaScope, includeArchived: boolean): AllocationRow[] {
  const archived = includeArchived ? "" : "AND status <> 'archived'";
  return sql
    .prepare(
      `SELECT ${ALLOCATION_COLUMNS} FROM quota_allocations
        WHERE organization_id = ? AND tenant_id = ? ${archived} ORDER BY created_at, id`,
    )
    .all(scope.organizationId, scope.tenantId) as AllocationRow[];
}

export function effectiveSpent(row: AllocationRow, now: number): number {
  if (row.period_kind === "monthly" && (row.period_start === null || row.period_start < monthStart(now))) {
    return 0;
  }
  return row.spent_micros;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key(row), [row]);
    }
  }
  return grouped;
}

type PersonUsageRow = { allocation_id: string; spent_micros: number; held_micros: number };

function personUsageFor(
  scope: QuotaScope,
  userId: string,
  rows: readonly AllocationRow[],
  now: number,
): Map<string, PersonUsageRow> {
  const found = new Map<string, PersonUsageRow>();
  const stmt = sql.prepare(
    `SELECT u.allocation_id, u.spent_micros, u.held_micros FROM quota_person_usage u
       JOIN quota_allocations a ON a.id = u.allocation_id
      WHERE u.allocation_id = ? AND u.user_id = ? AND u.period_start = ? AND a.organization_id = ?`,
  );
  for (const row of rows) {
    if (row.per_person_limit_micros === null) {
      continue;
    }
    const usage = stmt.get(row.id, userId, periodStartFor(row.period_kind, now), scope.organizationId) as
      | PersonUsageRow
      | undefined;
    if (usage) {
      found.set(row.id, usage);
    }
  }
  return found;
}

export function loadViews(
  scope: QuotaScope,
  now: number,
  personUserId?: string,
  includeArchived = false,
): AllocationDetail[] {
  const rows = selectAllocationRows(scope, includeArchived);
  if (rows.length === 0) {
    return [];
  }
  const models = groupBy(
    sql
      .prepare(
        `SELECT m.allocation_id, m.model_id FROM quota_allocation_models m
           JOIN quota_allocations a ON a.id = m.allocation_id
          WHERE a.organization_id = ? AND a.tenant_id = ? ORDER BY m.model_id`,
      )
      .all(scope.organizationId, scope.tenantId) as Array<{ allocation_id: string; model_id: string }>,
    (row) => row.allocation_id,
  );
  const assignments = groupBy(
    sql
      .prepare(
        `SELECT s.allocation_id, s.subject_kind, s.subject_id FROM quota_assignments s
           JOIN quota_allocations a ON a.id = s.allocation_id
          WHERE a.organization_id = ? AND a.tenant_id = ? ORDER BY s.subject_id`,
      )
      .all(scope.organizationId, scope.tenantId) as Array<{
      allocation_id: string;
      subject_kind: "person" | "group";
      subject_id: string;
    }>,
    (row) => row.allocation_id,
  );
  const person =
    personUserId === undefined ? new Map<string, PersonUsageRow>() : personUsageFor(scope, personUserId, rows, now);
  return rows.map((row) => {
    const assigned = assignments.get(row.id) ?? [];
    const base: AllocationDetail = {
      id: row.id,
      name: row.name,
      scopeKind: row.scope_kind,
      status: row.status,
      limitMicros: row.limit_micros,
      spentMicros: effectiveSpent(row, now),
      heldMicros: row.held_micros,
      modelsMode: row.models_mode,
      models: (models.get(row.id) ?? []).map((entry) => entry.model_id),
      priority: row.priority,
      createdAt: row.created_at,
      assignedPersonIds: assigned.filter((entry) => entry.subject_kind === "person").map((entry) => entry.subject_id),
      assignedGroupIds: assigned.filter((entry) => entry.subject_kind === "group").map((entry) => entry.subject_id),
      periodKind: row.period_kind,
      periodStart: row.period_start,
      version: row.version,
      gatewayTokenId: row.gateway_token_id,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
    };
    if (row.per_person_limit_micros === null) {
      return base;
    }
    const usage = person.get(row.id);
    return {
      ...base,
      perPersonLimitMicros: row.per_person_limit_micros,
      ...(personUserId === undefined
        ? {}
        : { personSpentMicros: usage?.spent_micros ?? 0, personHeldMicros: usage?.held_micros ?? 0 }),
    };
  });
}

function asRole(value: string | undefined): MembershipRole | null {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value ?? "") ? (value as MembershipRole) : null;
}

export function loadPayer(scope: QuotaScope, userId: string): Payer {
  const member = sql
    .prepare("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?")
    .get(scope.organizationId, userId) as { role: string } | undefined;
  const groups = sql
    .prepare(
      `SELECT m.group_id FROM company_group_members m
         JOIN company_groups g ON g.id = m.group_id
        WHERE g.organization_id = ? AND g.tenant_id = ? AND g.archived_at IS NULL AND m.user_id = ?`,
    )
    .all(scope.organizationId, scope.tenantId, userId) as Array<{ group_id: string }>;
  return { userId, role: asRole(member?.role), groupIds: groups.map((row) => row.group_id) };
}

export function resolvePayerAllocation(
  scope: QuotaScope,
  userId: string,
  now: number,
): { payer: Payer; resolution: Resolution; views: AllocationDetail[] } {
  const payer = loadPayer(scope, userId);
  const views = loadViews(scope, now, userId);
  return { payer, resolution: resolveAllocation(payer, views), views };
}
