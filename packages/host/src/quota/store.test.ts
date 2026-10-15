import { sql } from "@agentforge/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAllocation,
  createGroup,
  deleteGroup,
  getAllocation,
  getHold,
  getOrganizationUsage,
  getPersonUsage,
  getQuotaSettings,
  isQuotaEnabled,
  ledgerSpentMicros,
  listAllocations,
  listAudit,
  listGroups,
  placeHold,
  QuotaStoreError,
  releaseHold,
  setAllocationStatus,
  setCompanyCap,
  setGroupMembers,
  setQuotaEnabled,
  settleHold,
  sweepExpiredHolds,
  sweepStaleBootHolds,
  updateAllocation,
  type PlaceHoldInput,
  type QuotaScope,
} from "./store";

const A: QuotaScope = { tenantId: "q4-tenant-a", organizationId: "q4-org-a" };
const B: QuotaScope = { tenantId: "q4-tenant-b", organizationId: "q4-org-b" };
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60_000;
const BOOT = "boot-1";

function exec(statement: string, ...values: Array<string | number | null>): void {
  sql.prepare(statement).run(...values);
}

function seed(): void {
  for (const scope of [A, B]) {
    exec(
      "INSERT INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', 1)",
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
    );
    exec(
      "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, ?, ?, 'generic', 1)",
      scope.organizationId,
      scope.tenantId,
      scope.organizationId,
      scope.organizationId,
    );
  }
  const people: Array<[string, QuotaScope, string]> = [
    ["q4-owner-a", A, "owner"],
    ["q4-admin-a", A, "admin"],
    ["q4-ann-a", A, "member"],
    ["q4-bob-a", A, "member"],
    ["q4-cy-a", A, "member"],
    ["q4-owner-b", B, "owner"],
    ["q4-ann-b", B, "member"],
  ];
  for (const [id, scope, role] of people) {
    exec(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 1, 1)",
      id,
      id,
      `${id}@q4.invalid`,
    );
    exec(
      "INSERT INTO organization_members (id, organization_id, user_id, role) VALUES (?, ?, ?, ?)",
      `m-${id}`,
      scope.organizationId,
      id,
      role,
    );
  }
  exec(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('q4-outsider', 'o', 'o@q4.invalid', 0, 1, 1)",
  );
}

function hold(overrides: Partial<PlaceHoldInput> = {}): PlaceHoldInput {
  return {
    userId: "q4-ann-a",
    runId: "run-1",
    seq: 0,
    kind: "text",
    model: "gpt-4o",
    amountMicros: 100,
    ttlMs: 10 * MINUTE,
    bootId: BOOT,
    now: T0,
    ...overrides,
  };
}

function counters(allocationId: string): { spent: number; held: number } {
  const row = sql
    .prepare("SELECT spent_micros AS spent, held_micros AS held FROM quota_allocations WHERE id = ?")
    .get(allocationId) as {
    spent: number;
    held: number;
  };
  return row;
}

function checkInvariants(scope: QuotaScope): void {
  for (const allocation of listAllocations(scope, { includeArchived: true, now: T0 })) {
    const open = sql
      .prepare(
        "SELECT COALESCE(SUM(amount_micros), 0) AS n FROM quota_holds WHERE allocation_id = ? AND state = 'open'",
      )
      .get(allocation.id) as { n: number };
    expect(counters(allocation.id).held, `held of ${allocation.name}`).toBe(open.n);
    const personHeld = sql
      .prepare("SELECT COALESCE(SUM(held_micros), 0) AS n FROM quota_person_usage WHERE allocation_id = ?")
      .get(allocation.id) as { n: number };
    expect(personHeld.n, `person held of ${allocation.name}`).toBe(open.n);
    const charged = sql
      .prepare(
        "SELECT COALESCE(SUM(settled_micros), 0) AS n FROM quota_holds WHERE allocation_id = ? AND state IN ('settled', 'expired')",
      )
      .get(allocation.id) as { n: number };
    expect(counters(allocation.id).spent, `spent of ${allocation.name}`).toBe(charged.n);
    const personSpent = sql
      .prepare("SELECT COALESCE(SUM(spent_micros), 0) AS n FROM quota_person_usage WHERE allocation_id = ?")
      .get(allocation.id) as { n: number };
    expect(personSpent.n, `person spent of ${allocation.name}`).toBe(charged.n);
  }
}

function everyone(
  scope: QuotaScope,
  limitMicros = 1000,
  overrides: Parameters<typeof createAllocation>[2] extends infer T ? Partial<T> : never = {},
) {
  return createAllocation(
    scope,
    scope === A ? "q4-owner-a" : "q4-owner-b",
    { name: "Everyone", scopeKind: "everyone", limitMicros, periodKind: "lifetime", ...overrides },
    T0,
  );
}

beforeAll(seed);

describe("scope", () => {
  it("refuses a scope whose organization is not in that tenant", () => {
    const forged: QuotaScope = { tenantId: B.tenantId, organizationId: A.organizationId };
    expect(() => getQuotaSettings(forged)).toThrowError(QuotaStoreError);
    expect(() => listAllocations(forged)).toThrow("organization");
    expect(() => getPersonUsage(forged, "q4-ann-a")).toThrow("organization");
    expect(() => placeHold(forged, hold())).toThrow("organization");
  });
});

describe("settings", () => {
  it("defaults to disabled and refuses to enable without a live default allocation", () => {
    expect(getQuotaSettings(A)).toMatchObject({ enabled: false, companyCapMicros: null });
    expect(isQuotaEnabled(A)).toBe(false);
    expect(() => setQuotaEnabled(A, "q4-owner-a", true, T0)).toThrowError(
      expect.objectContaining({ code: "quota_needs_default" }),
    );
    expect(getQuotaSettings(A).enabled).toBe(false);
  });

  it("enables with a default, audits, and stays off for the other tenant", () => {
    const base = everyone(A, 1000);
    const settings = setQuotaEnabled(A, "q4-owner-a", true, T0);
    expect(settings).toMatchObject({ enabled: true, enabledBy: "q4-owner-a", enabledAt: T0 });
    expect(isQuotaEnabled(B)).toBe(false);
    expect(listAudit(A).map((row) => row.action)).toEqual(
      expect.arrayContaining(["allocation.create", "quota.enable"]),
    );
    expect(listAudit(B)).toEqual([]);
    setAllocationStatus(A, "q4-owner-a", base.id, "archived", T0);
    setQuotaEnabled(A, "q4-owner-a", false, T0);
    expect(isQuotaEnabled(A)).toBe(false);
  });

  it("sets and clears the company cap with a before/after audit, and refuses a cap below live limits", () => {
    const live = everyone(B, 400);
    expect(() => setCompanyCap(B, "q4-owner-b", 300, T0)).toThrowError(
      expect.objectContaining({ code: "exceeds_company_cap" }),
    );
    expect(setCompanyCap(B, "q4-owner-b", 500, T0).companyCapMicros).toBe(500);
    expect(() =>
      createAllocation(
        B,
        "q4-owner-b",
        { name: "Extra", scopeKind: "groups", limitMicros: 200, periodKind: "lifetime" },
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: "exceeds_company_cap" }));
    expect(setCompanyCap(B, "q4-owner-b", null, T0).companyCapMicros).toBeNull();
    const cap = listAudit(B).find((row) => row.action === "quota.cap");
    expect(cap?.detail).toMatchObject({ afterMicros: null });
    setAllocationStatus(B, "q4-owner-b", live.id, "archived", T0);
  });

  it("rejects non-integer, negative and oversized money", () => {
    for (const bad of [1.5, -1, 1_000_000_000_001, Number.NaN]) {
      expect(() => setCompanyCap(A, "q4-owner-a", bad, T0)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
      expect(() => everyone(A, bad)).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
  });
});

describe("groups", () => {
  it("creates, fills, lists and deletes a group, auditing each step", () => {
    const group = createGroup(A, "q4-owner-a", "Finance", T0);
    expect(() => createGroup(A, "q4-owner-a", "FINANCE", T0)).toThrowError(
      expect.objectContaining({ code: "duplicate" }),
    );
    const filled = setGroupMembers(A, "q4-owner-a", group.id, ["q4-ann-a", "q4-bob-a"], T0);
    expect(filled.memberIds).toEqual(["q4-ann-a", "q4-bob-a"]);
    expect(setGroupMembers(A, "q4-owner-a", group.id, ["q4-bob-a"], T0).memberIds).toEqual(["q4-bob-a"]);
    expect(() => setGroupMembers(A, "q4-owner-a", group.id, ["q4-ann-b"], T0)).toThrowError(
      expect.objectContaining({ code: "subject_invalid" }),
    );
    expect(() => setGroupMembers(A, "q4-owner-a", group.id, ["q4-outsider"], T0)).toThrowError(
      expect.objectContaining({ code: "subject_invalid" }),
    );
    const actions = listAudit(A, 500).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["group.create", "group.member.add", "group.member.remove"]));
    deleteGroup(A, "q4-owner-a", group.id, T0);
    expect(listGroups(A).find((entry) => entry.id === group.id)).toBeUndefined();
    expect(listAudit(A, 500).map((row) => row.action)).toContain("group.delete");
  });

  it("keeps a company's groups invisible and untouchable to another company", () => {
    const group = createGroup(A, "q4-owner-a", "Hidden", T0);
    expect(listGroups(B).map((entry) => entry.id)).not.toContain(group.id);
    expect(() => setGroupMembers(B, "q4-owner-b", group.id, ["q4-ann-b"], T0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => deleteGroup(B, "q4-owner-b", group.id, T0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(listGroups(A).map((entry) => entry.id)).toContain(group.id);
  });

  it("drops a deleted group from every allocation that named it", () => {
    const group = createGroup(A, "q4-owner-a", "Temp", T0);
    const alloc = createAllocation(
      A,
      "q4-owner-a",
      { name: "Temp pool", scopeKind: "groups", limitMicros: 50, periodKind: "lifetime", assignedGroupIds: [group.id] },
      T0,
    );
    expect(alloc.assignedGroupIds).toEqual([group.id]);
    deleteGroup(A, "q4-owner-a", group.id, T0);
    expect(getAllocation(A, alloc.id, T0)?.assignedGroupIds).toEqual([]);
    setAllocationStatus(A, "q4-owner-a", alloc.id, "archived", T0);
  });
});

describe("allocations", () => {
  it("creates, updates under optimistic versioning, and audits before/after", () => {
    const created = createAllocation(
      A,
      "q4-owner-a",
      {
        name: "People",
        scopeKind: "people",
        limitMicros: 700,
        periodKind: "lifetime",
        modelsMode: "list",
        models: [" GPT-4o ", "gpt-4o", "Claude-3"],
        assignedPersonIds: ["q4-ann-a"],
      },
      T0,
    );
    expect(created).toMatchObject({ version: 1, models: ["claude-3", "gpt-4o"], assignedPersonIds: ["q4-ann-a"] });
    expect(() => updateAllocation(A, "q4-owner-a", created.id, 9, { limitMicros: 10 }, T0)).toThrowError(
      expect.objectContaining({ code: "version_conflict" }),
    );
    const updated = updateAllocation(
      A,
      "q4-owner-a",
      created.id,
      1,
      { limitMicros: 600, models: ["gpt-4o"], assignedPersonIds: ["q4-ann-a", "q4-bob-a"] },
      T0 + 1,
    );
    expect(updated).toMatchObject({
      version: 2,
      limitMicros: 600,
      models: ["gpt-4o"],
      assignedPersonIds: ["q4-ann-a", "q4-bob-a"],
    });
    const audit = listAudit(A, 500);
    const change = audit.find((row) => row.action === "allocation.update" && row.allocationId === created.id);
    expect(change?.detail).toMatchObject({
      limitMicros: { before: 700, after: 600 },
      models: { removed: ["claude-3"] },
    });
    expect(audit.map((row) => row.action)).toContain("allocation.assign");
    expect(updateAllocation(A, "q4-owner-a", created.id, 2, {}, T0)).toMatchObject({ version: 2 });
    expect(JSON.stringify(audit.map((row) => row.detail))).not.toContain("People");
    setAllocationStatus(A, "q4-owner-a", created.id, "archived", T0);
  });

  it("pauses, resumes and archives, and an archived allocation is final", () => {
    const alloc = createAllocation(
      A,
      "q4-owner-a",
      { name: "Life", scopeKind: "groups", limitMicros: 10, periodKind: "lifetime" },
      T0,
    );
    expect(setAllocationStatus(A, "q4-owner-a", alloc.id, "paused", T0).status).toBe("paused");
    expect(setAllocationStatus(A, "q4-owner-a", alloc.id, "active", T0).status).toBe("active");
    expect(setAllocationStatus(A, "q4-owner-a", alloc.id, "archived", T0).status).toBe("archived");
    expect(() => setAllocationStatus(A, "q4-owner-a", alloc.id, "active", T0)).toThrowError(
      expect.objectContaining({ code: "archived" }),
    );
    expect(() => updateAllocation(A, "q4-owner-a", alloc.id, 4, { priority: 1 }, T0)).toThrowError(
      expect.objectContaining({ code: "archived" }),
    );
    expect(listAllocations(A).map((entry) => entry.id)).not.toContain(alloc.id);
    expect(listAllocations(A, { includeArchived: true }).map((entry) => entry.id)).toContain(alloc.id);
    const actions = listAudit(A, 500)
      .filter((row) => row.allocationId === alloc.id)
      .map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["allocation.pause", "allocation.resume", "allocation.archive"]));
  });

  it("allows one live everyone allocation per company", () => {
    const first = everyone(B, 100);
    expect(() => everyone(B, 100)).toThrowError(expect.objectContaining({ code: "duplicate" }));
    setAllocationStatus(B, "q4-owner-b", first.id, "archived", T0);
  });

  it("refuses subjects from another company, a person on a groups allocation, and a per-person ceiling on people", () => {
    expect(() =>
      createAllocation(
        A,
        "q4-owner-a",
        { name: "x", scopeKind: "people", limitMicros: 1, periodKind: "lifetime", assignedPersonIds: ["q4-ann-b"] },
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: "subject_invalid" }));
    const foreign = createGroup(B, "q4-owner-b", "Foreign", T0);
    expect(() =>
      createAllocation(
        A,
        "q4-owner-a",
        { name: "x", scopeKind: "groups", limitMicros: 1, periodKind: "lifetime", assignedGroupIds: [foreign.id] },
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: "subject_invalid" }));
    expect(() =>
      createAllocation(
        A,
        "q4-owner-a",
        { name: "x", scopeKind: "groups", limitMicros: 1, periodKind: "lifetime", assignedPersonIds: ["q4-ann-a"] },
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() =>
      createAllocation(
        A,
        "q4-owner-a",
        { name: "x", scopeKind: "people", limitMicros: 1, perPersonLimitMicros: 1, periodKind: "lifetime" },
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    deleteGroup(B, "q4-owner-b", foreign.id, T0);
  });

  it("never lets one company read or change another company's allocations", () => {
    const alloc = createAllocation(
      A,
      "q4-owner-a",
      { name: "Secret", scopeKind: "groups", limitMicros: 77, periodKind: "lifetime" },
      T0,
    );
    expect(getAllocation(B, alloc.id, T0)).toBeNull();
    expect(listAllocations(B, { includeArchived: true }).map((entry) => entry.id)).not.toContain(alloc.id);
    expect(() => updateAllocation(B, "q4-owner-b", alloc.id, 1, { limitMicros: 1 }, T0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => setAllocationStatus(B, "q4-owner-b", alloc.id, "archived", T0)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(getAllocation(A, alloc.id, T0)).toMatchObject({ limitMicros: 77, status: "active", version: 1 });
    setAllocationStatus(A, "q4-owner-a", alloc.id, "archived", T0);
  });
});

describe("holds", () => {
  let pool: string;

  beforeAll(() => {
    for (const row of listAllocations(A)) {
      setAllocationStatus(A, "q4-owner-a", row.id, "archived", T0);
    }
    pool = everyone(A, 1000).id;
  });

  it("places, settles with ceil and a one-micro floor, and releases", () => {
    const first = placeHold(A, hold({ runId: "r-settle", amountMicros: 600 }));
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(counters(pool)).toEqual({ spent: 0, held: 600 });
    const settled = settleHold(A, first.hold.id, { actualMicros: 250.2, costBasis: "reported", now: T0 + 1 });
    expect(settled).toMatchObject({ ok: true, chargedMicros: 251, alreadyClosed: false });
    expect(counters(pool)).toEqual({ spent: 251, held: 0 });
    expect(settleHold(A, first.hold.id, { actualMicros: 999, costBasis: "reported" })).toMatchObject({
      ok: true,
      alreadyClosed: true,
      chargedMicros: 251,
    });
    expect(counters(pool)).toEqual({ spent: 251, held: 0 });

    const zero = placeHold(A, hold({ runId: "r-zero", amountMicros: 10 }));
    if (zero.ok) {
      expect(settleHold(A, zero.hold.id, { actualMicros: 0, costBasis: "estimated" })).toMatchObject({
        chargedMicros: 1,
      });
    }

    const second = placeHold(A, hold({ runId: "r-release", amountMicros: 100 }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(releaseHold(A, second.hold.id)).toMatchObject({ ok: true, alreadyClosed: false });
      expect(releaseHold(A, second.hold.id)).toMatchObject({ ok: true, alreadyClosed: true });
      expect(getHold(A, second.hold.id)).toMatchObject({ state: "released", settledMicros: null });
    }
    expect(counters(pool)).toEqual({ spent: 252, held: 0 });
    checkInvariants(A);
  });

  it("refuses the hold that would pass the limit and reports the room left", () => {
    const before = counters(pool);
    const room = 1000 - before.spent;
    const big = placeHold(A, hold({ runId: "r-big", amountMicros: room - 10 }));
    expect(big.ok).toBe(true);
    const over = placeHold(A, hold({ runId: "r-over", amountMicros: 11 }));
    expect(over).toMatchObject({ ok: false, code: "quota_exceeded", remainingMicros: 10, limitMicros: 1000 });
    expect(placeHold(A, hold({ runId: "r-fit", amountMicros: 10 })).ok).toBe(true);
    expect(counters(pool).held).toBe(room);
    for (const open of sql
      .prepare("SELECT id FROM quota_holds WHERE allocation_id = ? AND state = 'open'")
      .all(pool) as Array<{ id: string }>) {
      releaseHold(A, open.id);
    }
    expect(counters(pool).held).toBe(0);
    checkInvariants(A);
  });

  it("charges the actual cost even above the hold, and never lets a refused hold change a counter", () => {
    const start = counters(pool);
    const placed = placeHold(A, hold({ runId: "r-above", amountMicros: 5 }));
    if (!placed.ok) {
      throw new Error("expected a hold");
    }
    settleHold(A, placed.hold.id, { actualMicros: 50, costBasis: "list_price" });
    expect(counters(pool).spent).toBe(start.spent + 50);
    const refused = placeHold(A, hold({ runId: "r-refused", amountMicros: 1_000_000 }));
    expect(refused.ok).toBe(false);
    expect(counters(pool)).toEqual({ spent: start.spent + 50, held: 0 });
    checkInvariants(A);
  });

  it("refuses a person with no membership, an invalid amount, and a model outside the list", () => {
    expect(placeHold(A, hold({ userId: "q4-outsider" }))).toMatchObject({ ok: false, code: "quota_none" });
    expect(() => placeHold(A, hold({ amountMicros: 0 }))).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() => placeHold(A, hold({ amountMicros: 1.5 }))).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
    const limited = createAllocation(
      A,
      "q4-owner-a",
      {
        name: "Bob only",
        scopeKind: "people",
        limitMicros: 500,
        periodKind: "lifetime",
        modelsMode: "list",
        models: ["gpt-4o-mini"],
        assignedPersonIds: ["q4-bob-a"],
      },
      T0,
    );
    expect(placeHold(A, hold({ userId: "q4-bob-a", model: "GPT-4o" }))).toMatchObject({
      ok: false,
      code: "model_not_allowed",
    });
    const ok = placeHold(A, hold({ userId: "q4-bob-a", model: " GPT-4o-Mini ", runId: "r-bob" }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.hold.allocationId).toBe(limited.id);
      releaseHold(A, ok.hold.id);
    }
    setAllocationStatus(A, "q4-owner-a", limited.id, "paused", T0);
    expect(placeHold(A, hold({ userId: "q4-bob-a", runId: "r-paused" }))).toMatchObject({
      ok: false,
      code: "quota_paused",
    });
    setAllocationStatus(A, "q4-owner-a", limited.id, "archived", T0);
    expect(placeHold(A, hold({ userId: "q4-bob-a", runId: "r-back" })).ok).toBe(true);
    for (const open of sql.prepare("SELECT id FROM quota_holds WHERE state = 'open'").all() as Array<{ id: string }>) {
      releaseHold(A, open.id);
    }
    checkInvariants(A);
  });

  it("charges an expired hold at its full amount, then reconciles a late settle", () => {
    const before = counters(pool);
    const placed = placeHold(A, hold({ runId: "r-exp", amountMicros: 200, ttlMs: MINUTE }));
    if (!placed.ok) {
      throw new Error("expected a hold");
    }
    expect(sweepExpiredHolds(A, T0 + 2 * MINUTE)).toBe(1);
    expect(getHold(A, placed.hold.id)).toMatchObject({
      state: "expired",
      settledMicros: 200,
      costBasis: "expired_charge",
    });
    expect(counters(pool)).toEqual({ spent: before.spent + 200, held: 0 });
    const late = settleHold(A, placed.hold.id, { actualMicros: 120, costBasis: "reported", now: T0 + 3 * MINUTE });
    expect(late).toMatchObject({ ok: true, chargedMicros: 120, alreadyClosed: false });
    expect(counters(pool)).toEqual({ spent: before.spent + 120, held: 0 });
    expect(getHold(A, placed.hold.id)).toMatchObject({ state: "settled", settledMicros: 120 });
    checkInvariants(A);
  });

  it("sweeps expired holds lazily inside the next reservation", () => {
    const start = counters(pool);
    const stale = placeHold(A, hold({ runId: "r-lazy", amountMicros: 300, ttlMs: MINUTE }));
    expect(stale.ok).toBe(true);
    const next = placeHold(A, hold({ runId: "r-next", amountMicros: 10, now: T0 + 5 * MINUTE }));
    expect(next.ok).toBe(true);
    expect(counters(pool)).toEqual({ spent: start.spent + 300, held: 10 });
    if (next.ok) {
      releaseHold(A, next.hold.id);
    }
    checkInvariants(A);
  });

  it("charges holds left open by a previous boot", () => {
    const start = counters(pool);
    const stranded = placeHold(A, hold({ runId: "r-crash", amountMicros: 40, bootId: "boot-old" }));
    expect(stranded.ok).toBe(true);
    expect(sweepStaleBootHolds(BOOT, T0 + 1)).toBe(1);
    expect(counters(pool)).toEqual({ spent: start.spent + 40, held: 0 });
    checkInvariants(A);
  });

  it("caps open holds per payer", () => {
    const placed: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = placeHold(A, hold({ runId: `r-cap-${index}`, amountMicros: 1, maxOpenHolds: 3 }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        placed.push(result.hold.id);
      }
    }
    expect(placeHold(A, hold({ runId: "r-cap-x", amountMicros: 1, maxOpenHolds: 3 }))).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    expect(placeHold(A, hold({ userId: "q4-bob-a", runId: "r-cap-bob", amountMicros: 1, maxOpenHolds: 3 })).ok).toBe(
      true,
    );
    for (const open of sql.prepare("SELECT id FROM quota_holds WHERE state = 'open'").all() as Array<{ id: string }>) {
      releaseHold(A, open.id);
    }
    checkInvariants(A);
  });

  it("rolls the whole settle back when the in-transaction ledger write fails", () => {
    const placed = placeHold(A, hold({ runId: "r-ledger", amountMicros: 30 }));
    if (!placed.ok) {
      throw new Error("expected a hold");
    }
    const failed = settleHold(A, placed.hold.id, {
      actualMicros: 30,
      costBasis: "reported",
      inTransaction: () => {
        throw new Error("ledger write failed");
      },
    });
    expect(failed).toEqual({ ok: false, code: "failed" });
    expect(getHold(A, placed.hold.id)?.state).toBe("open");
    const spentBefore = counters(pool).spent;
    const ok = settleHold(A, placed.hold.id, {
      actualMicros: 30,
      costBasis: "reported",
      inTransaction: ({ hold: settled, chargedMicros }) => {
        exec(
          `INSERT INTO tenant_usage (id, tenant_id, organization_id, user_id, mode, model, unit, quantity, cost_usd_micros, at, allocation_id, purpose, hold_id)
           VALUES (?, ?, ?, ?, 'chat', 'gpt-4o', 'tokens', 1, ?, ?, ?, 'work', ?)`,
          "usage-q4-1",
          A.tenantId,
          A.organizationId,
          settled.userId,
          chargedMicros,
          T0,
          settled.allocationId,
          settled.id,
        );
      },
    });
    expect(ok).toMatchObject({ ok: true, chargedMicros: 30 });
    expect(counters(pool).spent).toBe(spentBefore + 30);
    expect(ledgerSpentMicros(A, pool)).toBe(30);
    expect(ledgerSpentMicros(B, pool)).toBe(0);
    checkInvariants(A);
  });

  it("answers an unknown or foreign hold id as not found and changes nothing", () => {
    const placed = placeHold(A, hold({ runId: "r-foreign", amountMicros: 20 }));
    if (!placed.ok) {
      throw new Error("expected a hold");
    }
    const snapshot = counters(pool);
    expect(settleHold(B, placed.hold.id, { actualMicros: 5, costBasis: "reported" })).toEqual({
      ok: false,
      code: "hold_not_found",
    });
    expect(releaseHold(B, placed.hold.id)).toEqual({ ok: false, code: "hold_not_found" });
    expect(getHold(B, placed.hold.id)).toBeNull();
    expect(settleHold(A, "no-such-hold", { actualMicros: 5, costBasis: "reported" })).toEqual({
      ok: false,
      code: "hold_not_found",
    });
    expect(counters(pool)).toEqual(snapshot);
    releaseHold(A, placed.hold.id);
  });

  it("refuses a user of another company even when the same company has an everyone pool", () => {
    expect(placeHold(A, hold({ userId: "q4-ann-b" }))).toMatchObject({ ok: false, code: "quota_none" });
    const bPool = everyone(B, 300);
    expect(placeHold(B, hold({ userId: "q4-ann-a" }))).toMatchObject({ ok: false, code: "quota_none" });
    const own = placeHold(B, hold({ userId: "q4-ann-b", runId: "r-b", amountMicros: 50 }));
    expect(own.ok).toBe(true);
    expect(counters(bPool.id)).toEqual({ spent: 0, held: 50 });
    expect(counters(pool).held).toBe(0);
    if (own.ok) {
      releaseHold(B, own.hold.id);
    }
  });
});

describe("per-person usage reads", () => {
  it("reads per-person usage, scoped to the company", () => {
    const usage = getPersonUsage(A, "q4-ann-a", T0);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.userId === "q4-ann-a")).toBe(true);
    expect(getPersonUsage(B, "q4-ann-a", T0)).toEqual([]);
    const org = getOrganizationUsage(A, T0);
    expect(org.allocations.length).toBeGreaterThan(0);
    expect(org.people.every((row) => ["q4-ann-a", "q4-bob-a", "q4-cy-a"].includes(row.userId))).toBe(true);
    const other = getOrganizationUsage(B, T0);
    expect(other.people.some((row) => row.userId === "q4-ann-a")).toBe(false);
  });
});
