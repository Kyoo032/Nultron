import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { QUOTA_TABLES } from "./quota-schema";
import { purgeTenantRows } from "./tenant-purge";

type Db = Database.Database;
type Row = Record<string, string | number | null>;

const TENANT_MISMATCH_ROWS: Array<[string, string, Row]> = [
  ["company_quota_settings", "company_quota_settings", { organization_id: "org-a", tenant_id: "tenant-b", enabled: 0 }],
  [
    "company_groups",
    "company_groups",
    {
      id: "group-x",
      organization_id: "org-a",
      tenant_id: "tenant-b",
      name: "Sales",
      created_by: "user-a",
      created_at: 1,
    },
  ],
  ["quota_allocations", "quota_allocations", allocation({ tenant_id: "tenant-b" })],
  ["quota_holds", "quota_holds", hold({ tenant_id: "tenant-b" })],
  [
    "quota_audit",
    "quota_audit",
    {
      id: "audit-x",
      organization_id: "org-a",
      tenant_id: "tenant-b",
      actor_user_id: "user-a",
      action: "quota.enable",
      at: 1,
    },
  ],
  [
    "quota_allocations for a company that does not exist",
    "quota_allocations",
    allocation({ organization_id: "org-missing" }),
  ],
];

function insertRow(sqlite: Db, table: string, row: Row): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
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

function seedLedger(sqlite: Db): void {
  insertRow(sqlite, "company_quota_settings", {
    organization_id: "org-a",
    tenant_id: "tenant-a",
    enabled: 1,
    company_cap_micros: 5000000,
  });
  insertRow(sqlite, "company_quota_settings", { organization_id: "org-b", tenant_id: "tenant-b", enabled: 1 });
  insertRow(sqlite, "company_group_members", {
    group_id: "group-b",
    user_id: "user-b",
    added_by: "user-b",
    added_at: 1,
  });
  insertRow(sqlite, "quota_allocation_models", { allocation_id: "alloc-a", model_id: "gpt-4o" });
  insertRow(sqlite, "quota_allocation_models", { allocation_id: "alloc-b", model_id: "gpt-4o" });
  insertRow(sqlite, "quota_assignments", { allocation_id: "alloc-a", subject_kind: "person", subject_id: "user-a" });
  insertRow(sqlite, "quota_assignments", { allocation_id: "alloc-a", subject_kind: "group", subject_id: "group-a" });
  insertRow(sqlite, "quota_assignments", { allocation_id: "alloc-b", subject_kind: "person", subject_id: "user-b" });
  insertRow(sqlite, "quota_person_usage", {
    allocation_id: "alloc-a",
    user_id: "user-a",
    period_start: 0,
    spent_micros: 10,
    held_micros: 0,
  });
  insertRow(sqlite, "quota_person_usage", {
    allocation_id: "alloc-b",
    user_id: "user-b",
    period_start: 0,
    spent_micros: 10,
    held_micros: 0,
  });
  insertRow(
    sqlite,
    "quota_holds",
    hold({ id: "hold-1", state: "settled", settled_micros: 10, cost_basis: "reported", closed_at: 2 }),
  );
  insertRow(
    sqlite,
    "quota_holds",
    hold({
      id: "hold-b",
      organization_id: "org-b",
      tenant_id: "tenant-b",
      allocation_id: "alloc-b",
      user_id: "user-b",
    }),
  );
  insertRow(sqlite, "quota_audit", {
    id: "audit-a",
    organization_id: "org-a",
    tenant_id: "tenant-a",
    actor_user_id: "user-a",
    action: "allocation.create",
    allocation_id: "alloc-a",
    detail: '{"allocation":"alloc-a"}',
    at: 1,
  });
  insertRow(sqlite, "quota_audit", {
    id: "audit-b",
    organization_id: "org-b",
    tenant_id: "tenant-b",
    actor_user_id: "user-b",
    action: "quota.enable",
    at: 1,
  });
  insertRow(sqlite, "tenant_usage", {
    id: "usage-1",
    tenant_id: "tenant-a",
    organization_id: "org-a",
    mode: "chat",
    model: "gpt-4o",
    unit: "token",
    quantity: 1,
    at: 1,
    allocation_id: "alloc-a",
    purpose: "work",
    hold_id: "hold-1",
    agent_id: "agent-1",
  });
  insertRow(sqlite, "tenant_usage", {
    id: "usage-b",
    tenant_id: "tenant-b",
    organization_id: "org-b",
    mode: "chat",
    model: "gpt-4o",
    unit: "token",
    quantity: 1,
    at: 1,
    allocation_id: "alloc-b",
    purpose: "work",
    hold_id: "hold-b",
  });
}

describe("tenant guard triggers", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  it.each(TENANT_MISMATCH_ROWS)("refuses a %s whose tenant is not its company's", (_label, table, row) => {
    expect(() => insertRow(sqlite, table, row)).toThrow("quota_tenant_mismatch");
  });

  it("refuses an update that moves a row to another tenant or another company", () => {
    expect(() =>
      sqlite.prepare("UPDATE quota_allocations SET tenant_id = 'tenant-b' WHERE id = 'alloc-a'").run(),
    ).toThrow("quota_tenant_mismatch");
    expect(() =>
      sqlite.prepare("UPDATE quota_allocations SET organization_id = 'org-b' WHERE id = 'alloc-a'").run(),
    ).toThrow("quota_tenant_mismatch");
    sqlite.prepare("UPDATE quota_allocations SET name = 'Renamed' WHERE id = 'alloc-a'").run();
    expect(sqlite.prepare("SELECT name FROM quota_allocations WHERE id = 'alloc-a'").get()).toEqual({
      name: "Renamed",
    });
  });
});

describe("a hold, an audit row or a usage row names an allocation of its own company", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
    seedLedger(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("refuses a hold whose allocation belongs to another company", () => {
    expect(() => insertRow(sqlite, "quota_holds", hold({ id: "hold-cross", allocation_id: "alloc-b" }))).toThrow(
      "quota_allocation_outside_organization",
    );
  });

  it("refuses a hold whose allocation does not exist, with the allocation message and not a foreign key one", () => {
    expect(() => insertRow(sqlite, "quota_holds", hold({ id: "hold-ghost", allocation_id: "alloc-missing" }))).toThrow(
      "quota_allocation_outside_organization",
    );
  });

  it("accepts a hold on an allocation of its own company", () => {
    expect(() => insertRow(sqlite, "quota_holds", hold({ id: "hold-same" }))).not.toThrow();
    expect(countWhere(sqlite, "quota_holds", "allocation_id = 'alloc-a'")).toBe(2);
  });

  it("refuses a hold re-pointed at another company's allocation, or moved into another company", () => {
    expect(() => sqlite.prepare("UPDATE quota_holds SET allocation_id = 'alloc-b' WHERE id = 'hold-1'").run()).toThrow(
      "quota_allocation_outside_organization",
    );
    expect(() =>
      sqlite
        .prepare("UPDATE quota_holds SET organization_id = 'org-a', tenant_id = 'tenant-a' WHERE id = 'hold-b'")
        .run(),
    ).toThrow("quota_allocation_outside_organization");
  });

  it("still lets a hold be settled, which touches neither the allocation nor the company", () => {
    expect(() => sqlite.prepare("UPDATE quota_holds SET state = 'released' WHERE id = 'hold-1'").run()).not.toThrow();
  });

  it("refuses an audit row that names another company's allocation, and takes one with no allocation", () => {
    expect(() =>
      insertRow(sqlite, "quota_audit", {
        id: "audit-cross",
        organization_id: "org-a",
        tenant_id: "tenant-a",
        actor_user_id: "user-a",
        action: "allocation.assign",
        allocation_id: "alloc-b",
        at: 2,
      }),
    ).toThrow("quota_allocation_outside_organization");
    expect(() =>
      insertRow(sqlite, "quota_audit", {
        id: "audit-plain",
        organization_id: "org-a",
        tenant_id: "tenant-a",
        actor_user_id: "user-a",
        action: "quota.enable",
        at: 2,
      }),
    ).not.toThrow();
    expect(() => sqlite.prepare("UPDATE quota_audit SET allocation_id = 'alloc-b' WHERE id = 'audit-a'").run()).toThrow(
      "quota_allocation_outside_organization",
    );
  });

  it("refuses a usage row that names another company's allocation, and takes a Personal row with none", () => {
    expect(() =>
      insertRow(sqlite, "tenant_usage", {
        id: "usage-cross",
        tenant_id: "tenant-a",
        organization_id: "org-a",
        mode: "chat",
        model: "gpt-4o",
        unit: "token",
        quantity: 1,
        at: 2,
        allocation_id: "alloc-b",
        purpose: "work",
        hold_id: "hold-cross-usage",
      }),
    ).toThrow("quota_allocation_outside_organization");
    expect(() =>
      insertRow(sqlite, "tenant_usage", {
        id: "usage-plain",
        tenant_id: "tenant-a",
        organization_id: "org-a",
        mode: "chat",
        model: "gpt-4o",
        unit: "token",
        quantity: 1,
        at: 2,
      }),
    ).not.toThrow();
    expect(() =>
      sqlite.prepare("UPDATE tenant_usage SET allocation_id = 'alloc-b' WHERE id = 'usage-1'").run(),
    ).toThrow("quota_allocation_outside_organization");
  });
});

describe("a spend row names a member of the allocation's company", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
    seedLedger(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("accepts a row for a member of the allocation's company", () => {
    expect(() =>
      insertRow(sqlite, "quota_person_usage", {
        allocation_id: "alloc-a",
        user_id: "user-a",
        period_start: 1,
        spent_micros: 0,
        held_micros: 0,
      }),
    ).not.toThrow();
  });

  it.each([
    ["a person from another company on this company's allocation", "alloc-a", "user-b"],
    ["a person with no membership on this company's allocation", "alloc-a", "user-x"],
    ["this company's person on another company's allocation", "alloc-b", "user-a"],
  ])("refuses %s", (_label, allocationId, userId) => {
    expect(() =>
      insertRow(sqlite, "quota_person_usage", { allocation_id: allocationId, user_id: userId, period_start: 1 }),
    ).toThrow("quota_subject_not_member");
  });

  it("refuses an update that moves a row to a person outside the company", () => {
    expect(() =>
      sqlite
        .prepare(
          "UPDATE quota_person_usage SET user_id = 'user-b' WHERE allocation_id = 'alloc-a' AND user_id = 'user-a'",
        )
        .run(),
    ).toThrow("quota_subject_not_member");
  });
});

describe("subject and membership guards", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("accepts a person who belongs to the allocation's company", () => {
    expect(() =>
      insertRow(sqlite, "quota_assignments", {
        allocation_id: "alloc-a",
        subject_kind: "person",
        subject_id: "user-a",
      }),
    ).not.toThrow();
  });

  it("accepts a group of the allocation's company", () => {
    expect(() =>
      insertRow(sqlite, "quota_assignments", {
        allocation_id: "alloc-a",
        subject_kind: "group",
        subject_id: "group-a",
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "a person from another company",
      { allocation_id: "alloc-a", subject_kind: "person", subject_id: "user-b" },
      "quota_subject_not_member",
    ],
    [
      "a person with no membership",
      { allocation_id: "alloc-a", subject_kind: "person", subject_id: "user-x" },
      "quota_subject_not_member",
    ],
    [
      "this company's person on another company's allocation",
      { allocation_id: "alloc-b", subject_kind: "person", subject_id: "user-a" },
      "quota_subject_not_member",
    ],
    [
      "a person on an allocation that does not exist",
      { allocation_id: "alloc-missing", subject_kind: "person", subject_id: "user-a" },
      "quota_subject_not_member",
    ],
    [
      "a group from another company",
      { allocation_id: "alloc-a", subject_kind: "group", subject_id: "group-b" },
      "quota_group_outside_organization",
    ],
    [
      "a group on an allocation that does not exist",
      { allocation_id: "alloc-missing", subject_kind: "group", subject_id: "group-a" },
      "quota_group_outside_organization",
    ],
  ])("refuses %s as an assignment", (_label, row, message) => {
    expect(() => insertRow(sqlite, "quota_assignments", row)).toThrow(message);
  });

  it("refuses an update that re-points an existing assignment outside the company", () => {
    insertRow(sqlite, "quota_assignments", { allocation_id: "alloc-a", subject_kind: "person", subject_id: "user-a" });
    expect(() =>
      sqlite
        .prepare(
          "UPDATE quota_assignments SET subject_id = 'user-b' WHERE allocation_id = 'alloc-a' AND subject_id = 'user-a'",
        )
        .run(),
    ).toThrow("quota_subject_not_member");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE quota_assignments SET subject_kind = 'group', subject_id = 'group-b' WHERE allocation_id = 'alloc-a' AND subject_id = 'user-a'",
        )
        .run(),
    ).toThrow("quota_group_outside_organization");
  });

  it("refuses a group member who is not in the group's company, and accepts one who is", () => {
    expect(() =>
      insertRow(sqlite, "company_group_members", {
        group_id: "group-a",
        user_id: "user-b",
        added_by: "user-a",
        added_at: 1,
      }),
    ).toThrow("quota_group_member_not_in_organization");
    expect(() =>
      insertRow(sqlite, "company_group_members", {
        group_id: "group-a",
        user_id: "user-x",
        added_by: "user-a",
        added_at: 1,
      }),
    ).toThrow("quota_group_member_not_in_organization");
    expect(() =>
      insertRow(sqlite, "company_group_members", {
        group_id: "group-b",
        user_id: "user-b",
        added_by: "user-b",
        added_at: 1,
      }),
    ).not.toThrow();
    expect(() =>
      sqlite.prepare("UPDATE company_group_members SET user_id = 'user-b' WHERE group_id = 'group-a'").run(),
    ).toThrow("quota_group_member_not_in_organization");
  });

  it("refuses a member of one company placed in the other company's group", () => {
    expect(() =>
      insertRow(sqlite, "company_group_members", {
        group_id: "group-b",
        user_id: "user-a",
        added_by: "user-b",
        added_at: 1,
      }),
    ).toThrow("quota_group_member_not_in_organization");
  });
});

describe("removing a member clears that person's places in that company", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
    seedLedger(sqlite);
    insertRow(sqlite, "organization_members", {
      id: "member-a-b",
      organization_id: "org-b",
      user_id: "user-a",
      role: "member",
    });
    insertRow(sqlite, "company_group_members", {
      group_id: "group-b",
      user_id: "user-a",
      added_by: "user-b",
      added_at: 1,
    });
    insertRow(sqlite, "quota_assignments", { allocation_id: "alloc-b", subject_kind: "person", subject_id: "user-a" });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("removes the person's group places and person assignments in that company, and nothing of another company", () => {
    sqlite.prepare("DELETE FROM organization_members WHERE id = 'member-a'").run();
    expect(countWhere(sqlite, "company_group_members", "user_id = 'user-a' AND group_id = 'group-a'")).toBe(0);
    expect(
      countWhere(
        sqlite,
        "quota_assignments",
        "subject_kind = 'person' AND subject_id = 'user-a' AND allocation_id = 'alloc-a'",
      ),
    ).toBe(0);
    expect(countWhere(sqlite, "company_group_members", "user_id = 'user-a' AND group_id = 'group-b'")).toBe(1);
    expect(
      countWhere(
        sqlite,
        "quota_assignments",
        "subject_kind = 'person' AND subject_id = 'user-a' AND allocation_id = 'alloc-b'",
      ),
    ).toBe(1);
    expect(countWhere(sqlite, "quota_assignments", "subject_kind = 'group' AND subject_id = 'group-a'")).toBe(1);
    expect(countWhere(sqlite, "quota_assignments", "subject_kind = 'person' AND subject_id = 'user-b'")).toBe(1);
    expect(countWhere(sqlite, "organization_members", "user_id = 'user-a'")).toBe(1);
  });

  it("keeps the removed person's spend ledger, and settle can still write that spend", () => {
    sqlite.prepare("DELETE FROM organization_members WHERE id = 'member-a'").run();
    expect(countWhere(sqlite, "quota_person_usage", "allocation_id = 'alloc-a' AND user_id = 'user-a'")).toBe(1);
    const changed = sqlite
      .prepare("UPDATE quota_person_usage SET spent_micros = 20 WHERE allocation_id = 'alloc-a' AND user_id = 'user-a'")
      .run();
    expect(changed.changes).toBe(1);
    expect(
      sqlite
        .prepare("SELECT spent_micros FROM quota_person_usage WHERE allocation_id = 'alloc-a' AND user_id = 'user-a'")
        .get(),
    ).toEqual({ spent_micros: 20 });
  });

  it("refuses the removed person a new group place, a new assignment or a new spend row in that company", () => {
    sqlite.prepare("DELETE FROM organization_members WHERE id = 'member-a'").run();
    expect(() =>
      insertRow(sqlite, "company_group_members", {
        group_id: "group-a",
        user_id: "user-a",
        added_by: "user-a",
        added_at: 2,
      }),
    ).toThrow("quota_group_member_not_in_organization");
    expect(() =>
      insertRow(sqlite, "quota_assignments", {
        allocation_id: "alloc-a",
        subject_kind: "person",
        subject_id: "user-a",
      }),
    ).toThrow("quota_subject_not_member");
    expect(() =>
      insertRow(sqlite, "quota_person_usage", {
        allocation_id: "alloc-a",
        user_id: "user-a",
        period_start: 1,
        spent_micros: 0,
        held_micros: 0,
      }),
    ).toThrow("quota_subject_not_member");
  });
});

describe("cascade from the company and a fresh local desk", () => {
  let sqlite: Db;

  beforeEach(() => {
    sqlite = openDb();
    seedLedger(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("removes every quota row of the erased company, leaves the other company's rows and keeps the spend ledger", () => {
    purgeTenantRows(sqlite, "tenant-a");
    const counts = Object.fromEntries(QUOTA_TABLES.map((table) => [table, countAll(sqlite, table)]));
    expect(counts).toEqual(Object.fromEntries(QUOTA_TABLES.map((table) => [table, 1])));
    expect(countWhere(sqlite, "quota_allocations", "organization_id = 'org-a'")).toBe(0);
    expect(countWhere(sqlite, "quota_holds", "id = 'hold-1'")).toBe(0);
    expect(sqlite.prepare("SELECT allocation_id, hold_id FROM tenant_usage WHERE id = 'usage-1'").get()).toEqual({
      allocation_id: "alloc-a",
      hold_id: "hold-1",
    });
    expect(sqlite.prepare("SELECT allocation_id, hold_id FROM tenant_usage WHERE id = 'usage-b'").get()).toEqual({
      allocation_id: "alloc-b",
      hold_id: "hold-b",
    });
  });

  it("is a no-op on a second purge of the same company", () => {
    purgeTenantRows(sqlite, "tenant-a");
    const again = purgeTenantRows(sqlite, "tenant-a");
    expect(again.rowsDeleted).toBe(0);
    expect(countAll(sqlite, "quota_allocations")).toBe(1);
  });
});
