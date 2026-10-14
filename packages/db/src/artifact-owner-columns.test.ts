/**
 * Ownership columns (SR-175): `owner_user_id` and `project_id` on `artifacts`, `project_id` on `media`.
 *
 * They are added on open by `ensureOwnershipColumns`, not by a numbered migration, because an ALTER in
 * the journal cannot be replayed (see `migrate-0021.test.ts`). What this has to get right: a fresh
 * database has the columns, nullable; a database built before them gets them on its next open and the
 * row it already holds survives with NULL owner (the legacy company-visible rule); a journal rewound
 * and replayed does not trip over them; and the Drizzle declarations match the table.
 */
import { getTableColumns } from "drizzle-orm";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { artifacts, media } from "./schema";

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/** Put the database back in the shape a build from before SR-175 leaves it in. */
function dropOwnershipColumns(sqlite: Database.Database): void {
  sqlite.exec("ALTER TABLE `artifacts` DROP COLUMN `owner_user_id`");
  sqlite.exec("ALTER TABLE `artifacts` DROP COLUMN `project_id`");
  sqlite.exec("ALTER TABLE `media` DROP COLUMN `project_id`");
}

describe("ownership columns", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("are on a fresh database, nullable", () => {
    const info = sqlite.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string; notnull: number }>;
    for (const name of ["owner_user_id", "project_id"]) {
      expect(info.find((column) => column.name === name)?.notnull).toBe(0);
    }
    expect(columnNames(sqlite, "media")).toContain("project_id");
  });

  it("match the Drizzle declarations", () => {
    const names = (table: Parameters<typeof getTableColumns>[0]) =>
      Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
    expect(names(artifacts)).toEqual(columnNames(sqlite, "artifacts").sort());
    expect(names(media)).toEqual(columnNames(sqlite, "media").sort());
  });

  it("are added to a database built before them, keeping its rows with no owner", () => {
    sqlite
      .prepare(
        `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
         VALUES ('legacy-1', 'ws-1', 'research', 'dossier', 'Old', 'text/markdown', 'x', '{}', 1, 1, 1)`,
      )
      .run();
    dropOwnershipColumns(sqlite);
    expect(columnNames(sqlite, "artifacts")).not.toContain("owner_user_id");
    expect(columnNames(sqlite, "media")).not.toContain("project_id");

    ensureSchema(sqlite);

    expect(columnNames(sqlite, "artifacts")).toEqual(expect.arrayContaining(["owner_user_id", "project_id"]));
    expect(columnNames(sqlite, "media")).toContain("project_id");
    const row = sqlite.prepare("SELECT id, owner_user_id, project_id FROM artifacts WHERE id = 'legacy-1'").get();
    expect(row).toEqual({ id: "legacy-1", owner_user_id: null, project_id: null });
  });

  it("survive a rewound journal being replayed", () => {
    sqlite.exec("DELETE FROM __drizzle_migrations");
    expect(() => ensureSchema(sqlite)).not.toThrow();
    sqlite.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at >= (SELECT max(created_at) FROM __drizzle_migrations)",
    );
    expect(() => ensureSchema(sqlite)).not.toThrow();
    expect(columnNames(sqlite, "artifacts").filter((name) => name === "owner_user_id")).toHaveLength(1);
  });

  it("are idempotent: a second open changes nothing", () => {
    ensureSchema(sqlite);
    ensureSchema(sqlite);
    expect(columnNames(sqlite, "artifacts").filter((name) => name === "owner_user_id")).toHaveLength(1);
  });
});
