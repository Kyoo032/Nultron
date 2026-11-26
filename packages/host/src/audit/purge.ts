import type Database from "better-sqlite3";
import type { AuditRow } from "./store";

/**
 * Retention purge (F2). Deletes are only possible because the migration's trigger admits them
 * while `seq <= audit_purge_window.max_seq`; this function raises that window inside the same
 * transaction that records the checkpoint, so the order is always: checkpoint written → window
 * raised → rows deleted. A crash anywhere in between leaves the chain consistent, never a gap
 * with no checkpoint to verify from.
 *
 * The checkpoint stores the hash of the LAST row being deleted, so `verifyAuditChain` can anchor
 * the surviving tail's first `prev_hash` even though the row it pointed at is gone.
 */
export function purgeAuditEvents(db: Database.Database, maxSeq: number): { purged: number } {
  return db.transaction((): { purged: number } => {
    const tail = db
      .prepare("SELECT seq, row_hash, at FROM audit_events WHERE seq <= ? ORDER BY seq DESC LIMIT 1")
      .get(maxSeq) as Pick<AuditRow, "seq" | "row_hash" | "at"> | undefined;
    if (!tail) {
      return { purged: 0 };
    }
    db.prepare("INSERT OR REPLACE INTO audit_checkpoints (seq, row_hash, at) VALUES (?, ?, ?)").run(
      tail.seq,
      tail.row_hash,
      Date.now(),
    );
    db.prepare(
      "INSERT INTO audit_purge_window (id, max_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_seq = excluded.max_seq",
    ).run(tail.seq);
    const result = db.prepare("DELETE FROM audit_events WHERE seq <= ?").run(tail.seq);
    return { purged: result.changes };
  })();
}

/** Rows older than `retentionDays` go. The number itself is Rizky's decision (section 6), read from env by the caller. */
export function purgeAuditByAge(db: Database.Database, retentionDays: number, now = Date.now()): { purged: number } {
  const cutoff = now - retentionDays * 86_400_000;
  // Only the contiguous expired prefix may go. `at` is client-controlled — a row written with a
  // backdated timestamp at a high seq must not pull still-valid rows below it into the delete.
  const kept = db.prepare("SELECT MIN(seq) AS seq FROM audit_events WHERE at > ?").get(cutoff) as
    | { seq: number | null }
    | undefined;
  const maxSeq =
    kept?.seq != null
      ? kept.seq - 1
      : (db.prepare("SELECT MAX(seq) AS seq FROM audit_events").get() as { seq: number | null } | undefined)?.seq;
  if (maxSeq == null || maxSeq < 1) {
    return { purged: 0 };
  }
  return purgeAuditEvents(db, maxSeq);
}
