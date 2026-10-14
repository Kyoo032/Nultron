import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { PROJECT_TABLES } from "./projects-schema";

let sqlite: Database.Database;

function seedDesk(label: string): { orgId: string; workspaceId: string } {
  const now = Date.now();
  sqlite
    .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .run("tenant-1", "tenant-1", "tenant-1", now);
  sqlite
    .prepare(
      "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, 'tenant-1', ?, ?, 'generic', ?)",
    )
    .run(`${label}-org`, `${label}-org`, `${label}-org`, now);
  sqlite
    .prepare("INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`${label}-ws`, `${label}-org`, `${label}-ws`, `${label}-ws`, now);
  return { orgId: `${label}-org`, workspaceId: `${label}-ws` };
}

function insertProject(id: string, orgId: string, workspaceId: string, visibility = "private"): void {
  sqlite
    .prepare(
      "INSERT INTO projects (id, organization_id, workspace_id, name, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, 'p', ?, 'u', ?, ?)",
    )
    .run(id, orgId, workspaceId, visibility, Date.now(), Date.now());
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("projects table", () => {
  it("is created, and a second ensureSchema leaves it alone", () => {
    const { orgId, workspaceId } = seedDesk("a");
    insertProject("p1", orgId, workspaceId);
    ensureSchema(sqlite);
    const names = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([...PROJECT_TABLES]));
    expect((sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
  });

  it("refuses a visibility other than private or workspace", () => {
    const { orgId, workspaceId } = seedDesk("a");
    expect(() => insertProject("p2", orgId, workspaceId, "public")).toThrow();
  });

  it("refuses a project whose organization is not its desk's organization, on insert and on update", () => {
    const a = seedDesk("a");
    const b = seedDesk("b");
    expect(() => insertProject("p3", b.orgId, a.workspaceId)).toThrow(/project_organization_mismatch/);
    insertProject("p4", a.orgId, a.workspaceId);
    expect(() =>
      sqlite.prepare("UPDATE projects SET organization_id = ? WHERE id = 'p4'").run(b.orgId),
    ).toThrow(/project_organization_mismatch/);
  });

  it("is removed with its desk", () => {
    const a = seedDesk("a");
    insertProject("p5", a.orgId, a.workspaceId);
    sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run(a.workspaceId);
    expect((sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(0);
  });
});
