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
    expect(() => sqlite.prepare("UPDATE projects SET organization_id = ? WHERE id = 'p4'").run(b.orgId)).toThrow(
      /project_organization_mismatch/,
    );
  });

  it("is removed with its desk", () => {
    const a = seedDesk("a");
    insertProject("p5", a.orgId, a.workspaceId);
    sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run(a.workspaceId);
    expect((sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(0);
  });
});

/**
 * W1 (team-board-spec.md section 2b). The instructions column and the Workspace links on sources and
 * threads are added on open, so a database built before them gets them, and keeps the rows it holds.
 */
describe("Workspace columns (W1)", () => {
  function columnsOf(table: string): string[] {
    return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  it("are on a fresh database: instructions, and project_id on knowledge sources and threads", () => {
    expect(columnsOf("projects")).toContain("instructions");
    expect(columnsOf("knowledge_sources")).toContain("project_id");
    expect(columnsOf("threads")).toContain("project_id");
  });

  it("are added to a projects table from before W1, and the rows it holds keep their values", () => {
    const a = seedDesk("up");
    insertProject("kept", a.orgId, a.workspaceId);
    // A table from before W1: rebuild it without `instructions`, then open the schema again.
    sqlite.exec("ALTER TABLE projects DROP COLUMN instructions");
    expect(columnsOf("projects")).not.toContain("instructions");

    ensureSchema(sqlite);

    expect(columnsOf("projects")).toContain("instructions");
    const row = sqlite.prepare("SELECT name, instructions FROM projects WHERE id = 'kept'").get() as {
      name: string;
      instructions: string | null;
    };
    expect(row).toEqual({ name: "p", instructions: null });
    sqlite.prepare("UPDATE projects SET instructions = ? WHERE id = 'kept'").run("Be brief.");
    expect(
      (sqlite.prepare("SELECT instructions FROM projects WHERE id = 'kept'").get() as { instructions: string })
        .instructions,
    ).toBe("Be brief.");
  });

  it("is a no-op on a second open", () => {
    ensureSchema(sqlite);
    expect(columnsOf("projects").filter((name) => name === "instructions")).toHaveLength(1);
  });
});

/** K-D22, K-D23: a Workspace's members, one owner each, and the backfill for projects made before them. */
describe("Workspace members", () => {
  function members(projectId: string): Array<{ user_id: string; role: string }> {
    return sqlite
      .prepare("SELECT user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id")
      .all(projectId) as Array<{ user_id: string; role: string }>;
  }

  it("gives a project made before membership its maker as owner, and a shared one no other member", () => {
    const a = seedDesk("bf");
    insertProject("old-private", a.orgId, a.workspaceId, "private");
    insertProject("old-shared", a.orgId, a.workspaceId, "workspace");
    expect(members("old-shared")).toEqual([]);

    ensureSchema(sqlite);

    expect(members("old-private")).toEqual([{ user_id: "u", role: "owner" }]);
    expect(members("old-shared")).toEqual([{ user_id: "u", role: "owner" }]);
  });

  it("never writes a maker back after ownership moved and the maker was removed", () => {
    const a = seedDesk("tr");
    insertProject("moved", a.orgId, a.workspaceId);
    ensureSchema(sqlite);
    const now = Date.now();
    sqlite
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES ('moved', 'v', 'admin', 'u', ?)",
      )
      .run(now);
    sqlite.prepare("UPDATE project_members SET role = 'admin' WHERE project_id = 'moved' AND user_id = 'u'").run();
    sqlite.prepare("UPDATE project_members SET role = 'owner' WHERE project_id = 'moved' AND user_id = 'v'").run();
    sqlite.prepare("DELETE FROM project_members WHERE project_id = 'moved' AND user_id = 'u'").run();

    ensureSchema(sqlite);

    expect(members("moved")).toEqual([{ user_id: "v", role: "owner" }]);
  });

  it("refuses a second owner and a role outside owner, admin and member", () => {
    const a = seedDesk("one");
    insertProject("solo", a.orgId, a.workspaceId);
    ensureSchema(sqlite);
    const add = sqlite.prepare(
      "INSERT INTO project_members (project_id, user_id, role, added_by, added_at) VALUES ('solo', ?, ?, 'u', 1)",
    );
    expect(() => add.run("w", "owner")).toThrow(/UNIQUE/);
    expect(() => add.run("w", "guest")).toThrow(/CHECK/);
    add.run("w", "member");
    expect(members("solo")).toEqual([
      { user_id: "u", role: "owner" },
      { user_id: "w", role: "member" },
    ]);
  });

  it("goes with its project, and so do the agents brought in", () => {
    const a = seedDesk("gone");
    insertProject("bye", a.orgId, a.workspaceId);
    ensureSchema(sqlite);
    sqlite
      .prepare(
        "INSERT INTO project_agents (project_id, agent_id, brought_by, added_at) VALUES ('bye', 'research', 'u', 1)",
      )
      .run();
    sqlite.prepare("DELETE FROM projects WHERE id = 'bye'").run();
    const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("project_members"), count("project_agents")]).toEqual([0, 0]);
  });
});
