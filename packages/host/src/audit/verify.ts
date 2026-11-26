import type Database from "better-sqlite3";
import { AUDIT_GENESIS_HASH, auditRowHash, type AuditRow } from "./store";

export type AuditVerification = {
  ok: boolean;
  /** The first row whose stored hash or chain link fails to check, if any. */
  firstBadSeq?: number;
  /** Rows walked, including any skipped because a purge checkpoint covers them. */
  checked: number;
};

/**
 * Re-walk the chain for one tenant and prove every link. After a retention purge the rows before
 * `audit_checkpoints.seq` are gone by design: verification starts at the checkpoint's own hash —
 * the last purged row — so the first surviving row still has its `prev_hash` to check against and
 * a tampered tail is caught just as before (spec AC-2.8).
 */
export function verifyAuditChain(db: Database.Database, tenantId: string): AuditVerification {
  const checkpoint = db
    .prepare(
      `SELECT seq, row_hash FROM audit_checkpoints
       WHERE seq = (SELECT COALESCE(max_seq, 0) FROM audit_purge_window WHERE id = 1)`,
    )
    .get() as { seq: number; row_hash: string } | undefined;
  const startAfter = checkpoint?.seq ?? 0;
  const rows = db
    .prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND seq > ? ORDER BY seq ASC")
    .all(tenantId, startAfter) as AuditRow[];
  let expectedPrev = checkpoint?.row_hash ?? AUDIT_GENESIS_HASH;
  let checked = 0;
  for (const row of rows) {
    checked += 1;
    const { row_hash, ...fields } = row;
    if (row.prev_hash !== expectedPrev || row_hash !== auditRowHash(fields)) {
      return { ok: false, firstBadSeq: row.seq, checked };
    }
    expectedPrev = row.row_hash;
  }
  return { ok: true, checked };
}
