import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

const entry = journal.entries.find((item) => item.tag === "0027_data_sources")!;

function insertSource(sqlite: Database.Database, id: string, kind = "s3", status = "active") {
  sqlite
    .prepare(
      `INSERT INTO data_sources
       (id, tenant_id, kind, name, config_sealed, secret_sealed, status, created_at, updated_at)
       VALUES (?, 't1', ?, 'src', '{}', '{}', ?, 1, 1)`,
    )
    .run(id, kind, status);
}

describe("0027_data_sources", () => {
  it("follows 0026 in the forward-only journal", () => {
    const audit = journal.entries.find((item) => item.tag === "0026_audit_events")!;
    const allowlist = journal.entries.find((item) => item.tag === "0028_destination_allowlist")!;
    expect(entry.when).toBeGreaterThan(audit.when);
    expect(allowlist.when).toBeGreaterThan(entry.when);
  });

  it("applies on a fresh database and enforces kind and status CHECKs", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      insertSource(sqlite, "ds-1", "s3");
      insertSource(sqlite, "ds-2", "postgres");
      expect(() => insertSource(sqlite, "ds-3", "ftp")).toThrow(/CHECK/i);
      expect(() => insertSource(sqlite, "ds-4", "s3", "broken")).toThrow(/CHECK/i);
      sqlite
        .prepare(
          `INSERT INTO data_source_sync_runs (id, tenant_id, data_source_id, started_at, files_ok, files_failed)
           VALUES ('run-1', 't1', 'ds-1', 1, 3, 0)`,
        )
        .run();
      const row = sqlite
        .prepare("SELECT files_ok AS ok, error_code AS code FROM data_source_sync_runs WHERE id = 'run-1'")
        .get() as { ok: number; code: string | null };
      expect(row).toEqual({ ok: 3, code: null });
    } finally {
      sqlite.close();
    }
  });

  it("re-creates the tables on a database stamped past 0027 without them", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      sqlite.exec("DROP TABLE data_source_sync_runs; DROP TABLE data_sources");
      ensureSchema(sqlite);
      insertSource(sqlite, "ds-healed");
      expect(sqlite.prepare("SELECT count(*) AS n FROM data_sources").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });
});
