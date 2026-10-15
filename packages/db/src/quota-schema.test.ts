import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { QUOTA_AUDIT_ACTIONS, QUOTA_TABLES, ensureQuotaTables } from "./quota-schema";

type Db = Database.Database;
type Row = Record<string, string | number | null>;

const EXPECTED_COLUMNS: Record<string, string[]> = {
  company_quota_settings: [
    "organization_id",
    "tenant_id",
    "enabled",
    "enabled_at",
    "enabled_by",
    "company_cap_micros",
    "version",
  ],
  company_groups: ["id", "organization_id", "tenant_id", "name", "created_by", "created_at", "archived_at"],
  company_group_members: ["group_id", "user_id", "added_by", "added_at"],
  quota_allocations: [
    "id",
    "organization_id",
    "tenant_id",
    "name",
    "scope_kind",
    "limit_micros",
    "per_person_limit_micros",
    "period_kind",
    "period_start",
    "spent_micros",
    "held_micros",
    "models_mode",
    "priority",
    "status",
    "gateway_token_id",
    "version",
    "created_by",
    "created_at",
    "updated_at",
  ],
  quota_allocation_models: ["allocation_id", "model_id"],
  quota_assignments: ["allocation_id", "subject_kind", "subject_id"],
  quota_person_usage: ["allocation_id", "user_id", "period_start", "spent_micros", "held_micros"],
  quota_holds: [
    "id",
    "allocation_id",
    "organization_id",
    "tenant_id",
    "user_id",
    "run_id",
    "seq",
    "boot_id",
    "kind",
    "model",
    "amount_micros",
    "state",
    "settled_micros",
    "cost_basis",
    "created_at",
    "expires_at",
    "closed_at",
  ],
  quota_audit: ["id", "organization_id", "tenant_id", "actor_user_id", "action", "allocation_id", "detail", "at"],
};

const TENANT_USAGE_QUOTA_COLUMNS = ["allocation_id", "purpose", "hold_id", "agent_id", "project_id"];

const GUARD_TRIGGERS = [
  "company_quota_settings_tenant_insert_guard",
  "company_quota_settings_tenant_update_guard",
  "company_groups_tenant_insert_guard",
  "company_groups_tenant_update_guard",
  "quota_allocations_tenant_insert_guard",
  "quota_allocations_tenant_update_guard",
  "quota_holds_tenant_insert_guard",
  "quota_holds_tenant_update_guard",
  "quota_audit_tenant_insert_guard",
  "quota_audit_tenant_update_guard",
  "company_group_members_member_insert_guard",
  "company_group_members_member_update_guard",
  "quota_assignments_person_insert_guard",
  "quota_assignments_person_update_guard",
  "quota_assignments_group_insert_guard",
  "quota_assignments_group_update_guard",
  "quota_holds_allocation_insert_guard",
  "quota_holds_allocation_update_guard",
  "quota_audit_allocation_insert_guard",
  "quota_audit_allocation_update_guard",
  "quota_person_usage_member_insert_guard",
  "quota_person_usage_member_update_guard",
  "tenant_usage_allocation_insert_guard",
  "tenant_usage_allocation_update_guard",
  "organization_members_quota_removal",
];

function insertRow(sqlite: Db, table: string, row: Row): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function columnsOf(sqlite: Db, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function indexesOf(sqlite: Db, table: string): Array<{ name: string; unique: number; partial: number }> {
  return sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
}

function triggerNames(sqlite: Db): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function countWhere(sqlite: Db, table: string, where: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

function countAll(sqlite: Db, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function allocation(overrides: Row = {}): Row {
  return {
    id: "alloc-new",
    organization_id: "org-a",
    tenant_id: "tenant-a",
    name: "Team",
    scope_kind: "groups",
    limit_micros: 1000,
    period_kind: "lifetime",
    created_by: "user-a",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function hold(overrides: Row = {}): Row {
  return {
    id: "hold-new",
    allocation_id: "alloc-a",
    organization_id: "org-a",
    tenant_id: "tenant-a",
    user_id: "user-a",
    run_id: "run-1",
    seq: 0,
    boot_id: "boot-1",
    kind: "text",
    model: "gpt-4o",
    amount_micros: 100,
    state: "open",
    created_at: 1,
    expires_at: 2,
    ...overrides,
  };
}

function seedCompanies(sqlite: Db): void {
  for (const id of ["tenant-a", "tenant-b"]) {
    insertRow(sqlite, "tenants", { id, slug: id, name: id, status: "active", created_at: 1 });
  }
  insertRow(sqlite, "organizations", {
    id: "org-a",
    tenant_id: "tenant-a",
    name: "org-a",
    slug: "org-a",
    industry_pack: "generic",
    created_at: 1,
  });
  insertRow(sqlite, "organizations", {
    id: "org-b",
    tenant_id: "tenant-b",
    name: "org-b",
    slug: "org-b",
    industry_pack: "generic",
    created_at: 1,
  });
  for (const id of ["user-a", "user-b", "user-x"]) {
    insertRow(sqlite, "user", {
      id,
      name: id,
      email: `${id}@portal.invalid`,
      email_verified: 0,
      created_at: 1,
      updated_at: 1,
    });
  }
  insertRow(sqlite, "organization_members", {
    id: "member-a",
    organization_id: "org-a",
    user_id: "user-a",
    role: "owner",
  });
  insertRow(sqlite, "organization_members", {
    id: "member-b",
    organization_id: "org-b",
    user_id: "user-b",
    role: "owner",
  });
  insertRow(sqlite, "company_groups", {
    id: "group-a",
    organization_id: "org-a",
    tenant_id: "tenant-a",
    name: "Finance",
    created_by: "user-a",
    created_at: 1,
  });
  insertRow(sqlite, "company_groups", {
    id: "group-b",
    organization_id: "org-b",
    tenant_id: "tenant-b",
    name: "Finance",
    created_by: "user-b",
    created_at: 1,
  });
  insertRow(sqlite, "company_group_members", {
    group_id: "group-a",
    user_id: "user-a",
    added_by: "user-a",
    added_at: 1,
  });
  insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-a", scope_kind: "everyone", limit_micros: 1000000 }));
  insertRow(
    sqlite,
    "quota_allocations",
    allocation({
      id: "alloc-b",
      organization_id: "org-b",
      tenant_id: "tenant-b",
      scope_kind: "everyone",
      created_by: "user-b",
    }),
  );
}

function openDb(): Db {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  sqlite.pragma("foreign_keys = ON");
  seedCompanies(sqlite);
  return sqlite;
}

const BAD_ROWS: Array<[string, string, Row]> = [
  [
    "company_quota_settings enabled 2",
    "company_quota_settings",
    { organization_id: "org-a", tenant_id: "tenant-a", enabled: 2 },
  ],
  [
    "company_quota_settings enabled -1",
    "company_quota_settings",
    { organization_id: "org-a", tenant_id: "tenant-a", enabled: -1 },
  ],
  [
    "company_quota_settings cap negative",
    "company_quota_settings",
    { organization_id: "org-a", tenant_id: "tenant-a", company_cap_micros: -1 },
  ],
  [
    "company_quota_settings cap above 1e12",
    "company_quota_settings",
    { organization_id: "org-a", tenant_id: "tenant-a", company_cap_micros: 1000000000001 },
  ],
  [
    "company_quota_settings version 0",
    "company_quota_settings",
    { organization_id: "org-a", tenant_id: "tenant-a", version: 0 },
  ],
  [
    "company_groups blank name",
    "company_groups",
    {
      id: "group-blank",
      organization_id: "org-a",
      tenant_id: "tenant-a",
      name: "   ",
      created_by: "user-a",
      created_at: 1,
    },
  ],
  ["quota_allocations unknown scope", "quota_allocations", allocation({ scope_kind: "org" })],
  ["quota_allocations negative limit", "quota_allocations", allocation({ limit_micros: -1 })],
  ["quota_allocations limit above 1e12", "quota_allocations", allocation({ limit_micros: 1000000000001 })],
  ["quota_allocations negative per-person limit", "quota_allocations", allocation({ per_person_limit_micros: -1 })],
  [
    "quota_allocations per-person above 1e12",
    "quota_allocations",
    allocation({ per_person_limit_micros: 1000000000001 }),
  ],
  ["quota_allocations unknown period", "quota_allocations", allocation({ period_kind: "weekly" })],
  ["quota_allocations negative spent", "quota_allocations", allocation({ spent_micros: -1 })],
  ["quota_allocations negative held", "quota_allocations", allocation({ held_micros: -1 })],
  ["quota_allocations unknown models mode", "quota_allocations", allocation({ models_mode: "some" })],
  ["quota_allocations unknown status", "quota_allocations", allocation({ status: "deleted" })],
  ["quota_allocations version 0", "quota_allocations", allocation({ version: 0 })],
  [
    "quota_allocation_models upper-case model",
    "quota_allocation_models",
    { allocation_id: "alloc-a", model_id: "GPT-4o" },
  ],
  [
    "quota_allocation_models padded model",
    "quota_allocation_models",
    { allocation_id: "alloc-a", model_id: " gpt-4o" },
  ],
  ["quota_allocation_models empty model", "quota_allocation_models", { allocation_id: "alloc-a", model_id: "" }],
  [
    "quota_assignments unknown subject kind",
    "quota_assignments",
    { allocation_id: "alloc-a", subject_kind: "org", subject_id: "user-a" },
  ],
  [
    "quota_person_usage negative spent",
    "quota_person_usage",
    { allocation_id: "alloc-a", user_id: "user-a", period_start: 0, spent_micros: -1 },
  ],
  [
    "quota_person_usage negative held",
    "quota_person_usage",
    { allocation_id: "alloc-a", user_id: "user-a", period_start: 0, held_micros: -1 },
  ],
  ["quota_holds unknown kind", "quota_holds", hold({ kind: "speech" })],
  ["quota_holds negative amount", "quota_holds", hold({ amount_micros: -1 })],
  ["quota_holds amount above 1e12", "quota_holds", hold({ amount_micros: 1000000000001 })],
  ["quota_holds unknown state", "quota_holds", hold({ state: "pending" })],
  ["quota_holds negative settled", "quota_holds", hold({ settled_micros: -1 })],
  ["quota_holds unknown cost basis", "quota_holds", hold({ cost_basis: "guess" })],
  ["quota_holds negative sequence", "quota_holds", hold({ seq: -1 })],
  [
    "quota_audit unknown action",
    "quota_audit",
    {
      id: "audit-bad",
      organization_id: "org-a",
      tenant_id: "tenant-a",
      actor_user_id: "user-a",
      action: "quota.unknown",
      at: 1,
    },
  ],
];

describe("ensureQuotaTables", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates every quota table with its exact column set, and a repeated run changes nothing", () => {
    ensureQuotaTables(sqlite);
    ensureQuotaTables(sqlite);
    expect([...QUOTA_TABLES].sort()).toEqual(Object.keys(EXPECTED_COLUMNS).sort());
    for (const table of QUOTA_TABLES) {
      expect(columnsOf(sqlite, table), table).toEqual(EXPECTED_COLUMNS[table]);
    }
    expect(countAll(sqlite, "quota_allocations")).toBe(2);
  });

  it("keeps the live-slot indexes partial and unique, and the group name index unique", () => {
    const allocationIndexes = indexesOf(sqlite, "quota_allocations");
    expect(allocationIndexes.find((index) => index.name === "quota_allocations_live_everyone")).toMatchObject({
      unique: 1,
      partial: 1,
    });
    expect(allocationIndexes.find((index) => index.name === "quota_allocations_live_admins")).toMatchObject({
      unique: 1,
      partial: 1,
    });
    expect(indexesOf(sqlite, "company_groups").find((index) => index.name === "company_groups_org_name")).toMatchObject(
      {
        unique: 1,
      },
    );
    expect(indexesOf(sqlite, "tenant_usage").find((index) => index.name === "tenant_usage_hold_idx")).toMatchObject({
      unique: 1,
      partial: 1,
    });
  });

  it("installs every tenant, membership, allocation and removal guard by name", () => {
    expect(triggerNames(sqlite)).toEqual(expect.arrayContaining(GUARD_TRIGGERS));
  });

  it("adds the tenant_usage columns to a ledger that predates them, once", () => {
    sqlite.exec("DROP TRIGGER tenant_usage_allocation_insert_guard");
    sqlite.exec("DROP TRIGGER tenant_usage_allocation_update_guard");
    sqlite.exec("DROP INDEX tenant_usage_hold_idx");
    for (const column of TENANT_USAGE_QUOTA_COLUMNS) {
      sqlite.exec(`ALTER TABLE tenant_usage DROP COLUMN ${column}`);
    }
    expect(columnsOf(sqlite, "tenant_usage")).not.toEqual(expect.arrayContaining(TENANT_USAGE_QUOTA_COLUMNS));

    ensureQuotaTables(sqlite);
    ensureQuotaTables(sqlite);

    const columns = columnsOf(sqlite, "tenant_usage");
    expect(columns).toEqual(expect.arrayContaining(TENANT_USAGE_QUOTA_COLUMNS));
    expect(columns.filter((name) => name === "hold_id")).toEqual(["hold_id"]);
    expect(indexesOf(sqlite, "tenant_usage").map((index) => index.name)).toContain("tenant_usage_hold_idx");
    expect(triggerNames(sqlite)).toEqual(
      expect.arrayContaining(["tenant_usage_allocation_insert_guard", "tenant_usage_allocation_update_guard"]),
    );
  });

  it("fills the documented defaults when a row names only its key columns", () => {
    insertRow(sqlite, "company_quota_settings", { organization_id: "org-b", tenant_id: "tenant-b" });
    expect(
      sqlite
        .prepare(
          "SELECT enabled, version, company_cap_micros FROM company_quota_settings WHERE organization_id = 'org-b'",
        )
        .get(),
    ).toEqual({ enabled: 0, version: 1, company_cap_micros: null });

    insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-min", scope_kind: "groups" }));
    expect(
      sqlite
        .prepare(
          "SELECT spent_micros, held_micros, models_mode, priority, status, version, per_person_limit_micros, period_start, gateway_token_id FROM quota_allocations WHERE id = 'alloc-min'",
        )
        .get(),
    ).toEqual({
      spent_micros: 0,
      held_micros: 0,
      models_mode: "all",
      priority: 0,
      status: "active",
      version: 1,
      per_person_limit_micros: null,
      period_start: null,
      gateway_token_id: null,
    });

    insertRow(sqlite, "quota_holds", hold({ id: "hold-min" }));
    expect(
      sqlite
        .prepare("SELECT state, settled_micros, cost_basis, closed_at FROM quota_holds WHERE id = 'hold-min'")
        .get(),
    ).toEqual({
      state: "open",
      settled_micros: null,
      cost_basis: null,
      closed_at: null,
    });
  });

  it("accepts the edge values 0 and 1000000000000 and refuses one above", () => {
    insertRow(
      sqlite,
      "quota_allocations",
      allocation({ id: "alloc-zero", limit_micros: 0, per_person_limit_micros: 0 }),
    );
    insertRow(
      sqlite,
      "quota_allocations",
      allocation({ id: "alloc-max", scope_kind: "people", limit_micros: 1000000000000 }),
    );
    expect(() =>
      insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-over", limit_micros: 1000000000001 })),
    ).toThrow(/CHECK constraint failed/);
  });

  it("accepts every audit action the list names", () => {
    QUOTA_AUDIT_ACTIONS.forEach((action, index) => {
      insertRow(sqlite, "quota_audit", {
        id: `audit-${index}`,
        organization_id: "org-a",
        tenant_id: "tenant-a",
        actor_user_id: "user-a",
        action,
        at: index,
      });
    });
    expect(countAll(sqlite, "quota_audit")).toBe(QUOTA_AUDIT_ACTIONS.length);
  });

  it("allows one tenant_usage row per hold and any number without one", () => {
    insertRow(sqlite, "tenant_usage", {
      id: "usage-1",
      tenant_id: "tenant-a",
      organization_id: "org-a",
      mode: "chat",
      model: "gpt-4o",
      unit: "token",
      quantity: 1,
      at: 1,
      hold_id: "hold-1",
    });
    expect(() =>
      insertRow(sqlite, "tenant_usage", {
        id: "usage-2",
        tenant_id: "tenant-a",
        organization_id: "org-a",
        mode: "chat",
        model: "gpt-4o",
        unit: "token",
        quantity: 1,
        at: 1,
        hold_id: "hold-1",
      }),
    ).toThrow(/UNIQUE constraint failed/);
    insertRow(sqlite, "tenant_usage", {
      id: "usage-3",
      tenant_id: "tenant-a",
      organization_id: "org-a",
      mode: "chat",
      model: "gpt-4o",
      unit: "token",
      quantity: 1,
      at: 1,
    });
    insertRow(sqlite, "tenant_usage", {
      id: "usage-4",
      tenant_id: "tenant-a",
      organization_id: "org-a",
      mode: "chat",
      model: "gpt-4o",
      unit: "token",
      quantity: 1,
      at: 1,
    });
    expect(countWhere(sqlite, "tenant_usage", "hold_id IS NULL")).toBe(2);
  });
});

describe("CHECK constraints refuse a bad value", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  it.each(BAD_ROWS)("refuses %s", (_label, table, row) => {
    expect(() => insertRow(sqlite, table, row)).toThrow(/CHECK constraint failed/);
  });
});

describe("partial unique indexes on live allocations and group names", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("refuses a second live everyone allocation in one company", () => {
    expect(() =>
      insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-two", scope_kind: "everyone" })),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("counts a paused everyone allocation as live", () => {
    sqlite.prepare("UPDATE quota_allocations SET status = 'paused' WHERE id = 'alloc-a'").run();
    expect(() =>
      insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-two", scope_kind: "everyone" })),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("frees the everyone slot once the live allocation is archived, and takes it again", () => {
    sqlite.prepare("UPDATE quota_allocations SET status = 'archived' WHERE id = 'alloc-a'").run();
    insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-two", scope_kind: "everyone" }));
    expect(() =>
      insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-three", scope_kind: "everyone" })),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("applies the same rule to admins, independently of everyone", () => {
    insertRow(sqlite, "quota_allocations", allocation({ id: "admin-1", scope_kind: "admins" }));
    expect(() => insertRow(sqlite, "quota_allocations", allocation({ id: "admin-2", scope_kind: "admins" }))).toThrow(
      /UNIQUE constraint failed/,
    );
    sqlite.prepare("UPDATE quota_allocations SET status = 'archived' WHERE id = 'admin-1'").run();
    expect(() =>
      insertRow(sqlite, "quota_allocations", allocation({ id: "admin-2", scope_kind: "admins" })),
    ).not.toThrow();
  });

  it("does not limit groups or people allocations, and does not limit the number of companies", () => {
    insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-g1", scope_kind: "groups" }));
    insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-g2", scope_kind: "groups" }));
    insertRow(sqlite, "quota_allocations", allocation({ id: "alloc-p1", scope_kind: "people" }));
    expect(countWhere(sqlite, "quota_allocations", "scope_kind = 'everyone' AND status <> 'archived'")).toBe(2);
  });

  it("refuses a second group name in one company whatever its case, and lets each company keep its own", () => {
    expect(() =>
      insertRow(sqlite, "company_groups", {
        id: "group-a2",
        organization_id: "org-a",
        tenant_id: "tenant-a",
        name: "FINANCE",
        created_by: "user-a",
        created_at: 1,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertRow(sqlite, "company_groups", {
        id: "group-b2",
        organization_id: "org-b",
        tenant_id: "tenant-b",
        name: "finance",
        created_by: "user-b",
        created_at: 1,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    insertRow(sqlite, "company_groups", {
      id: "group-a3",
      organization_id: "org-a",
      tenant_id: "tenant-a",
      name: "Tax",
      created_by: "user-a",
      created_at: 1,
    });
    expect(countWhere(sqlite, "company_groups", "lower(name) = 'finance'")).toBe(2);
  });
});

describe("a fresh local desk", () => {
  it("gets every quota table through ensureSchema, and its tenant_usage writes keep working with the new columns null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quota-schema-"));
    const desk = new Database(path.join(dir, "agentforge.sqlite"));
    try {
      ensureSchema(desk);
      const tables = (
        desk.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([...QUOTA_TABLES]));
      expect(countAll(desk, "tenants")).toBe(1);
      insertRow(desk, "organizations", {
        id: "quota-local-org",
        tenant_id: "local-tenant",
        name: "Local",
        slug: "quota-local-org",
        industry_pack: "generic",
        created_at: 1,
      });
      insertRow(desk, "tenant_usage", {
        id: "local-usage",
        tenant_id: "local-tenant",
        organization_id: "quota-local-org",
        mode: "chat",
        model: "gpt-4o",
        unit: "token",
        quantity: 1,
        at: 1,
      });
      expect(
        desk
          .prepare(
            "SELECT allocation_id, purpose, hold_id, agent_id, project_id FROM tenant_usage WHERE id = 'local-usage'",
          )
          .get(),
      ).toEqual({ allocation_id: null, purpose: null, hold_id: null, agent_id: null, project_id: null });
      expect(countAll(desk, "quota_allocations")).toBe(0);
    } finally {
      desk.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
