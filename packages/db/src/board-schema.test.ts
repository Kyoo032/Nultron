import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_TABLES } from "./board-schema";
import { ensureSchema } from "./ensure-schema";
import { CASCADED_TABLES, purgeTenantRows } from "./tenant-purge";

let sqlite: Database.Database;

function seedDesk(tenantId: string, label: string): { orgId: string; workspaceId: string } {
  const now = Date.now();
  const orgId = `${label}-org`;
  const workspaceId = `${label}-ws`;
  sqlite
    .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .run(tenantId, tenantId, tenantId, now);
  sqlite
    .prepare(
      "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, ?, ?, 'generic', ?)",
    )
    .run(orgId, tenantId, orgId, orgId, now);
  sqlite
    .prepare("INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(workspaceId, orgId, workspaceId, workspaceId, now);
  return { orgId, workspaceId };
}

function seedBoard(tenantId: string, workspaceId: string, label: string): void {
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO board_columns (id, tenant_id, workspace_id, name, position, kind, created_at) VALUES (?, ?, ?, NULL, 0, 'todo', ?)",
    )
    .run(`${label}-col`, tenantId, workspaceId, now);
  sqlite
    .prepare(
      "INSERT INTO cards (id, tenant_id, workspace_id, column_id, position, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'V', 't', 'u', ?, ?)",
    )
    .run(`${label}-card`, tenantId, workspaceId, `${label}-col`, now, now);
  sqlite
    .prepare(
      "INSERT INTO card_comments (id, tenant_id, workspace_id, card_id, author_kind, author_user_id, body, created_at) VALUES (?, ?, ?, ?, 'person', 'u', 'sealed', ?)",
    )
    .run(`${label}-comment`, tenantId, workspaceId, `${label}-card`, now);
  sqlite
    .prepare(
      "INSERT INTO card_events (tenant_id, workspace_id, card_id, actor_kind, actor_user_id, type, payload, created_at) VALUES (?, ?, ?, 'person', 'u', 'card.created', '{}', ?)",
    )
    .run(tenantId, workspaceId, `${label}-card`, now);
  sqlite
    .prepare(
      "INSERT INTO board_audit (id, tenant_id, workspace_id, actor_user_id, action, target, created_at) VALUES (?, ?, ?, 'u', 'card.archive', ?, ?)",
    )
    .run(`${label}-audit`, tenantId, workspaceId, `${label}-card`, now);
}

function countIn(table: string, workspaceId: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId) as { n: number })
    .n;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("team board tables", () => {
  it("creates all five tables and survives a second ensureSchema", () => {
    ensureSchema(sqlite);
    const names = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([...BOARD_TABLES]));
    expect(names).not.toContain("sqlite_sequence");
  });

  it("refuses a board row whose tenant_id is not the desk's tenant, on insert and on update", () => {
    const { workspaceId } = seedDesk("partner-a", "a");
    seedDesk("partner-b", "b");
    const insert = sqlite.prepare(
      "INSERT INTO board_columns (id, tenant_id, workspace_id, position, kind, created_at) VALUES (?, ?, ?, 0, 'todo', 1)",
    );
    expect(() => insert.run("wrong", "partner-b", workspaceId)).toThrow("board_tenant_mismatch");
    insert.run("right", "partner-a", workspaceId);
    expect(() => sqlite.prepare("UPDATE board_columns SET tenant_id = 'partner-b' WHERE id = 'right'").run()).toThrow(
      "board_tenant_mismatch",
    );
    expect(() => sqlite.prepare("UPDATE board_columns SET workspace_id = 'b-ws' WHERE id = 'right'").run()).toThrow(
      "board_tenant_mismatch",
    );
  });

  it("allows one column per built-in kind and many custom ones on a desk", () => {
    const { workspaceId } = seedDesk("partner-a", "a");
    const insert = sqlite.prepare(
      "INSERT OR IGNORE INTO board_columns (id, tenant_id, workspace_id, position, kind, created_at) VALUES (?, 'partner-a', ?, ?, ?, 1)",
    );
    expect(insert.run("t1", workspaceId, 0, "todo").changes).toBe(1);
    expect(insert.run("t2", workspaceId, 1, "todo").changes).toBe(0);
    expect(insert.run("c1", workspaceId, 2, "custom").changes).toBe(1);
    expect(insert.run("c2", workspaceId, 3, "custom").changes).toBe(1);
  });

  it("refuses an assignee kind without a person and a person without a kind", () => {
    const { workspaceId } = seedDesk("partner-a", "a");
    seedBoard("partner-a", workspaceId, "a");
    expect(() => sqlite.prepare("UPDATE cards SET assignee_kind = 'person' WHERE id = 'a-card'").run()).toThrow(
      /CHECK/,
    );
    expect(() => sqlite.prepare("UPDATE cards SET assignee_user_id = 'u2' WHERE id = 'a-card'").run()).toThrow(/CHECK/);
    sqlite.prepare("UPDATE cards SET assignee_kind = 'person', assignee_user_id = 'u2' WHERE id = 'a-card'").run();
  });

  it("goes with its desk, and a tenant purge takes one company's board and leaves the other's", () => {
    const a = seedDesk("partner-a", "a");
    const b = seedDesk("partner-b", "b");
    seedBoard("partner-a", a.workspaceId, "a");
    seedBoard("partner-b", b.workspaceId, "b");
    for (const table of BOARD_TABLES) {
      expect(CASCADED_TABLES).toContain(table);
    }

    purgeTenantRows(sqlite, "partner-a");

    for (const table of BOARD_TABLES) {
      expect(countIn(table, a.workspaceId), `${table} kept partner-a rows`).toBe(0);
      expect(countIn(table, b.workspaceId), `${table} lost partner-b rows`).toBe(1);
    }

    sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run(b.workspaceId);
    for (const table of BOARD_TABLES) {
      expect(countIn(table, b.workspaceId), `${table} outlived its desk`).toBe(0);
    }
  });
});
