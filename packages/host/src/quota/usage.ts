import { sql } from "@agentforge/db";
import { periodStartFor, requireScope, type QuotaScope } from "./common";
import { selectAllocationRows, effectiveSpent } from "./views";

export type PersonUsageView = {
  allocationId: string;
  allocationName: string;
  userId: string;
  periodStart: number;
  spentMicros: number;
  heldMicros: number;
};

export type AllocationUsageView = {
  allocationId: string;
  name: string;
  status: string;
  limitMicros: number;
  spentMicros: number;
  heldMicros: number;
};

export type OrganizationUsage = { allocations: AllocationUsageView[]; people: PersonUsageView[] };

type PersonJoinRow = {
  allocation_id: string;
  name: string;
  user_id: string;
  period_start: number;
  spent_micros: number;
  held_micros: number;
  period_kind: "lifetime" | "monthly";
};

const PERSON_SELECT = `SELECT u.allocation_id, a.name, u.user_id, u.period_start, u.spent_micros, u.held_micros, a.period_kind
  FROM quota_person_usage u JOIN quota_allocations a ON a.id = u.allocation_id
 WHERE a.organization_id = ? AND a.tenant_id = ?`;

function currentRows(rows: readonly PersonJoinRow[], now: number): PersonUsageView[] {
  return rows
    .filter((row) => row.period_start === periodStartFor(row.period_kind, now))
    .map((row) => ({
      allocationId: row.allocation_id,
      allocationName: row.name,
      userId: row.user_id,
      periodStart: row.period_start,
      spentMicros: row.spent_micros,
      heldMicros: row.held_micros,
    }));
}

export function getPersonUsage(scope: QuotaScope, userId: string, now = Date.now()): PersonUsageView[] {
  requireScope(scope);
  const rows = sql
    .prepare(`${PERSON_SELECT} AND u.user_id = ? ORDER BY a.created_at, u.allocation_id`)
    .all(scope.organizationId, scope.tenantId, userId) as PersonJoinRow[];
  return currentRows(rows, now);
}

export function getOrganizationUsage(scope: QuotaScope, now = Date.now()): OrganizationUsage {
  requireScope(scope);
  const people = sql
    .prepare(`${PERSON_SELECT} ORDER BY u.user_id, u.allocation_id`)
    .all(scope.organizationId, scope.tenantId) as PersonJoinRow[];
  return {
    allocations: selectAllocationRows(scope, true).map((row) => ({
      allocationId: row.id,
      name: row.name,
      status: row.status,
      limitMicros: row.limit_micros,
      spentMicros: effectiveSpent(row, now),
      heldMicros: row.held_micros,
    })),
    people: currentRows(people, now),
  };
}

export function ledgerSpentMicros(scope: QuotaScope, allocationId: string): number {
  requireScope(scope);
  const row = sql
    .prepare(
      `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total FROM tenant_usage
        WHERE tenant_id = ? AND organization_id = ? AND allocation_id = ?`,
    )
    .get(scope.tenantId, scope.organizationId, allocationId) as { total: number };
  return row.total;
}
