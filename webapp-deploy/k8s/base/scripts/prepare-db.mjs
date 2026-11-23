/**
 * The portal pod's init step: wait for Postgres, migrate as the schema owner, then give
 * `portal_app_login` its password. Runs in the portal image, before the portal container starts.
 *
 * WHY IT IS A SEPARATE STEP. In production the portal refuses to serve as anything that can see past
 * a row-level-security policy (apps/portal/src/boot.ts), so its server DSN is `portal_app_login`, a
 * plain member of `portal_app`. That role is created by migration 0010 WITHOUT a password
 * (0001_extensions_and_roles.sql keeps login passwords out of migration files, and the portal never
 * sets it in production). Something has to migrate first and set the password second, or the
 * portal's first query is refused. This is that something.
 *
 * The password goes to the server as a SCRAM-SHA-256 verifier, which is what psql's \password sends:
 * the plaintext never reaches the server's statement log. It runs on every pod start, so rotating
 * PORTAL_APP_DB_PASSWORD is "update the Secret, restart the portal".
 *
 * Env: PORTAL_MIGRATE_DATABASE_URL (the schema owner), PORTAL_APP_DB_PASSWORD, plus everything the
 * portal's own loadConfig reads, because migrate.ts validates the whole production configuration.
 */
import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_LOGIN_ROLE = "portal_app_login";
const SCRAM_ITERATIONS = 4096;
const PORTAL_DIR = process.env.PORTAL_APP_DIR || "/app/apps/portal";
const WAIT_SECONDS = Number(process.env.PREPARE_DB_WAIT_SECONDS || 180);

/** RFC 5802 / PostgreSQL `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`. ASCII passwords only. */
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** A SQL string literal. The verifier is base64 and `$:` only; the quote doubling is belt and braces. */
export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWhenReady(Client, url) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      await sleep(2000);
    }
  }
  throw new Error(`postgres did not accept a connection within ${WAIT_SECONDS}s (${lastError})`);
}

function migrate() {
  const result = spawnSync("node", ["dist/scripts/migrate.mjs"], { cwd: PORTAL_DIR, stdio: "inherit" });
  if (result.error) throw new Error(`could not start the migration: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`migration exited ${result.status}`);
}

async function main() {
  const ownerUrl = process.env.PORTAL_MIGRATE_DATABASE_URL;
  const password = process.env.PORTAL_APP_DB_PASSWORD;
  if (!ownerUrl) throw new Error("PORTAL_MIGRATE_DATABASE_URL is not set");
  if (!password) throw new Error("PORTAL_APP_DB_PASSWORD is not set");
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("PORTAL_APP_DB_PASSWORD must be printable ASCII (SASLprep is not applied here)");

  const { Client } = createRequire(`${PORTAL_DIR}/package.json`)("pg");
  const waiting = await connectWhenReady(Client, ownerUrl);
  await waiting.end();
  console.log("prepare-db: postgres is up; migrating as the schema owner");
  migrate();

  const client = await connectWhenReady(Client, ownerUrl);
  try {
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_LOGIN_ROLE]);
    if (role.rowCount !== 1) {
      throw new Error(`role ${APP_LOGIN_ROLE} does not exist after the migrations (0010_app_login_role.sql)`);
    }
    await client.query(`ALTER ROLE ${APP_LOGIN_ROLE} PASSWORD ${sqlLiteral(scramVerifier(password))}`);
    console.log(`prepare-db: ${APP_LOGIN_ROLE} password set from the Secret (SCRAM verifier, plaintext not sent)`);
  } finally {
    await client.end();
  }
}

// Run only when executed, not when imported by the test. A ConfigMap volume mounts this file as a
// symbolic link, and Node reports import.meta.url as the REAL path, so comparing it to argv[1] as given
// is false there and the script would exit 0 having done nothing. Resolve argv[1] first.
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    console.error(`prepare-db failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
