/**
 * F1: the PostgreSQL connector — read-only, through the destination allowlist and resolve-and-pin.
 *
 * `pg` (a dependency Rizky already ships in `apps/portal`) connects with the addresses
 * `resolvePinnedDestination` verified: `host` gets the first pinned address so the TCP peer is the
 * one we checked, and `servername` keeps TLS verification on the configured name — a DNS answer
 * that changes after our check cannot redirect the socket.
 *
 * Read-only is enforced three ways, all in this file's caller (`runSourceQuery`): the
 * `assertReadOnlySelect` text guard, `BEGIN READ ONLY`, and a server-side `statement_timeout`
 * plus a row cap, so a query that writes or runs away fails closed.
 */
import { Client } from "pg";
import { ApiError, resolvePinnedDestination } from "@agentforge/core";
import type { DataSourceRow } from "./store";
import { openSourceConfig, openSourceSecret } from "./store";
import type { SourceQueryResult } from "./sql-query";

export type PgConfig = { kind: "postgres"; host: string; port: number; database: string; user: string };
type PgSecret = { secret: string };

export function pgConfig(row: DataSourceRow): PgConfig {
  return openSourceConfig<PgConfig>(row);
}

async function connect(row: DataSourceRow): Promise<Client> {
  const config = pgConfig(row);
  const secret = openSourceSecret<PgSecret>(row);
  const pinned = await resolvePinnedDestination(config.host, config.port, { tenantId: row.tenant_id });
  const client = new Client({
    host: pinned.address,
    port: config.port,
    database: config.database,
    user: config.user,
    password: secret.secret,
    ssl: { servername: config.host, rejectUnauthorized: true },
    connectionTimeoutMillis: 5_000,
  });
  await client.connect().catch((error) => {
    // Credentials or TLS refused: the message names the class, never the password or host detail.
    throw new ApiError(
      "source_auth_failed",
      `PostgreSQL connect failed: ${error instanceof Error ? error.message.split("\n")[0] : "refused"}`,
      400,
    );
  });
  return client;
}

/** The test-connection round-trip: connect, `SELECT 1`, close. Credentials never leave the error. */
export async function testPostgres(row: DataSourceRow): Promise<void> {
  const client = await connect(row);
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * A pre-checked SELECT (already through `assertReadOnlySelect` and the table allowlist in
 * `sql-query.ts`) inside `BEGIN READ ONLY` with `statement_timeout` — the SQL the model sent
 * is shown back to the caller so the answer can cite exactly what ran.
 */
export async function runPostgresSelect(
  row: DataSourceRow,
  checked: string,
  limits: { sqlMaxRows: number; sqlTimeoutMs: number },
): Promise<SourceQueryResult> {
  const client = await connect(row);
  try {
    await client.query("BEGIN READ ONLY");
    try {
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(limits.sqlTimeoutMs)}`);
      const result = await client.query({ text: checked, rowMode: "array" });
      const rows = result.rows as unknown[][];
      return {
        columns: result.fields.map((f) => f.name),
        rows: rows.slice(0, limits.sqlMaxRows),
        // The same contract MySQL can honor: rows in this response, never a total it cannot
        // know without buffering the whole result. `truncated` says more rows matched.
        rowCount: Math.min(rows.length, limits.sqlMaxRows),
        truncated: rows.length > limits.sqlMaxRows,
      };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
