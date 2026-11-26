/**
 * F1: the MySQL connector — read-only, through the destination allowlist and resolve-and-pin,
 * like `postgres.ts`. `mysql2` ships under Rizky's S5 approval (2026-11-26).
 *
 * The socket goes to the address `resolvePinnedDestination` verified, with TLS `servername`
 * kept on the configured host, so a DNS answer that changes after our check cannot redirect
 * the socket. Read-only is enforced three ways in `runMysqlSelect`'s caller (`runSourceQuery`):
 * the `assertReadOnlySelect` text guard, `START TRANSACTION READ ONLY`, and mysql2's per-query
 * `timeout` plus the row cap — a query that writes or runs away fails closed.
 */
import net from "node:net";
import { createConnection, type Connection } from "mysql2/promise";
import { ApiError, resolvePinnedDestination } from "@agentforge/core";
import type { DataSourceRow } from "./store";
import { openSourceConfig, openSourceSecret } from "./store";
import type { SourceQueryResult } from "./sql-query";

export type MysqlConfig = { kind: "mysql"; host: string; port: number; database: string; user: string };
type MysqlSecret = { secret: string };

export function mysqlConfig(row: DataSourceRow): MysqlConfig {
  return openSourceConfig<MysqlConfig>(row);
}

async function connect(row: DataSourceRow): Promise<Connection> {
  const config = mysqlConfig(row);
  const secret = openSourceSecret<MysqlSecret>(row);
  const pinned = await resolvePinnedDestination(config.host, config.port, { tenantId: row.tenant_id });
  const client = await createConnection({
    // `config.host` stays the real name so mysql2 computes TLS `servername` and verifies the
    // certificate identity against it; the `stream` override pins the socket itself to the
    // address the destination allowlist approved, so a DNS answer that changes after our
    // check cannot redirect the connection.
    host: config.host,
    port: config.port,
    stream: () => net.connect({ host: pinned.address, port: config.port }),
    database: config.database,
    user: config.user,
    password: secret.secret,
    ssl: { rejectUnauthorized: true, verifyIdentity: true },
    connectTimeout: 5_000,
    // A BIGINT past Number.MAX_SAFE_INTEGER reaches the agent as a string, not a silently
    // rounded float — the row cap and LIMIT math are unaffected (they never touch values).
    bigNumberStrings: true,
    supportBigNumbers: true,
  }).catch((error: unknown) => {
    // Credentials or TLS refused: the message names the class, never the password or host detail.
    throw new ApiError(
      "source_auth_failed",
      `MySQL connect failed: ${error instanceof Error ? error.message.split("\n")[0] : "refused"}`,
      400,
    );
  });
  return client;
}

/** The test-connection round-trip: connect, `SELECT 1`, close. Credentials never leave the error. */
export async function testMysql(row: DataSourceRow): Promise<void> {
  const client = await connect(row);
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * A pre-checked SELECT (already through `assertReadOnlySelect` and the table allowlist in
 * `sql-query.ts`) inside `START TRANSACTION READ ONLY`, with the query-level `timeout` mysql2
 * enforces server-side and the runner's row cap applied to what comes back.
 */
export async function runMysqlSelect(
  row: DataSourceRow,
  checked: string,
  limits: { sqlMaxRows: number; sqlTimeoutMs: number },
): Promise<SourceQueryResult> {
  const client = await connect(row);
  try {
    await client.query("START TRANSACTION READ ONLY");
    // The derived-table `LIMIT max+1` caps what the server can return — no unbounded buffering
    // — and the extra row is what marks `truncated`. `checked` keeps its own ORDER BY/LIMIT.
    const [rows, fields] = await client.query({
      sql: `SELECT * FROM (${checked}) AS __agentforge_q LIMIT ${limits.sqlMaxRows + 1}`,
      rowsAsArray: true,
      timeout: Math.floor(limits.sqlTimeoutMs),
    });
    await client.query("ROLLBACK").catch(() => undefined);
    const result = rows as unknown[][];
    const truncated = result.length > limits.sqlMaxRows;
    return {
      columns: (fields as Array<{ name: string }>).map((f) => f.name),
      rows: result.slice(0, limits.sqlMaxRows),
      rowCount: Math.min(result.length, limits.sqlMaxRows),
      truncated,
    };
  } catch (error) {
    // mysql2's query `timeout` rejects the promise while the statement keeps running on the
    // server; only dying with the socket stops it, and a dead connection rolls its own read-only
    // transaction back — so no `ROLLBACK` waits behind the runaway.
    client.destroy();
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
