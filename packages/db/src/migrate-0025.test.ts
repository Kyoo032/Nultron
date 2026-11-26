import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const migration = readFileSync(`${migrationsFolder()}/0025_auth_session_endpoint_mac.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

const sessionColumns = (sqlite: Database.Database) =>
  new Set(
    (sqlite.prepare("PRAGMA table_info(auth_sessions)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );

function insertSession(sqlite: Database.Database, id: string) {
  sqlite
    .prepare(
      `INSERT INTO auth_sessions
      (id, tenant_id, user_id, org_id, created_at, last_seen_at, expires_at, absolute_expires_at)
      VALUES (?, 't', 'u', 'o', 1, 1, 1, 1)`,
    )
    .run(id);
}

describe("0025_auth_session_endpoint_mac", () => {
  it("follows every existing migration in the forward-only journal", () => {
    const entry = journal.entries.at(-1)!;
    expect(entry.tag).toBe("0025_auth_session_endpoint_mac");
    for (const previous of journal.entries.slice(0, -1)) expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("adds both columns without touching existing session rows", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(readFileSync(`${migrationsFolder()}/0014_auth_sessions.sql`, "utf8"));
      sqlite.exec(readFileSync(`${migrationsFolder()}/0021_auth_session_hardening.sql`, "utf8"));
      insertSession(sqlite, "kept");
      const before = sqlite.prepare("SELECT id, tenant_id FROM auth_sessions").all();
      sqlite.exec(migration);
      expect(sessionColumns(sqlite)).toEqual(expect.objectContaining({}));
      const columns = sessionColumns(sqlite);
      expect(columns.has("gateway_endpoint_mac")).toBe(true);
      expect(columns.has("endpoint_key_sealed")).toBe(true);
      expect(
        sqlite.prepare("SELECT id, tenant_id, gateway_endpoint_mac, endpoint_key_sealed FROM auth_sessions").all(),
      ).toEqual([
        ...(before as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          gateway_endpoint_mac: null,
          endpoint_key_sealed: null,
        })),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("applies on a fresh database and heals a database missing the columns", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      expect(
        sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get(),
      ).toEqual({ created_at: journal.entries.at(-1)!.when });
      expect(sessionColumns(sqlite).has("gateway_endpoint_mac")).toBe(true);
      expect(sessionColumns(sqlite).has("endpoint_key_sealed")).toBe(true);
      sqlite.exec("ALTER TABLE auth_sessions DROP COLUMN gateway_endpoint_mac");
      sqlite.exec("ALTER TABLE auth_sessions DROP COLUMN endpoint_key_sealed");
      ensureSchema(sqlite);
      expect(sessionColumns(sqlite).has("gateway_endpoint_mac")).toBe(true);
      expect(sessionColumns(sqlite).has("endpoint_key_sealed")).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
