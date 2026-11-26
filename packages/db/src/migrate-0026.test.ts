import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const migration = readFileSync(`${migrationsFolder()}/0026_audit_events.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function insert(sqlite: Database.Database, seq: number, id: string, tenantId = "t1") {
  sqlite
    .prepare(
      `INSERT INTO audit_events
       (seq, id, tenant_id, at, actor_kind, actor_id, agent_id, event, target_kind, target_id,
        outcome, duration_ms, item_count, ref_hash, channel, rule, prev_hash, row_hash)
       VALUES (?, ?, ?, 1, 'user', 'u1', NULL, 'tool.call', 'tool', 'web_search',
               'ok', 12, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(seq, id, tenantId, HASH, HASH);
}

describe("0026_audit_events", () => {
  it("follows every existing migration in the forward-only journal", () => {
    const entry = journal.entries.at(-1)!;
    expect(entry.tag).toBe("0026_audit_events");
    for (const previous of journal.entries.slice(0, -1)) expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("applies on a fresh database and enforces append-only plus checkpointed delete", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      expect(
        sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get(),
      ).toEqual({ created_at: journal.entries.at(-1)!.when });

      insert(sqlite, 1, "evt-1");
      insert(sqlite, 2, "evt-2");
      // The id is unique; nothing reuses it even after a purge.
      expect(() => insert(sqlite, 3, "evt-1")).toThrow(/UNIQUE/i);
      // No update, ever.
      expect(() => sqlite.prepare("UPDATE audit_events SET event = 'x' WHERE seq = 1").run()).toThrow(/immutab|audit/i);
      // No delete while the purge window does not cover the row.
      expect(() => sqlite.prepare("DELETE FROM audit_events WHERE seq = 1").run()).toThrow();
      sqlite.prepare("INSERT INTO audit_checkpoints (seq, row_hash, at) VALUES (1, ?, 1)").run(OTHER_HASH);
      sqlite.prepare("UPDATE audit_purge_window SET max_seq = 1 WHERE id = 1").run();
      expect(sqlite.prepare("DELETE FROM audit_events WHERE seq = 1").run().changes).toBe(1);
      // seq 2 is still outside the window.
      expect(() => sqlite.prepare("DELETE FROM audit_events WHERE seq = 2").run()).toThrow();
      // Unknown actor kind / outcome are refused by the CHECKs.
      expect(() => sqlite.prepare("UPDATE audit_purge_window SET max_seq = 3").run()).not.toThrow();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO audit_events (seq, id, tenant_id, at, actor_kind, event, prev_hash, row_hash)
             VALUES (4, 'evt-4', 't1', 1, 'intruder', 'x', ?, ?)`,
          )
          .run(HASH, HASH),
      ).toThrow(/CHECK/i);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO audit_events (seq, id, tenant_id, at, actor_kind, event, outcome, prev_hash, row_hash)
             VALUES (4, 'evt-4', 't1', 1, 'user', 'x', 'sort-of-ok', ?, ?)`,
          )
          .run(HASH, HASH),
      ).toThrow(/CHECK/i);
    } finally {
      sqlite.close();
    }
  });
});
