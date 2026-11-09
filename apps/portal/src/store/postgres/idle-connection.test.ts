/**
 * Postgres ends a connection that sits idle in the pool: a restart, a failover, `idle_session_timeout`, an
 * operator's `pg_terminate_backend`. pg-pool reports that as an `error` event on the pool, and an `error` event
 * nobody listens to is thrown, which the portal's process guard turns into an exit. The store has to absorb it
 * and keep serving on a new connection.
 */
import pg from "pg";
import { afterEach, expect, inject, it } from "vitest";
import { appRoleUrl, createTestDatabase, type TestDatabase } from "../../testing/pg";
import { openPostgresStore } from "./index";
import type { PortalStore } from "../types";

let database: TestDatabase | undefined;
let store: PortalStore | undefined;

afterEach(async () => {
  await store?.close();
  await database?.drop();
  store = undefined;
  database = undefined;
});

/** Ends every session on the database except the admin's own, as `pg_terminate_backend` does on a server. */
async function terminateSessions(name: string): Promise<number> {
  const admin = new pg.Client({ connectionString: inject("portalTestDb").adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    return rows.length;
  } finally {
    await admin.end();
  }
}

it("reports a connection Postgres ended while idle, and serves the next query on a new one", async () => {
  database = await createTestDatabase();
  const reported: Error[] = [];
  let heard!: () => void;
  const lost = new Promise<void>((resolve) => {
    heard = resolve;
  });
  store = openPostgresStore({
    databaseUrl: await appRoleUrl(database),
    onIdleClientError: (error) => {
      reported.push(error);
      heard();
    },
  });

  expect((await store.connectionRole()).name).toBe("portal_app_test");
  expect(await terminateSessions(database.name)).toBe(1);
  await lost;

  expect((reported[0] as { code?: string }).code).toBe("57P01");
  expect((await store.connectionRole()).name).toBe("portal_app_test");
});

it("does not throw the error when nobody asked to hear about it", async () => {
  database = await createTestDatabase();
  store = openPostgresStore({ databaseUrl: await appRoleUrl(database) });

  await store.connectionRole();
  expect(await terminateSessions(database.name)).toBe(1);
  // Long enough for the FATAL to reach the idle client. Before the store listened, the pool's `error` event was
  // thrown here and vitest failed the run with an unhandled error.
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect((await store.connectionRole()).name).toBe("portal_app_test");
});
