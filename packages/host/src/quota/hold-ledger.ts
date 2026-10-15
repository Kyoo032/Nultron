import { sql } from "@agentforge/db";
import { monthStart, periodStartFor, type QuotaScope } from "./common";

export type HoldRow = {
  id: string;
  allocation_id: string;
  organization_id: string;
  tenant_id: string;
  user_id: string;
  run_id: string;
  seq: number;
  boot_id: string;
  kind: "text" | "image" | "video" | "music" | "audio";
  model: string;
  amount_micros: number;
  state: "open" | "settled" | "released" | "expired";
  settled_micros: number | null;
  cost_basis: "reported" | "list_price" | "estimated" | "expired_charge" | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
};

export const HOLD_COLUMNS = `id, allocation_id, organization_id, tenant_id, user_id, run_id, seq, boot_id, kind, model,
  amount_micros, state, settled_micros, cost_basis, created_at, expires_at, closed_at`;

type AllocationPeriod = { period_kind: "lifetime" | "monthly"; period_start: number | null };

function holdIsInCurrentPeriod(allocation: AllocationPeriod, createdAt: number): boolean {
  if (allocation.period_kind !== "monthly") {
    return true;
  }
  return allocation.period_start === null || allocation.period_start === monthStart(createdAt);
}

export type CloseSpec = {
  state: "settled" | "released" | "expired";
  chargedMicros: number | null;
  costBasis: HoldRow["cost_basis"];
  now: number;
};

export function closeOpenHold(hold: HoldRow, spec: CloseSpec): void {
  const allocation = sql
    .prepare("SELECT period_kind, period_start FROM quota_allocations WHERE id = ? AND organization_id = ?")
    .get(hold.allocation_id, hold.organization_id) as AllocationPeriod | undefined;
  const charge = spec.chargedMicros ?? 0;
  const personPeriod = periodStartFor(allocation?.period_kind ?? "lifetime", hold.created_at);
  const poolCharge = allocation && holdIsInCurrentPeriod(allocation, hold.created_at) ? charge : 0;
  sql
    .prepare(
      `UPDATE quota_allocations SET held_micros = MAX(held_micros - ?, 0), spent_micros = spent_micros + ?
        WHERE id = ? AND organization_id = ?`,
    )
    .run(hold.amount_micros, poolCharge, hold.allocation_id, hold.organization_id);
  sql
    .prepare(
      `UPDATE quota_person_usage SET held_micros = MAX(held_micros - ?, 0), spent_micros = spent_micros + ?
        WHERE allocation_id = ? AND user_id = ? AND period_start = ?`,
    )
    .run(hold.amount_micros, charge, hold.allocation_id, hold.user_id, personPeriod);
  sql
    .prepare(
      `UPDATE quota_holds SET state = ?, settled_micros = ?, cost_basis = ?, closed_at = ?
        WHERE id = ? AND organization_id = ? AND state = 'open'`,
    )
    .run(spec.state, spec.chargedMicros, spec.costBasis, spec.now, hold.id, hold.organization_id);
}

export function chargeExpiredHold(hold: HoldRow, now: number): void {
  closeOpenHold(hold, { state: "expired", chargedMicros: hold.amount_micros, costBasis: "expired_charge", now });
}

export function chargeOpenHoldsOf(scope: QuotaScope, now: number): number {
  const open = sql
    .prepare(`SELECT ${HOLD_COLUMNS} FROM quota_holds WHERE organization_id = ? AND tenant_id = ? AND state = 'open'`)
    .all(scope.organizationId, scope.tenantId) as HoldRow[];
  let charged = 0;
  for (const hold of open) {
    chargeExpiredHold(hold, now);
    charged += hold.amount_micros;
  }
  return charged;
}

export function sweepExpiredInScope(scope: QuotaScope, now: number): number {
  const expired = sql
    .prepare(
      `SELECT ${HOLD_COLUMNS} FROM quota_holds
        WHERE organization_id = ? AND tenant_id = ? AND state = 'open' AND expires_at <= ?`,
    )
    .all(scope.organizationId, scope.tenantId, now) as HoldRow[];
  for (const hold of expired) {
    chargeExpiredHold(hold, now);
  }
  return expired.length;
}
