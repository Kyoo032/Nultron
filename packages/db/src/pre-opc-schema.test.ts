import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import preOpc from "./__fixtures__/pre-opc-schema.json";
import { ensureSchema } from "./ensure-schema";
import { purgeTenantRows } from "./tenant-purge";

const SME_ROWS = ["projects", "board_columns", "quota_allocations", "gateway_managed_tokens", "media_always_allow"];

function openPreOpcDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  for (const [table, columns] of Object.entries(preOpc.columns)) {
    for (const column of columns) {
      sqlite.exec(`ALTER TABLE \`${table}\` ADD \`${column}\` text`);
    }
  }
  for (const statement of preOpc.statements) {
    sqlite.exec(statement);
  }
  return sqlite;
}

function seedTenant(sqlite: Database.Database, id: string): void {
  const now = Date.now();
  const orgId = `${id}-org`;
  const workspaceId = `${id}-ws`;
  const userId = `${id}-user`;
  const agentId = `${id}-agent`;
  sqlite
    .prepare("INSERT INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .run(id, id, id, now);
  sqlite
    .prepare(
      "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, ?, ?, 'generic', ?)",
    )
    .run(orgId, id, orgId, orgId, now);
  sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(userId, userId, `${userId}@portal.invalid`, now, now);
  sqlite
    .prepare("INSERT INTO organization_members (id, organization_id, user_id, role) VALUES (?, ?, ?, 'owner')")
    .run(`${id}-member`, orgId, userId);
  sqlite
    .prepare("INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(workspaceId, orgId, workspaceId, workspaceId, now);
  sqlite
    .prepare(
      "INSERT INTO agents (id, organization_id, workspace_id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(agentId, orgId, workspaceId, agentId, agentId, userId, now, now);
  sqlite
    .prepare(
      "INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(`${id}-thread`, orgId, workspaceId, agentId, userId, now);
  sqlite
    .prepare(
      "INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at) VALUES (?, ?, 'research', 'doc', 't', 'text/plain', 'b', '{}', 1, ?, ?)",
    )
    .run(`${id}-artifact`, workspaceId, now, now);
  sqlite
    .prepare(
      "INSERT INTO tenant_usage (id, tenant_id, organization_id, mode, model, unit, quantity, at) VALUES (?, ?, ?, 'chat', 'm', 'token', 1, ?)",
    )
    .run(`${id}-usage`, id, orgId, now);
  sqlite
    .prepare(
      "INSERT INTO projects (id, organization_id, workspace_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 'p', ?, ?, ?)",
    )
    .run(`${id}-project`, orgId, workspaceId, userId, now, now);
  sqlite
    .prepare(
      "INSERT INTO board_columns (id, tenant_id, workspace_id, position, kind, created_at) VALUES (?, ?, ?, 0, 'todo', ?)",
    )
    .run(`${id}-column`, id, workspaceId, now);
  sqlite
    .prepare(
      "INSERT INTO quota_allocations (id, organization_id, tenant_id, name, scope_kind, limit_micros, period_kind, created_by, created_at, updated_at) VALUES (?, ?, ?, 'q', 'everyone', 1, 'lifetime', ?, ?, ?)",
    )
    .run(`${id}-allocation`, orgId, id, userId, now, now);
  sqlite
    .prepare(
      "INSERT INTO gateway_managed_tokens (organization_id, gateway_token_id, name, created_at) VALUES (?, ?, 't', ?)",
    )
    .run(orgId, `${id}-token`, now);
  sqlite
    .prepare(
      "INSERT INTO media_always_allow (organization_id, user_id, kind, allowed, updated_at) VALUES (?, ?, 'image', 1, ?)",
    )
    .run(orgId, userId, now);
}

function countFor(sqlite: Database.Database, table: string, id: string): number {
  const column = table === "board_columns" ? "workspace_id" : "organization_id";
  const value = table === "board_columns" ? `${id}-ws` : `${id}-org`;
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
  return row.n;
}

describe("a database written before the OPC split", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = openPreOpcDatabase();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("opens again with the current schema and keeps the old tables", () => {
    expect(() => ensureSchema(sqlite)).not.toThrow();
    const names = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const table of SME_ROWS) {
      expect(names.has(table)).toBe(true);
    }
  });

  it("purges one tenant, its old SME rows included, and leaves the other", () => {
    ensureSchema(sqlite);
    seedTenant(sqlite, "a");
    seedTenant(sqlite, "b");

    const result = purgeTenantRows(sqlite, "a");

    expect(result.workspaceIds).toEqual(["a-ws"]);
    for (const table of SME_ROWS) {
      expect(countFor(sqlite, table, "a"), table).toBe(0);
      expect(countFor(sqlite, table, "b"), table).toBe(1);
    }
    expect(countFor(sqlite, "threads", "a")).toBe(0);
    expect(countFor(sqlite, "threads", "b")).toBe(1);
    expect(countFor(sqlite, "tenant_usage", "a")).toBe(1);
    const artifacts = sqlite.prepare("SELECT workspace_id FROM artifacts ORDER BY workspace_id").all();
    expect(artifacts).toEqual([{ workspace_id: "b-ws" }]);
  });
});
