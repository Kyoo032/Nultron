import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";

function insert(sqlite: Database.Database, port: number, allowPrivate = 0) {
  sqlite
    .prepare(
      `INSERT INTO destination_allowlist (id, tenant_id, host, port, allow_private, mac, created_at)
       VALUES (?, 't1', 'db.example.com', ?, ?, ?, 1)`,
    )
    .run(`row-${port}`, port, allowPrivate, "f".repeat(64));
}

describe("0028_destination_allowlist", () => {
  it("applies on a fresh database and enforces the port range and flag CHECKs", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      insert(sqlite, 5432, 1);
      expect(() => insert(sqlite, 0)).toThrow(/CHECK/i);
      expect(() => insert(sqlite, 65536)).toThrow(/CHECK/i);
      expect(() => insert(sqlite, 443, 7)).toThrow(/CHECK/i);
      const row = sqlite
        .prepare("SELECT host, port, allow_private FROM destination_allowlist WHERE host = 'db.example.com'")
        .get() as { host: string; port: number; allow_private: number };
      expect(row).toEqual({ host: "db.example.com", port: 5432, allow_private: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("re-creates the table on a database stamped past 0028 without it", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      sqlite.exec("DROP TABLE destination_allowlist");
      ensureSchema(sqlite);
      insert(sqlite, 443);
      expect(sqlite.prepare("SELECT count(*) AS n FROM destination_allowlist").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });
});
