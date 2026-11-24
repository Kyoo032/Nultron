import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-db-client-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.DATABASE_URL;

const { checkpointWalTruncate, sql } = await import("./client");
const { sqliteFilePath } = await import("./vault-key");

afterAll(() => {
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function readDbAndWalBytes(): { db: Buffer; wal: Buffer } {
  const dbPath = sqliteFilePath();
  const walPath = `${dbPath}-wal`;
  return {
    db: readFileSync(dbPath),
    wal: existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0),
  };
}

describe("SQLite client pragmas", () => {
  it("opens the database with secure_delete, journal_size_limit, and FTS5 secure-delete enabled", () => {
    expect(sql.pragma("secure_delete", { simple: true })).toBe(1);
    expect(sql.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(String(sql.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(sql.pragma("journal_size_limit", { simple: true })).toBe(16_777_216);

    const ftsConfig = sql
      .prepare("SELECT v FROM knowledge_chunks_config WHERE k = 'secure-delete'")
      .get() as { v: number } | undefined;
    expect(ftsConfig?.v).toBe(1);
  });

  it("zeroes deleted row bytes on disk after DELETE and WAL truncate checkpoint", () => {
    const marker = "SQLITE-SECURE-DELETE-ZEROED-99412";
    const rowId = `mem-${crypto.randomUUID()}`;
    const now = Date.now();
    sql
      .prepare("INSERT INTO knowledge_memories (id, workspace_id, text, pinned, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(rowId, "ws-secure-delete", marker, now);
    checkpointWalTruncate();

    expect(readDbAndWalBytes().db.includes(Buffer.from(marker, "utf8"))).toBe(true);

    sql.prepare("DELETE FROM knowledge_memories WHERE id = ?").run(rowId);
    checkpointWalTruncate();

    const after = readDbAndWalBytes();
    expect(after.db.includes(Buffer.from(marker, "utf8"))).toBe(false);
    expect(after.wal.includes(Buffer.from(marker, "utf8"))).toBe(false);
  });

  it("scrubs deleted FTS5 knowledge_chunks tokens from both .sqlite and .sqlite-wal", () => {
    // Lowercase single token so we verify the FTS5 inverted index segments (which store lowercased
    // tokens), not only the verbatim content shadow table.
    const marker = "xylophonequarryfts5marker99412";
    const sourceId = `src-${crypto.randomUUID()}`;
    sql
      .prepare("INSERT INTO knowledge_chunks (source_id, workspace_id, body) VALUES (?, ?, ?)")
      .run(sourceId, "ws-fts-secure", `Passage containing ${marker} in FTS5 index.`);
    checkpointWalTruncate();

    expect(readDbAndWalBytes().db.includes(Buffer.from(marker, "utf8"))).toBe(true);

    sql.prepare("DELETE FROM knowledge_chunks WHERE source_id = ?").run(sourceId);
    checkpointWalTruncate();

    const after = readDbAndWalBytes();
    expect(after.db.includes(Buffer.from(marker, "utf8"))).toBe(false);
    expect(after.wal.includes(Buffer.from(marker, "utf8"))).toBe(false);
  });
});
