import { sql } from "@agentforge/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAllocation,
  createGroup,
  deleteGroup,
  getAllocation,
  getPersonUsage,
  listAllocations,
  placeHold,
  releaseHold,
  resolvePayerAllocation,
  setAllocationStatus,
  setGroupMembers,
  settleHold,
  type QuotaScope,
} from "./store";

const S: QuotaScope = { tenantId: "q4p-tenant", organizationId: "q4p-org" };
const DAY = 86_400_000;
const JAN = Date.UTC(2026, 0, 10, 12);
const FEB = Date.UTC(2026, 1, 10, 12);
const BOOT = "boot-p";

function exec(statement: string, ...values: Array<string | number | null>): void {
  sql.prepare(statement).run(...values);
}

function pool(id: string): { spent: number; held: number; periodStart: number | null } {
  return sql
    .prepare(
      "SELECT spent_micros AS spent, held_micros AS held, period_start AS periodStart FROM quota_allocations WHERE id = ?",
    )
    .get(id) as { spent: number; held: number; periodStart: number | null };
}

function ask(userId: string, amountMicros: number, now: number, runId = `r-${amountMicros}-${now}`, ttlMs = 60_000) {
  return placeHold(S, { userId, runId, seq: 0, kind: "text", model: "m", amountMicros, ttlMs, bootId: BOOT, now });
}

beforeAll(() => {
  exec(
    "INSERT INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', 1)",
    S.tenantId,
    S.tenantId,
    S.tenantId,
  );
  exec(
    "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, 'p', 'p', 'generic', 1)",
    S.organizationId,
    S.tenantId,
  );
  for (const [id, role] of [
    ["q4p-owner", "owner"],
    ["q4p-admin", "admin"],
    ["q4p-ann", "member"],
    ["q4p-bob", "member"],
  ] as const) {
    exec(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)",
      id,
      id,
      `${id}@q4.invalid`,
    );
    exec(
      "INSERT INTO organization_members (id, organization_id, user_id, role) VALUES (?, ?, ?, ?)",
      `m-${id}`,
      S.organizationId,
      id,
      role,
    );
  }
});

describe("per-person ceiling", () => {
  it("stops one person at the ceiling while the pool still has room", () => {
    const shared = createAllocation(
      S,
      "q4p-owner",
      { name: "Shared", scopeKind: "everyone", limitMicros: 10_000, perPersonLimitMicros: 100, periodKind: "lifetime" },
      JAN,
    );
    const first = ask("q4p-ann", 60, JAN);
    expect(first.ok).toBe(true);
    expect(ask("q4p-ann", 41, JAN)).toMatchObject({ ok: false, code: "quota_exceeded", remainingMicros: 40 });
    if (first.ok) {
      settleHold(S, first.hold.id, { actualMicros: 60, costBasis: "reported", now: JAN });
    }
    expect(ask("q4p-ann", 41, JAN)).toMatchObject({ ok: false, code: "quota_exceeded", remainingMicros: 40 });
    const bob = ask("q4p-bob", 100, JAN);
    expect(bob.ok).toBe(true);
    if (bob.ok) {
      releaseHold(S, bob.hold.id);
    }
    expect(getPersonUsage(S, "q4p-ann", JAN)).toEqual([
      expect.objectContaining({ allocationId: shared.id, spentMicros: 60, heldMicros: 0 }),
    ]);
    expect(pool(shared.id)).toMatchObject({ spent: 60, held: 0 });
    setAllocationStatus(S, "q4p-owner", shared.id, "archived", JAN);
  });
});

describe("monthly period", () => {
  it("zeroes spent when the month rolls over, keeps held, and lets a late settle stay in its own month", () => {
    const monthly = createAllocation(
      S,
      "q4p-owner",
      { name: "Monthly", scopeKind: "everyone", limitMicros: 1000, periodKind: "monthly" },
      JAN,
    );
    const january = ask("q4p-ann", 900, JAN);
    if (!january.ok) {
      throw new Error("expected a hold");
    }
    settleHold(S, january.hold.id, { actualMicros: 900, costBasis: "reported", now: JAN });
    expect(pool(monthly.id).spent).toBe(900);
    expect(ask("q4p-ann", 200, JAN + DAY)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(getAllocation(S, monthly.id, FEB)?.spentMicros).toBe(0);

    const carried = ask("q4p-bob", 100, Date.UTC(2026, 0, 31, 23), "r-carry", 20 * DAY);
    if (!carried.ok) {
      throw new Error("expected a hold");
    }
    const february = ask("q4p-ann", 800, FEB);
    expect(february.ok).toBe(true);
    expect(pool(monthly.id)).toMatchObject({ spent: 0, held: 900, periodStart: Date.UTC(2026, 1, 1) });
    settleHold(S, carried.hold.id, { actualMicros: 70, costBasis: "reported", now: FEB });
    expect(pool(monthly.id)).toMatchObject({ spent: 0, held: 800 });
    if (february.ok) {
      settleHold(S, february.hold.id, { actualMicros: 800, costBasis: "reported", now: FEB });
    }
    expect(pool(monthly.id)).toMatchObject({ spent: 800, held: 0 });
    expect(getPersonUsage(S, "q4p-ann", FEB).filter((row) => row.allocationId === monthly.id)).toEqual([
      expect.objectContaining({ spentMicros: 800, periodStart: Date.UTC(2026, 1, 1) }),
    ]);
    setAllocationStatus(S, "q4p-owner", monthly.id, "archived", FEB);
  });
});

describe("resolution inside the store", () => {
  it("prefers the most specific allocation and does not spill into a broader pool", () => {
    const group = createGroup(S, "q4p-owner", "Team", FEB);
    setGroupMembers(S, "q4p-owner", group.id, ["q4p-ann"], FEB);
    const broad = createAllocation(
      S,
      "q4p-owner",
      { name: "All", scopeKind: "everyone", limitMicros: 5000, periodKind: "lifetime" },
      FEB,
    );
    const admins = createAllocation(
      S,
      "q4p-owner",
      { name: "Admins", scopeKind: "admins", limitMicros: 700, periodKind: "lifetime" },
      FEB,
    );
    const team = createAllocation(
      S,
      "q4p-owner",
      { name: "Team pool", scopeKind: "groups", limitMicros: 50, periodKind: "lifetime", assignedGroupIds: [group.id] },
      FEB,
    );
    expect(resolvePayerAllocation(S, "q4p-ann", FEB).resolution).toMatchObject({
      ok: true,
      allocation: { id: team.id },
    });
    expect(resolvePayerAllocation(S, "q4p-bob", FEB).resolution).toMatchObject({
      ok: true,
      allocation: { id: broad.id },
    });
    expect(resolvePayerAllocation(S, "q4p-admin", FEB).resolution).toMatchObject({
      ok: true,
      allocation: { id: admins.id },
    });
    expect(ask("q4p-ann", 51, FEB, "r-nospill")).toMatchObject({
      ok: false,
      code: "quota_exceeded",
      remainingMicros: 50,
    });
    expect(listAllocations(S, { now: FEB }).find((entry) => entry.id === broad.id)).toMatchObject({ heldMicros: 0 });
    deleteGroup(S, "q4p-owner", group.id, FEB);
    expect(resolvePayerAllocation(S, "q4p-ann", FEB).resolution).toMatchObject({
      ok: true,
      allocation: { id: broad.id },
    });
  });
});
