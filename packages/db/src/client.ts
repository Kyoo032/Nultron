import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import SqliteDatabase, { type Database as SqliteConnection } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "./ensure-schema";
import { applyPendingDataReset, resetOutcomeSummary } from "./reset";
import * as schema from "./schema";
import { localDataDir, sqliteFilePath } from "./vault-key";

config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), "../../.env.local") });
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local") });

const file = sqliteFilePath();
mkdirSync(dirname(file), { recursive: true });

const globalForDb = globalThis as unknown as {
  sqlite?: SqliteConnection;
};

/**
 * A queued "Start over" wipe runs here, on the boot after the owner asked for it: the database is
 * opened below, so this is the last moment nothing holds a handle on the files.
 *
 * Deliberately gated on `AGENTFORGE_APPLY_PENDING_RESET=1` rather than running on import. Importing
 * this module must never delete anybody's data as a side effect — a test, a migration script or a
 * tool that only wanted `db` would otherwise apply a wipe the owner queued for the *app*. The two
 * processes that are allowed to do it set the variable before `@agentforge/host` is loaded:
 * `apps/web/server-env.ts` (webdev) and `bootstrapPackaged()` in the Electron shell.
 *
 * Skipped when a connection is already cached, because that process already booted past this point.
 *
 * The outcome is logged as counts only (see `resetOutcomeSummary`): the entries include the key
 * file, and a database kept outside the data dir is reported by its absolute path.
 */
if (process.env.AGENTFORGE_APPLY_PENDING_RESET === "1" && !globalForDb.sqlite) {
  const outcome = applyPendingDataReset(localDataDir());
  const summary = resetOutcomeSummary(outcome);
  if (summary && outcome.failed.length > 0) {
    console.warn(summary);
  } else if (summary) {
    console.info(summary);
  }
}

export const sql: SqliteConnection = globalForDb.sqlite ?? new SqliteDatabase(file);
if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sql;
}

sql.pragma("journal_mode = WAL");
sql.pragma("foreign_keys = ON");
// Overwrite deleted pages with zeros so removed rows do not linger in free pages on disk.
sql.pragma("secure_delete = ON");
// Bound WAL file retention after checkpoints so historical frames do not linger unbounded on disk.
sql.pragma("journal_size_limit = 16777216");
// WAL gives concurrent readers with one writer, but without this a second writer gets
// SQLITE_BUSY immediately instead of waiting. 5 s is the Phase 3 database-engine change
// (docs/internal/web-phase3-tenancy-spec.md §3b); a SQLITE_BUSY still reaching a client
// after it is the trigger for revisiting the engine choice.
sql.pragma("busy_timeout = 5000");
ensureSchema(sql);

/**
 * Best-effort WAL truncate checkpoint after deleting sensitive rows so removed frames do not
 * linger in the `-wal` file on disk. Never throws: a busy concurrent reader or non-WAL handle
 * must never fail a delete.
 */
export function checkpointWalTruncate(connection: SqliteConnection = sql): void {
  try {
    connection.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Best-effort: busy readers leave frames for the next checkpoint rather than failing delete.
  }
}

export const db = drizzle(sql, { schema });
export type Database = typeof db;
