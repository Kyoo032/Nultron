/**
 * Desk files — `desk_files`, `desk_file_versions` and `file_proposals`.
 *
 * What this has to get right: the three tables exist with exactly the columns the host store and the
 * folder root write, on a fresh database and on one baseline-stamped past 0022 (the healer); a path
 * is unique among LIVE rows only, so a soft delete frees it; a version row follows its file; the
 * CHECK constraints refuse a value the host never writes; the Drizzle declarations match the SQL;
 * and the journal `when` sits above every migration before it, because the runner is forward-only
 * on `when`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { deskFileVersions, deskFiles, fileProposals } from "./schema";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realMigrations = path.join(packageDir, "drizzle");

const DESK_FILE_COLUMNS = [
  "id",
  "workspace_id",
  "path",
  "head_version",
  "bytes",
  "mime",
  "sha256",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;
const VERSION_COLUMNS = [
  "file_id",
  "version",
  "object_key",
  "bytes",
  "sha256",
  "author_kind",
  "author_id",
  "mode",
  "created_at",
] as const;
const PROPOSAL_COLUMNS = [
  "id",
  "workspace_id",
  "run_id",
  "path",
  "kind",
  "before_sha256",
  "after_body",
  "status",
  "created_at",
  "decided_at",
] as const;

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function insertFile(sqlite: Database.Database, id: string, workspaceId: string, filePath: string, deletedAt?: number) {
  sqlite
    .prepare(
      `INSERT INTO desk_files (id, workspace_id, path, head_version, bytes, mime, sha256, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 1, 4, 'text/markdown', 'abc', 1, 1, ?)`,
    )
    .run(id, workspaceId, filePath, deletedAt ?? null);
}

function insertVersion(sqlite: Database.Database, fileId: string, version: number, authorKind = "user") {
  sqlite
    .prepare(
      `INSERT INTO desk_file_versions (file_id, version, object_key, bytes, sha256, author_kind, author_id, mode, created_at)
       VALUES (?, ?, ?, 4, 'abc', ?, 'someone', NULL, 1)`,
    )
    .run(fileId, version, `desk-files/${fileId}/${version}`, authorKind);
}

function insertProposal(sqlite: Database.Database, id: string, kind: string, status: string) {
  sqlite
    .prepare(
      `INSERT INTO file_proposals (id, workspace_id, run_id, path, kind, status, created_at)
       VALUES (?, 'ws-1', 'run-1', 'a.txt', ?, ?, 1)`,
    )
    .run(id, kind, status);
}

describe("0022_desk_files on a fresh database", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates the three tables with exactly the columns the host writes", () => {
    expect(tableNames(sqlite)).toEqual(expect.arrayContaining(["desk_files", "desk_file_versions", "file_proposals"]));
    expect(columnNames(sqlite, "desk_files").sort()).toEqual([...DESK_FILE_COLUMNS].sort());
    expect(columnNames(sqlite, "desk_file_versions").sort()).toEqual([...VERSION_COLUMNS].sort());
    expect(columnNames(sqlite, "file_proposals").sort()).toEqual([...PROPOSAL_COLUMNS].sort());
  });

  it("matches the Drizzle declarations column for column", () => {
    const names = (table: Parameters<typeof getTableColumns>[0]) =>
      Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
    expect(names(deskFiles)).toEqual([...DESK_FILE_COLUMNS].sort());
    expect(names(deskFileVersions)).toEqual([...VERSION_COLUMNS].sort());
    expect(names(fileProposals)).toEqual([...PROPOSAL_COLUMNS].sort());
  });

  it("starts empty", () => {
    for (const table of ["desk_files", "desk_file_versions", "file_proposals"]) {
      expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });

  it("keeps a path unique among live rows in one desk, and only there", () => {
    insertFile(sqlite, "f1", "ws-1", "notes/plan.md");
    expect(() => insertFile(sqlite, "f2", "ws-1", "notes/plan.md")).toThrow(/UNIQUE/i);
    // Another desk may use the same path.
    insertFile(sqlite, "f3", "ws-2", "notes/plan.md");
    // A deleted row frees the path for a new file, and several deleted rows may share one.
    sqlite.prepare("UPDATE desk_files SET deleted_at = 5 WHERE id = 'f1'").run();
    insertFile(sqlite, "f4", "ws-1", "notes/plan.md");
    insertFile(sqlite, "f5", "ws-1", "old.md", 9);
    insertFile(sqlite, "f6", "ws-1", "old.md", 10);
    expect(
      (sqlite.prepare("SELECT count(*) AS n FROM desk_files WHERE workspace_id = 'ws-1'").get() as { n: number }).n,
    ).toBe(4);
  });

  it("indexes the desk and the live path", () => {
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('desk_files', 'file_proposals')")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["desk_files_live_path_unique", "desk_files_ws_idx", "file_proposals_ws_status_idx"]),
    );
  });

  it("keys a version on (file, version) and takes it with its file", () => {
    insertFile(sqlite, "f1", "ws-1", "a.md");
    insertVersion(sqlite, "f1", 1);
    insertVersion(sqlite, "f1", 2, "agent");
    expect(() => insertVersion(sqlite, "f1", 2)).toThrow(/UNIQUE|PRIMARY/i);
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare("DELETE FROM desk_files WHERE id = 'f1'").run();
    expect((sqlite.prepare("SELECT count(*) AS n FROM desk_file_versions").get() as { n: number }).n).toBe(0);
  });

  it("refuses a version for a file that does not exist", () => {
    sqlite.pragma("foreign_keys = ON");
    expect(() => insertVersion(sqlite, "ghost", 1)).toThrow(/FOREIGN KEY/i);
  });

  it("refuses an author kind the host never writes", () => {
    insertFile(sqlite, "f1", "ws-1", "a.md");
    expect(() => insertVersion(sqlite, "f1", 1, "system")).toThrow(/CHECK/i);
  });

  it("refuses a proposal kind or status outside the lifecycle", () => {
    insertProposal(sqlite, "p1", "write", "pending");
    insertProposal(sqlite, "p2", "delete", "applied");
    expect(() => insertProposal(sqlite, "p3", "rename", "pending")).toThrow(/CHECK/i);
    expect(() => insertProposal(sqlite, "p4", "write", "done")).toThrow(/CHECK/i);
  });

  it("leaves artifacts and datasets alone", () => {
    for (const table of ["artifacts", "datasets"]) {
      expect(tableNames(sqlite)).toContain(table);
    }
  });
});

describe("0022_desk_files is in the committed migration set", () => {
  const journal = JSON.parse(readFileSync(path.join(realMigrations, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const whenOf = (tag: string): number => {
    const entry = journal.entries.find((row) => row.tag === tag);
    if (!entry) {
      throw new Error(`${tag} is not in the migration journal`);
    }
    return entry.when;
  };

  it("carries a `when` above every migration before it", () => {
    const mine = whenOf("0022_desk_files");
    const before = journal.entries.slice(
      0,
      journal.entries.findIndex((row) => row.tag === "0022_desk_files"),
    );
    expect(before.length).toBeGreaterThan(0);
    for (const entry of before) {
      expect(mine, `${entry.tag} is at or above 0022`).toBeGreaterThan(entry.when);
    }
  });

  it("sits after 0021 in the entries array, so array order and `when` order agree", () => {
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.indexOf("0022_desk_files")).toBeGreaterThan(tags.indexOf("0021_auth_session_hardening"));
    const whens = journal.entries.map((entry) => entry.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it("is additive: it creates tables and alters none", () => {
    const sqlText = readFileSync(path.join(realMigrations, "0022_desk_files.sql"), "utf8");
    expect(sqlText).not.toContain("ALTER TABLE");
    expect(sqlText).not.toContain("DROP ");
    expect(sqlText).toContain("WHERE `deleted_at` IS NULL");
  });

  it("heals a database stamped past 0022 that never got the tables", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    sqlite.exec("DROP TABLE desk_file_versions; DROP TABLE desk_files; DROP TABLE file_proposals;");
    expect(tableNames(sqlite)).not.toContain("desk_files");

    ensureSchema(sqlite);

    expect(columnNames(sqlite, "desk_files").sort()).toEqual([...DESK_FILE_COLUMNS].sort());
    expect(columnNames(sqlite, "desk_file_versions").sort()).toEqual([...VERSION_COLUMNS].sort());
    expect(columnNames(sqlite, "file_proposals").sort()).toEqual([...PROPOSAL_COLUMNS].sort());
    // The healed shape keeps the partial unique index and the constraints.
    insertFile(sqlite, "f1", "ws-1", "a.md");
    expect(() => insertFile(sqlite, "f2", "ws-1", "a.md")).toThrow(/UNIQUE/i);
    expect(() => insertProposal(sqlite, "p1", "rename", "pending")).toThrow(/CHECK/i);
    sqlite.close();
  });

  it("actually ran as a migration, rather than only being healed into place", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const stamps = sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at").all() as Array<{
      created_at: number;
    }>;
    expect(stamps.map((row) => row.created_at)).toContain(whenOf("0022_desk_files"));
    sqlite.close();
  });
});
