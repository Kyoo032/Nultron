import Database from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { QUOTA_TABLES } from "./quota-schema";
import {
  companyGroupMembers,
  companyGroups,
  companyQuotaSettings,
  quotaAllocationModels,
  quotaAllocations,
  quotaAssignments,
  quotaAudit,
  quotaHolds,
  quotaPersonUsage,
  tenantUsage,
} from "./schema";

type PragmaColumn = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

const TABLES: Record<(typeof QUOTA_TABLES)[number], SQLiteTable> = {
  company_quota_settings: companyQuotaSettings,
  company_groups: companyGroups,
  company_group_members: companyGroupMembers,
  quota_allocations: quotaAllocations,
  quota_allocation_models: quotaAllocationModels,
  quota_assignments: quotaAssignments,
  quota_person_usage: quotaPersonUsage,
  quota_holds: quotaHolds,
  quota_audit: quotaAudit,
};

const TENANT_USAGE_QUOTA_COLUMNS = ["allocation_id", "purpose", "hold_id", "agent_id", "project_id"];

function pragma(sqlite: Database.Database, table: string): PragmaColumn[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as PragmaColumn[];
}

function compare(sqlite: Database.Database, table: SQLiteTable, only?: readonly string[]): void {
  const config = getTableConfig(table);
  const actual = pragma(sqlite, config.name).filter((column) => !only || only.includes(column.name));
  const compositeKey = new Set(config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)));
  const declared = config.columns.filter((column) => !only || only.includes(column.name));
  expect(declared.map((column) => column.name)).toEqual(actual.map((column) => column.name));
  for (const column of declared) {
    const real = actual.find((candidate) => candidate.name === column.name);
    expect(real, column.name).toBeDefined();
    expect(column.getSQLType().toLowerCase(), `${config.name}.${column.name} type`).toBe(real?.type.toLowerCase());
    expect(column.notNull, `${config.name}.${column.name} not null`).toBe(real?.notnull === 1);
    expect(column.hasDefault && column.default !== undefined, `${config.name}.${column.name} default`).toBe(
      real?.dflt_value !== null,
    );
    expect(column.primary || compositeKey.has(column.name), `${config.name}.${column.name} key`).toBe(
      (real?.pk ?? 0) > 0,
    );
  }
}

describe("quota Drizzle definitions match the ensureSchema tables", () => {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);

  it("declares exactly the nine quota tables", () => {
    expect(Object.keys(TABLES).sort()).toEqual([...QUOTA_TABLES].sort());
    for (const [name, table] of Object.entries(TABLES)) {
      expect(getTableConfig(table).name).toBe(name);
    }
  });

  it.each(Object.entries(TABLES))("%s matches PRAGMA table_info", (_name, table) => {
    compare(sqlite, table);
  });

  it("declares the five tenant_usage columns the healer adds", () => {
    compare(sqlite, tenantUsage, TENANT_USAGE_QUOTA_COLUMNS);
    const tail = getTableConfig(tenantUsage)
      .columns.map((column) => column.name)
      .slice(-5);
    expect(tail).toEqual(TENANT_USAGE_QUOTA_COLUMNS);
  });

  it("declares every index the ensureSchema tables carry", () => {
    for (const [name, table] of Object.entries(TABLES)) {
      const declared = getTableConfig(table)
        .indexes.map((index) => index.config.name)
        .sort();
      const real = (sqlite.prepare(`PRAGMA index_list(${name})`).all() as Array<{ name: string; origin: string }>)
        .filter((index) => index.origin === "c")
        .map((index) => index.name)
        .sort();
      expect(declared, name).toEqual(real);
    }
  });
});
