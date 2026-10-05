/**
 * One real PostgreSQL 16 for the whole test run.
 *
 * The portal's store *is* Postgres — RLS policies, plpgsql functions, partitioned tables — so a
 * fake would test nothing that matters. Two ways to get one, in order:
 *
 *   1. `PORTAL_TEST_DATABASE_URL` — an instance that is already there (the compose service in
 *      `apps/portal/compose.yml`, or CI's).
 *   2. `embedded-postgres` — real PostgreSQL binaries, no Docker, started on an ephemeral port in
 *      a throwaway directory and thrown away at the end.
 *
 * Then it builds `portal_template`, applies every migration to it once, and hands the workers its
 * name. Each test file creates its own database `CREATE DATABASE … TEMPLATE portal_template`,
 * which is a file copy rather than a migration run — and, more importantly, means the cluster-wide
 * `CREATE ROLE` in `0001_extensions_and_roles.sql` happens exactly once instead of racing across
 * parallel workers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";
import { runMigrations } from "../src/store/postgres/migrate";

const TEMPLATE_DB = "portal_template";
const EMBEDDED_USER = "portal";
const EMBEDDED_PASSWORD = "portal";

interface Started {
  /** A DSN pointing at the server's maintenance database. */
  readonly adminUrl: string;
  stop(): Promise<void>;
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** How many of the server's last output chunks a failure report carries. */
const OUTPUT_TAIL_CHUNKS = 40;

/**
 * Why a start failure is reworded here. `embedded-postgres` rejects `start()` with NOTHING
 * (`reject()`, no argument) when the postgres process exits before it is ready, which is what
 * happens under a Windows administrator token ("Execution of PostgreSQL by a user with
 * administrative permissions is not permitted"). Vitest then prints "Unknown Error: undefined"
 * after a misleading "No test files found", and the postgres output that explains it is gone. A
 * real `Error` carrying the server's own output says what happened. (That it also makes the run
 * exit non-zero is `keepExitCode`'s doing, below, not this function's.)
 */
function startFailure(error: unknown, output: readonly string[]): Error {
  const tail = output.join("").trim();
  const elevated = /administrative permissions/i.test(tail);
  const detail =
    error instanceof Error
      ? error.message
      : error === undefined
        ? "the server exited before it was ready"
        : String(error);
  return new Error(
    [
      `The embedded PostgreSQL for the portal tests did not start: ${detail}.`,
      elevated
        ? "It refuses to run under an administrator token. Run the suite from a non-elevated shell " +
          '(`runas /trustlevel:0x20000 "cmd /c ..."`), or point PORTAL_TEST_DATABASE_URL at a running Postgres.'
        : "Run from a non-elevated shell, or point PORTAL_TEST_DATABASE_URL at a running Postgres.",
      tail === "" ? "(the server printed nothing)" : `Server output:\n${tail}`,
    ].join("\n"),
    { cause: error },
  );
}

/**
 * A port the OS says it can bind right now. Postgres will not take port 0, so ask a throwaway
 * listener for one and hand the number over. The earlier `55_000 + pid % 5_000` landed, about one
 * run in four on a Windows desk, inside the ranges Hyper-V / WinNAT reserve (58702-59882 on this
 * one), where the bind is refused with "Permission denied" and the run died before any test.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("the OS offered no free port"))));
    });
  });
}

/**
 * Keeps the run's exit code from being overwritten by `embedded-postgres`.
 *
 * Importing the library registers an `async-exit-hook`, whose `beforeExit` listener answers with
 * `process.exit(0)`. Vitest reports a red run (a failing test, a failing global setup) by setting
 * `process.exitCode = 1` and letting the process end, so with the hook in place every red run
 * ended in `process.exit(0)` and the command exited 0: a suite that failed, or never started,
 * looked like a pass to anything that reads the exit code (`pnpm ci:local`, a shell `&&`).
 *
 * The hook is kept, because it is what stops postgres on the way out (and removing only its
 * `beforeExit` listener makes its `exit` listener run first and crash with "done is not a
 * function"). These two listeners ride beside it: the first, registered BEFORE the import so that
 * it runs before the library's, records the exit code the process was about to end with; the
 * second puts it back once the hook's `process.exit(0)` has run (a listener of `exit` may set
 * `process.exitCode`, and `process.exit` reads it after the listeners have run). A green run
 * records nothing and still exits 0.
 */
let exitCodeKept = false;
function keepExitCode(): void {
  if (exitCodeKept) {
    return;
  }
  exitCodeKept = true;
  let wanted: number | undefined;
  process.on("beforeExit", () => {
    wanted = typeof process.exitCode === "number" ? process.exitCode : undefined;
  });
  process.on("exit", () => {
    if (wanted !== undefined && wanted !== 0) {
      process.exitCode = wanted;
    }
  });
}

async function importEmbedded(): Promise<typeof import("embedded-postgres").default> {
  keepExitCode();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  return EmbeddedPostgres;
}

async function startEmbedded(): Promise<Started> {
  const EmbeddedPostgres = await importEmbedded();
  const databaseDir = await mkdtemp(join(tmpdir(), "agentforge-portal-pg-"));
  const port = await freePort();

  // Kept rather than printed: a healthy start is quiet, and a failed one reports the tail.
  const output: string[] = [];
  const remember = (chunk: unknown): void => {
    output.push(String(chunk));
    if (output.length > OUTPUT_TAIL_CHUNKS) {
      output.shift();
    }
  };

  const server = new EmbeddedPostgres({
    databaseDir,
    user: EMBEDDED_USER,
    password: EMBEDDED_PASSWORD,
    port,
    persistent: false,
    onLog: remember,
    onError: remember,
  });
  try {
    await server.initialise();
    await server.start();
  } catch (error) {
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    throw startFailure(error, output);
  }

  return {
    adminUrl: `postgres://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      // Windows can hold the cluster's files for a moment after postgres exits (EBUSY on rmdir
      // under load); retry like the other suites' cleanup instead of failing a green run.
      await rm(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function start(): Promise<Started> {
  const provided = process.env.PORTAL_TEST_DATABASE_URL?.trim();
  if (provided) {
    return { adminUrl: provided, stop: async () => {} };
  }
  return startEmbedded();
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const server = await start();

  try {
    const admin = new pg.Client({ connectionString: server.adminUrl });
    await admin.connect();
    // A template left over from a killed run would be re-used with a stale schema.
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    await admin.end();

    const template = new pg.Pool({ connectionString: urlFor(server.adminUrl, TEMPLATE_DB) });
    const client = await template.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
      await template.end();
    }
  } catch (error) {
    // The server is already up, and nothing returned below will ever stop it: stop it here, then
    // let the failure fail the run.
    await server.stop().catch(() => undefined);
    throw error;
  }

  provide("portalTestDb", { adminUrl: server.adminUrl, template: TEMPLATE_DB });

  return async () => {
    const cleanup = new pg.Client({ connectionString: server.adminUrl });
    await cleanup.connect();
    const { rows } = await cleanup.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'portal_test_%' OR datname = $1`,
      [TEMPLATE_DB],
    );
    for (const row of rows) {
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [row.datname],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${row.datname}`);
    }
    await cleanup.end();
    await server.stop();
  };
}
