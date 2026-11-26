import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuditEventInput } from "@agentforge/core";

/**
 * The F2 append path. Every row carries `prev_hash` = the previous row's `row_hash`, where
 * `row_hash` is SHA-256 over the row's metadata fields — a rewrite of any stored byte breaks the
 * row's own hash and every row after it. `000…` is the chain's genesis link.
 *
 * The whole read-last-hash → compute → insert sequence runs inside one IMMEDIATE transaction:
 * better-sqlite3 is synchronous, so two appends can never read the same tail and split the chain.
 */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

export type AuditRow = {
  seq: number;
  id: string;
  tenant_id: string;
  at: number;
  actor_kind: string;
  actor_id: string | null;
  agent_id: string | null;
  event: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: string | null;
  duration_ms: number | null;
  item_count: number | null;
  ref_hash: string | null;
  channel: string | null;
  rule: string | null;
  prev_hash: string;
  row_hash: string;
};

/** The table's columns, exported so the no-content test can check every one of them by name. */
export const COLUMNS_FOR_TEST = [
  "seq",
  "id",
  "tenant_id",
  "at",
  "actor_kind",
  "actor_id",
  "agent_id",
  "event",
  "target_kind",
  "target_id",
  "outcome",
  "duration_ms",
  "item_count",
  "ref_hash",
  "channel",
  "rule",
  "prev_hash",
  "row_hash",
] as const;

/** Canonical digest input: one fixed field order, NUL-joined so field boundaries cannot smudge. */
export function auditRowHash(row: Omit<AuditRow, "row_hash">): string {
  const parts: readonly (string | number | null)[] = [
    row.seq,
    row.id,
    row.tenant_id,
    row.at,
    row.actor_kind,
    row.actor_id,
    row.agent_id,
    row.event,
    row.target_kind,
    row.target_id,
    row.outcome,
    row.duration_ms,
    row.item_count,
    row.ref_hash,
    row.channel,
    row.rule,
    row.prev_hash,
  ];
  return createHash("sha256")
    .update(parts.map((part) => (part === null ? "" : String(part))).join("\u0000"))
    .digest("hex");
}

const LAST_ROW = "SELECT seq, row_hash FROM audit_events ORDER BY seq DESC LIMIT 1";

const INSERT_ROW = `INSERT INTO audit_events
  (id, tenant_id, at, actor_kind, actor_id, agent_id, event, target_kind, target_id,
   outcome, duration_ms, item_count, ref_hash, channel, rule, prev_hash, row_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Append one already-validated event; returns the new row's `seq`. The event is trusted to have
 * passed `auditEventInput` (the sink parses before calling here), so nothing user-shaped reaches
 * this statement — only the named metadata columns.
 */
export function appendAuditEvent(db: Database.Database, event: AuditEventInput): number {
  return db.transaction((): number => {
    const last = db.prepare(LAST_ROW).get() as { seq: number; row_hash: string } | undefined;
    // A full retention purge leaves no tail to chain from: the next row continues above the
    // checkpoint's own seq and links to its hash, never restarting at 1 inside the purged range.
    const anchor =
      last ??
      (db
        .prepare("SELECT seq, row_hash FROM audit_checkpoints ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; row_hash: string } | undefined);
    const seq = (anchor?.seq ?? 0) + 1;
    const base: Omit<AuditRow, "row_hash"> = {
      seq,
      id: randomUUID(),
      tenant_id: event.tenantId,
      at: event.at ?? Date.now(),
      actor_kind: event.actorKind,
      actor_id: event.actorId ?? null,
      agent_id: event.agentId ?? null,
      event: event.event,
      target_kind: event.targetKind ?? null,
      target_id: event.targetId ?? null,
      outcome: event.outcome ?? null,
      duration_ms: event.durationMs ?? null,
      item_count: event.itemCount ?? null,
      ref_hash: event.refHash ?? null,
      channel: event.channel ?? null,
      rule: event.rule ?? null,
      prev_hash: anchor?.row_hash ?? AUDIT_GENESIS_HASH,
    };
    const row_hash = auditRowHash(base);
    db.prepare(INSERT_ROW).run(
      base.id,
      base.tenant_id,
      base.at,
      base.actor_kind,
      base.actor_id,
      base.agent_id,
      base.event,
      base.target_kind,
      base.target_id,
      base.outcome,
      base.duration_ms,
      base.item_count,
      base.ref_hash,
      base.channel,
      base.rule,
      base.prev_hash,
      row_hash,
    );
    return seq;
  })();
}

export type AuditEventFilter = {
  tenantId: string;
  from?: number;
  to?: number;
  actor?: string;
  agent?: string;
  event?: string;
  outcome?: string;
  /** Keyset cursor: rows with `seq` strictly below this. */
  cursor?: number;
  limit?: number;
};

/**
 * Filtered read for `GET /audit/events` and the export path. Keyset pagination on `seq` (the
 * append order) rather than OFFSET, so a live tail cannot shift a page under the reader.
 */
export function listAuditEvents(db: Database.Database, filter: AuditEventFilter): AuditRow[] {
  const clauses: string[] = ["tenant_id = ?"];
  const args: (string | number)[] = [filter.tenantId];
  const add = (clause: string, value: string | number | undefined) => {
    if (value !== undefined) {
      clauses.push(clause);
      args.push(value);
    }
  };
  add("at >= ?", filter.from);
  add("at <= ?", filter.to);
  add("actor_id = ?", filter.actor);
  add("agent_id = ?", filter.agent);
  add("event = ?", filter.event);
  add("outcome = ?", filter.outcome);
  add("seq < ?", filter.cursor);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500_000);
  return db
    .prepare(`SELECT * FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ${limit}`)
    .all(...args) as AuditRow[];
}
