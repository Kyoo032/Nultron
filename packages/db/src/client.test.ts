import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-db-client-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.DATABASE_URL;

const { sql } = await import("./client");
const { sqliteFilePath } = await import("./vault-key");

afterAll(() => {
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("SQLite client pragmas", () => {
  it("opens the database with secure_delete enabled", () => {
    expect(sql.pragma("secure_delete", { simple: true })).toBe(1);
    expect(sql.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(String(sql.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
  });

  it("zeroes deleted row bytes on disk after DELETE and WAL truncate checkpoint", () => {
    const marker = "SQLITE-SECURE-DELETE-ZEROED-99412";
    const rowId = `mem-${crypto.randomUUID()}`;
    const now = Date.now();
    sql
      .prepare("INSERT INTO knowledge_memories (id, workspace_id, text, pinned, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(rowId, "ws-secure-delete", marker, now);
    sql.pragma("wal_checkpoint(TRUNCATE)");

    expect(readFileSync(sqliteFilePath()).includes(Buffer.from(marker, "utf8"))).toBe(true);

    sql.prepare("DELETE FROM knowledge_memories WHERE id = ?").run(rowId);
    sql.pragma("wal_checkpoint(TRUNCATE)");

    expect(readFileSync(sqliteFilePath()).includes(Buffer.from(marker, "utf8"))).toBe(false);
  });
});
