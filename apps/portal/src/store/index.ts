/**
 * The store's front door.
 *
 * There is one driver. `PORTAL_DATABASE_URL` is validated as a Postgres DSN in `../config.ts`, so
 * by the time anything reaches here the question "which backend?" has already been answered.
 *
 * Two doors, one per role. `openStore` is the server's connection (`PORTAL_DATABASE_URL`, a plain
 * member of `portal_app`), and everything that serves a request goes through it.
 * `openMigrationStore` is the schema owner's (`PORTAL_MIGRATE_DATABASE_URL`), for `migrate()` and
 * nothing else. `src/boot.ts` opens it, migrates and closes it before anything listens.
 */
import type { PortalConfig } from "../config";
import type { Logger } from "../log";
import { openPostgresStore } from "./postgres";
import type { Clock, PortalStore } from "./types";

export { openPostgresStore } from "./postgres";
export * from "./types";

export function openStore(config: PortalConfig, clock?: Clock, log?: Logger): PortalStore {
  return openPostgresStore({
    databaseUrl: config.databaseUrl,
    clock,
    // The SQLSTATE only (57P01 a terminated session, 57P02 and 57P03 a server going down or not up yet); the
    // message can name the database and the role.
    onIdleClientError: log
      ? (error) => log.warn("portal_db_idle_connection_lost", { code: sqlState(error) })
      : undefined,
  });
}

function sqlState(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}

/** The schema owner's connection. One connection is all a migration run uses. */
export function openMigrationStore(config: PortalConfig): PortalStore {
  return openPostgresStore({ databaseUrl: config.migrateDatabaseUrl, maxConnections: 1 });
}
