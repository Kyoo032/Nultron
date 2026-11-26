import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { listAuditEvents, type AuditEventFilter, type AuditRow } from "./store";

export type AuditExport = {
  /** The export file's bytes: CSV or JSONL, row order newest-first like the API view. */
  content: string;
  /** SHA-256 of `content` exactly as sent — the manifest the file can be proven against (AC-2.5). */
  manifest: { algorithm: "sha256"; fileSha256: string; rows: number; format: "csv" | "jsonl" };
};

const COLUMNS = [
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

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The whole filtered result as one downloadable file plus its manifest. No pagination on export —
 * an auditor's file is the answer, not a window onto it — but the same filters and the same
 * metadata columns as the read view; the spec has no export of anything else.
 */
export function exportAuditEvents(
  db: Database.Database,
  filter: Omit<AuditEventFilter, "cursor" | "limit">,
  format: "csv" | "jsonl",
): AuditExport {
  const rows = listAuditEvents(db, { ...filter, limit: 500_000 });
  const content =
    format === "csv"
      ? [COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => csvCell(row[column])).join(","))].join("\n") +
        "\n"
      : rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  return {
    content,
    manifest: {
      algorithm: "sha256",
      fileSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      rows: rows.length,
      format,
    },
  };
}
