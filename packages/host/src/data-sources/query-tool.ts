/**
 * F1: `query_data_source` — the read-only SQL tool (NOT an extension of `run_sql`, which queries
 * the desk's own SQLite). The model picks a source by id and sends a SELECT; `runSourceQuery`
 * enforces the allowlist, the single-SELECT guard, `BEGIN READ ONLY`, timeout and row cap, and
 * returns columns+rows plus the SQL it ran so the answer can cite it (W1.2). `user_content`
 * trust: the result is attacker-reachable external text.
 */
import { defineTool, reportAuditEvent } from "@agentforge/core";
import { z } from "zod";
import { ApiError } from "@agentforge/core";
import { type DataSourceRow, getDataSource, listDataSources } from "./store";
import { runSourceQuery } from "./sql-query";

const schema = z
  .object({
    sourceId: z
      .string()
      .min(1)
      .describe("Data source id (ds-...) or exact source name as shown in Settings → Data Sources"),
    sql: z.string().min(1).max(10_000).describe("A single SELECT statement against an allowlisted table"),
  })
  .strict();

/**
 * The model never sees a source's id — Settings shows names only — so accept the unique source
 * name (case-insensitive) as well as the id, else `query_data_source` could never be aimed.
 */
function resolveSource(tenantId: string, idOrName: string): DataSourceRow {
  try {
    return getDataSource(tenantId, idOrName);
  } catch {
    // fall through to the name lookup
  }
  const matches = listDataSources(tenantId).filter((row) => row.name.toLowerCase() === idOrName.toLowerCase());
  if (matches.length === 1) {
    return matches[0]!;
  }
  throw new ApiError(
    "not_found",
    matches.length > 1 ? `More than one data source is named "${idOrName}"; ask for its id` : "Data source not found",
    404,
  );
}

export const dataSourceQueryTool = defineTool({
  key: "query_data_source",
  name: "Query a data source",
  description:
    "Run a read-only SELECT against an allowlisted table of a connected data source (PostgreSQL in W1). Returns the SQL that ran, the columns and rows; writes, multi-statements and off-allowlist tables are refused.",
  schema,
  trust: "user_content",
  execute: async (args, tenant) => {
    const parsed = schema.parse(args);
    const row = resolveSource(tenant.tenantId, parsed.sourceId);
    try {
      const result = await runSourceQuery(row, parsed.sql);
      reportAuditEvent({
        tenantId: tenant.tenantId,
        event: "data_source.access",
        actorKind: "system",
        agentId: tenant.workspaceId,
        targetKind: "data_source",
        targetId: row.id,
        outcome: "ok",
        itemCount: result.rowCount,
        rule: "query",
      });
      return {
        source: { id: row.id, name: row.name, kind: row.kind },
        sql: parsed.sql,
        ...result,
      };
    } catch (error) {
      reportAuditEvent({
        tenantId: tenant.tenantId,
        event: "data_source.access",
        actorKind: "system",
        agentId: tenant.workspaceId,
        targetKind: "data_source",
        targetId: row.id,
        outcome: error instanceof ApiError && error.status === 403 ? "denied" : "failed",
        rule: error instanceof ApiError ? error.code : "query_failed",
      });
      throw error;
    }
  },
});
