/**
 * F1: `runSourceQuery` — the shared door every SQL connector's SELECT goes through.
 *
 * It does the checks both dialects share once: the row must be active, `assertReadOnlySelect`
 * vets the text (single SELECT, no write/lock/session words, no server-side read functions),
 * and every table the statement reads must be on the source's sealed allowlist — which fails
 * closed while the operator has named no table. The dialect runners (`postgres.ts`,
 * `mysql.ts`) get the already-checked text and only wrap it in their read-only transaction
 * and timeout.
 */
import { ApiError } from "@agentforge/core";
import type { DataSourceRow } from "./store";
import { openTableAllowlist } from "./store";
import { assertReadOnlySelect, dataSourceLimits } from "./sql-guard";
import { runPostgresSelect } from "./postgres";
import { runMysqlSelect } from "./mysql";

export type SourceQueryResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
};

function checkedSelect(row: DataSourceRow, sqlText: string): string {
  const checked = assertReadOnlySelect(sqlText);
  const allowlist = openTableAllowlist(row).map((t) => t.toLowerCase());
  if (allowlist.length === 0) {
    // No table is open until the operator names one — the query surface fails closed.
    throw new ApiError("table_not_allowed", "This source has no allowlisted tables", 403);
  }
  // Every table the statement reads must be on the list: pull the identifiers after FROM/JOIN
  // (string literals were already stripped by the guard's tokenizer rules — its output text is
  // what we checked, and this regex runs on the same checked text). Each part may be bare,
  // double-quoted (Postgres) or backtick-quoted (MySQL) — missing the quoting style here is how
  // a backticked table would otherwise extract no reference at all and walk past the allowlist,
  // so the quotes are part of the pattern and stripped before the compare (SR-223).
  const allowed = new Set(allowlist);
  const part = '(?:"[^"]+"|`[^`]+`|[a-zA-Z0-9_]+)';
  const tableRefs = [...checked.matchAll(new RegExp(String.raw`\b(?:from|join)\s+(${part}(?:\.${part})?)`, "gi"))].map(
    (m) => m[1]!.replace(/["`]/g, "").toLowerCase(),
  );
  for (const ref of tableRefs) {
    const bare = ref.split(".").pop()!;
    if (!allowed.has(ref) && !allowed.has(bare)) {
      throw new ApiError("table_not_allowed", `Table "${ref}" is not on this source's allowlist`, 403);
    }
  }
  return checked;
}

/**
 * A query against one SQL source: the shared guard + allowlist above, then the connector's
 * read-only transaction with a server-side timeout and row cap. The SQL the model sent is
 * shown back to the caller so the answer can cite exactly what ran.
 */
export async function runSourceQuery(row: DataSourceRow, sqlText: string): Promise<SourceQueryResult> {
  if (row.status !== "active") {
    throw new ApiError("invalid_request", "Data source is disabled", 400);
  }
  const checked = checkedSelect(row, sqlText);
  const limits = dataSourceLimits();
  switch (row.kind) {
    case "postgres":
      return runPostgresSelect(row, checked, limits);
    case "mysql":
      return runMysqlSelect(row, checked, limits);
    default:
      throw new ApiError("invalid_request", "Only postgres and mysql sources answer SQL in W1", 400);
  }
}
