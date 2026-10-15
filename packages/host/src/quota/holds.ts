import { randomUUID } from "node:crypto";
import { sql } from "@agentforge/db";
import { headroomMicros, modelAllowed, type QuotaErrorCode } from "@agentforge/core/quota";
import {
  assertMicros,
  chargeMicros,
  isBusyError,
  monthStart,
  periodStartFor,
  QuotaStoreError,
  requireScope,
  runImmediate,
  type QuotaScope,
} from "./common";
import { chargeExpiredHold, closeOpenHold, HOLD_COLUMNS, sweepExpiredInScope, type HoldRow } from "./hold-ledger";
import { log } from "../log";
import { resolvePayerAllocation } from "./views";

export const HOLD_KINDS = ["text", "image", "video", "music", "audio"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

export const DEFAULT_MAX_OPEN_HOLDS_PER_PAYER = 16;

export type PlaceHoldInput = {
  userId: string;
  runId: string;
  seq: number;
  kind: HoldKind;
  model: string;
  amountMicros: number;
  ttlMs: number;
  bootId: string;
  now?: number;
  maxOpenHolds?: number;
};

export type HoldView = {
  id: string;
  allocationId: string;
  userId: string;
  runId: string;
  seq: number;
  kind: HoldKind;
  model: string;
  amountMicros: number;
  state: HoldRow["state"];
  settledMicros: number | null;
  costBasis: HoldRow["cost_basis"];
  createdAt: number;
  expiresAt: number;
  closedAt: number | null;
};

export type PlaceHoldResult =
  | { ok: true; hold: HoldView }
  | { ok: false; code: QuotaErrorCode; remainingMicros?: number; limitMicros?: number };

export type SettleInput = {
  actualMicros: number;
  costBasis: "reported" | "list_price" | "estimated";
  now?: number;
  inTransaction?: (settled: { hold: HoldView; chargedMicros: number }) => void;
};

export type SettleResult =
  | { ok: true; hold: HoldView; chargedMicros: number; alreadyClosed: boolean }
  | { ok: false; code: "hold_not_found" | "busy" | "failed" };

export type ReleaseResult =
  | { ok: true; hold: HoldView; alreadyClosed: boolean }
  | { ok: false; code: "hold_not_found" | "hold_charged" | "busy" | "failed" };

class Refusal extends Error {
  constructor(readonly result: PlaceHoldResult) {
    super("quota_refusal");
  }
}

function toView(row: HoldRow): HoldView {
  return {
    id: row.id,
    allocationId: row.allocation_id,
    userId: row.user_id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    model: row.model,
    amountMicros: row.amount_micros,
    state: row.state,
    settledMicros: row.settled_micros,
    costBasis: row.cost_basis,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
  };
}

function selectHold(scope: QuotaScope, holdId: string): HoldRow | undefined {
  return sql
    .prepare(`SELECT ${HOLD_COLUMNS} FROM quota_holds WHERE id = ? AND organization_id = ? AND tenant_id = ?`)
    .get(holdId, scope.organizationId, scope.tenantId) as HoldRow | undefined;
}

export function getHold(scope: QuotaScope, holdId: string): HoldView | null {
  requireScope(scope);
  const row = selectHold(scope, holdId);
  return row ? toView(row) : null;
}

function validateHoldInput(input: PlaceHoldInput): void {
  assertMicros(input.amountMicros, "amountMicros", 1);
  if (!(HOLD_KINDS as readonly string[]).includes(input.kind)) {
    throw new QuotaStoreError("invalid_input", "kind");
  }
  if (!Number.isInteger(input.seq) || input.seq < 0) {
    throw new QuotaStoreError("invalid_input", "seq");
  }
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new QuotaStoreError("invalid_input", "ttlMs");
  }
  for (const [name, value] of [
    ["userId", input.userId],
    ["runId", input.runId],
    ["model", input.model],
    ["bootId", input.bootId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new QuotaStoreError("invalid_input", name);
    }
  }
}

function refuse(code: QuotaErrorCode, extra: { remainingMicros?: number; limitMicros?: number } = {}): PlaceHoldResult {
  return { ok: false, code, ...extra };
}

function reserve(scope: QuotaScope, input: PlaceHoldInput, now: number): PlaceHoldResult {
  requireScope(scope);
  sweepExpiredInScope(scope, now);
  const { resolution } = resolvePayerAllocation(scope, input.userId, now);
  if (!resolution.ok) {
    return refuse(resolution.code);
  }
  const allocation = resolution.allocation;
  if (!modelAllowed(allocation, input.model)) {
    return refuse("model_not_allowed");
  }
  const headroom = headroomMicros(allocation);
  const exceeded = refuse("quota_exceeded", { remainingMicros: headroom, limitMicros: allocation.limitMicros });
  if (input.amountMicros > headroom) {
    return exceeded;
  }
  const open = sql
    .prepare("SELECT count(*) AS n FROM quota_holds WHERE organization_id = ? AND user_id = ? AND state = 'open'")
    .get(scope.organizationId, input.userId) as { n: number };
  if (open.n >= (input.maxOpenHolds ?? DEFAULT_MAX_OPEN_HOLDS_PER_PAYER)) {
    return exceeded;
  }
  const row = sql
    .prepare(
      "SELECT period_kind, period_start, per_person_limit_micros FROM quota_allocations WHERE id = ? AND organization_id = ?",
    )
    .get(allocation.id, scope.organizationId) as {
    period_kind: "lifetime" | "monthly";
    period_start: number | null;
    per_person_limit_micros: number | null;
  };
  if (row.period_kind === "monthly" && (row.period_start === null || row.period_start < monthStart(now))) {
    sql
      .prepare("UPDATE quota_allocations SET spent_micros = 0, period_start = ? WHERE id = ? AND organization_id = ?")
      .run(monthStart(now), allocation.id, scope.organizationId);
  }
  const reserved = sql
    .prepare(
      `UPDATE quota_allocations SET held_micros = held_micros + ?
        WHERE id = ? AND organization_id = ? AND tenant_id = ? AND status = 'active'
          AND limit_micros - spent_micros - held_micros >= ?`,
    )
    .run(input.amountMicros, allocation.id, scope.organizationId, scope.tenantId, input.amountMicros);
  if (reserved.changes !== 1) {
    return exceeded;
  }
  const personPeriod = periodStartFor(row.period_kind, now);
  sql
    .prepare(
      `INSERT OR IGNORE INTO quota_person_usage (allocation_id, user_id, period_start, spent_micros, held_micros)
       VALUES (?, ?, ?, 0, 0)`,
    )
    .run(allocation.id, input.userId, personPeriod);
  const personUpdate = sql
    .prepare(
      `UPDATE quota_person_usage SET held_micros = held_micros + ?
        WHERE allocation_id = ? AND user_id = ? AND period_start = ?
          AND (? IS NULL OR ? - spent_micros - held_micros >= ?)`,
    )
    .run(
      input.amountMicros,
      allocation.id,
      input.userId,
      personPeriod,
      row.per_person_limit_micros,
      row.per_person_limit_micros,
      input.amountMicros,
    );
  if (personUpdate.changes !== 1) {
    throw new Refusal(exceeded);
  }
  const holdId = randomUUID();
  sql
    .prepare(
      `INSERT INTO quota_holds (id, allocation_id, organization_id, tenant_id, user_id, run_id, seq, boot_id, kind, model,
         amount_micros, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      holdId,
      allocation.id,
      scope.organizationId,
      scope.tenantId,
      input.userId,
      input.runId,
      input.seq,
      input.bootId,
      input.kind,
      input.model,
      input.amountMicros,
      now,
      now + input.ttlMs,
    );
  return { ok: true, hold: toView(selectHold(scope, holdId) as HoldRow) };
}

export function placeHold(scope: QuotaScope, input: PlaceHoldInput): PlaceHoldResult {
  validateHoldInput(input);
  const now = input.now ?? Date.now();
  try {
    return runImmediate(() => reserve(scope, input, now));
  } catch (error) {
    if (error instanceof Refusal) {
      return error.result;
    }
    if (isBusyError(error)) {
      return refuse("quota_busy");
    }
    throw error;
  }
}

function settleOpen(hold: HoldRow, input: SettleInput, now: number): { charged: number } {
  const charged = chargeMicros(input.actualMicros);
  closeOpenHold(hold, { state: "settled", chargedMicros: charged, costBasis: input.costBasis, now });
  return { charged };
}

function reconcileExpired(hold: HoldRow, input: SettleInput, now: number): { charged: number } {
  const charged = chargeMicros(input.actualMicros);
  const previous = hold.settled_micros ?? hold.amount_micros;
  const diff = charged - previous;
  const allocation = sql
    .prepare("SELECT period_kind, period_start FROM quota_allocations WHERE id = ? AND organization_id = ?")
    .get(hold.allocation_id, hold.organization_id) as
    | { period_kind: "lifetime" | "monthly"; period_start: number | null }
    | undefined;
  const sameBucket =
    !allocation ||
    allocation.period_kind !== "monthly" ||
    allocation.period_start === null ||
    allocation.period_start === monthStart(hold.created_at);
  if (sameBucket) {
    sql
      .prepare(
        "UPDATE quota_allocations SET spent_micros = MAX(spent_micros + ?, 0) WHERE id = ? AND organization_id = ?",
      )
      .run(diff, hold.allocation_id, hold.organization_id);
  }
  sql
    .prepare(
      `UPDATE quota_person_usage SET spent_micros = MAX(spent_micros + ?, 0)
        WHERE allocation_id = ? AND user_id = ? AND period_start = ?`,
    )
    .run(
      diff,
      hold.allocation_id,
      hold.user_id,
      periodStartFor(allocation?.period_kind ?? "lifetime", hold.created_at),
    );
  sql
    .prepare(
      `UPDATE quota_holds SET state = 'settled', settled_micros = ?, cost_basis = ?, closed_at = ?
        WHERE id = ? AND organization_id = ?`,
    )
    .run(charged, input.costBasis, now, hold.id, hold.organization_id);
  return { charged };
}

export function settleHold(scope: QuotaScope, holdId: string, input: SettleInput): SettleResult {
  const now = input.now ?? Date.now();
  try {
    return runImmediate((): SettleResult => {
      requireScope(scope);
      const hold = selectHold(scope, holdId);
      if (!hold) {
        return { ok: false, code: "hold_not_found" };
      }
      if (hold.state === "settled" || hold.state === "released") {
        return { ok: true, hold: toView(hold), chargedMicros: hold.settled_micros ?? 0, alreadyClosed: true };
      }
      const { charged } = hold.state === "open" ? settleOpen(hold, input, now) : reconcileExpired(hold, input, now);
      const settled = toView(selectHold(scope, holdId) as HoldRow);
      input.inTransaction?.({ hold: settled, chargedMicros: charged });
      return { ok: true, hold: settled, chargedMicros: charged, alreadyClosed: false };
    });
  } catch (error) {
    if (isBusyError(error)) {
      return { ok: false, code: "busy" };
    }
    log.error("quota_settle_failed", { holdId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, code: "failed" };
  }
}

export function releaseHold(scope: QuotaScope, holdId: string, now = Date.now()): ReleaseResult {
  try {
    return runImmediate((): ReleaseResult => {
      requireScope(scope);
      const hold = selectHold(scope, holdId);
      if (!hold) {
        return { ok: false, code: "hold_not_found" };
      }
      if (hold.state === "released") {
        return { ok: true, hold: toView(hold), alreadyClosed: true };
      }
      if (hold.state !== "open") {
        return { ok: false, code: "hold_charged" };
      }
      closeOpenHold(hold, { state: "released", chargedMicros: null, costBasis: null, now });
      return { ok: true, hold: toView(selectHold(scope, holdId) as HoldRow), alreadyClosed: false };
    });
  } catch (error) {
    if (isBusyError(error)) {
      return { ok: false, code: "busy" };
    }
    log.error("quota_release_failed", { holdId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, code: "failed" };
  }
}

export function sweepExpiredHolds(scope: QuotaScope, now = Date.now()): number {
  return runImmediate(() => {
    requireScope(scope);
    return sweepExpiredInScope(scope, now);
  });
}

export function sweepStaleBootHolds(currentBootId: string, now = Date.now()): number {
  return runImmediate(() => {
    const stale = sql
      .prepare(`SELECT ${HOLD_COLUMNS} FROM quota_holds WHERE state = 'open' AND boot_id <> ?`)
      .all(currentBootId) as HoldRow[];
    for (const hold of stale) {
      chargeExpiredHold(hold, now);
    }
    return stale.length;
  });
}
