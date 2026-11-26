import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const migration = readFileSync(`${migrationsFolder()}/0024_inbox_active_endpoint.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

function insert(sqlite: Database.Database, id: string, status: string) {
  sqlite
    .prepare(`INSERT INTO channel_endpoints
    (id, organization_id, workspace_id, kind, external_id, status, created_at, updated_at)
    VALUES (?, 'org', ?, 'whatsapp', '1000001', ?, 1, 1)`)
    .run(id, id, status);
}

function checkReleasedNumber(sqlite: Database.Database) {
  insert(sqlite, "a", "disabled");
  insert(sqlite, "b", "active");
  insert(sqlite, "c", "disabled");
  expect(() => insert(sqlite, "d", "active")).toThrow(/UNIQUE/i);
  expect(() => sqlite.prepare("UPDATE channel_endpoints SET status = 'active' WHERE id = 'a'").run()).toThrow(
    /UNIQUE/i,
  );
  expect(sqlite.prepare("SELECT id FROM channel_endpoints WHERE status = 'active'").all()).toEqual([{ id: "b" }]);
}

describe("0024_inbox_active_endpoint", () => {
  it("follows every existing migration in the forward-only journal", () => {
    const index = journal.entries.findIndex((row) => row.tag === "0024_inbox_active_endpoint");
    const entry = journal.entries[index]!;
    for (const previous of journal.entries.slice(0, index)) expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("upgrades the old index without changing existing endpoint rows", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(readFileSync(`${migrationsFolder()}/0023_customer_inbox.sql`, "utf8"));
      insert(sqlite, "old", "disabled");
      const before = sqlite.prepare("SELECT * FROM channel_endpoints").all();
      sqlite.exec(migration);
      expect(sqlite.prepare("SELECT * FROM channel_endpoints").all()).toEqual(before);
      checkReleasedNumber(sqlite);
    } finally {
      sqlite.close();
    }
  });

  it("applies on a fresh database and heals missing tables and baseline-stamped legacy indexes", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      expect(
        sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get(),
      ).toEqual({ created_at: journal.entries.at(-1)!.when });
      checkReleasedNumber(sqlite);
      sqlite.exec("DROP TABLE customer_messages; DROP TABLE customer_conversations; DROP TABLE channel_endpoints;");
      ensureSchema(sqlite);
      checkReleasedNumber(sqlite);
      sqlite.exec(
        "DELETE FROM channel_endpoints; DROP INDEX channel_endpoints_kind_external_unique; CREATE UNIQUE INDEX channel_endpoints_kind_external_unique ON channel_endpoints(kind, external_id);",
      );
      ensureSchema(sqlite);
      checkReleasedNumber(sqlite);
    } finally {
      sqlite.close();
    }
  });
});
