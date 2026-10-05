/**
 * Step 1 of the backup CronJob: a consistent SQLite snapshot, with the app still running.
 * Same method as webapp-deploy/scripts/backup.sh: `VACUUM INTO` through better-sqlite3 (the image has
 * no sqlite3 CLI), which reads one committed transaction and writes a compacted copy with no -wal of
 * its own. The copy lands at /stage/.backup-staging/agentforge.sqlite, the path restore.sh promotes.
 *
 * Runs in the APP image (the only one with better-sqlite3), as an init container, with the data
 * volume mounted read-write: a WAL-mode reader still needs to open the -shm file.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.AGENTFORGE_DATA_DIR || "/data";
const stageRoot = process.env.BACKUP_STAGE_DIR || "/stage";
const source = join(dataDir, "agentforge.sqlite");
const stage = join(stageRoot, ".backup-staging");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

if (!existsSync(source)) {
  console.log("snapshot: no agentforge.sqlite yet; the archive will hold the data dir only");
  process.exit(0);
}

// better-sqlite3 is a dependency of @agentforge/db, so it resolves from there, not from this file.
const requireFromDb = createRequire("/app/packages/db/package.json");
const Database = requireFromDb("better-sqlite3");
const db = new Database(source);
try {
  db.pragma("busy_timeout = 30000");
  db.prepare("VACUUM INTO ?").run(join(stage, "agentforge.sqlite"));
  console.log("snapshot: ok (VACUUM INTO)");
} finally {
  db.close();
}
