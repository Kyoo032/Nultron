import { describe, expect, it } from "vitest";
import type { MembershipRole } from "../tenancy/types";
import { headroomMicros, modelAllowed, resolveAllocation } from "./resolve";
import type { AllocationView, Payer, Resolution } from "./types";

function allocation(overrides: Partial<AllocationView> & Pick<AllocationView, "id" | "scopeKind">): AllocationView {
  return {
    name: overrides.id,
    status: "active",
    limitMicros: 1_000_000,
    spentMicros: 0,
    heldMicros: 0,
    modelsMode: "all",
    models: [],
    priority: 0,
    createdAt: 1_000,
    assignedPersonIds: [],
    assignedGroupIds: [],
    ...overrides,
  };
}

function payer(userId: string, role: MembershipRole | null, groupIds: string[] = []): Payer {
  return { userId, role, groupIds };
}

function winnerId(result: Resolution): string {
  if (result.ok || result.code === "quota_paused") {
    return result.allocation.id;
  }
  throw new Error(`expected an allocation, got ${result.code}`);
}

const everyone = allocation({ id: "all", scopeKind: "everyone" });
const admins = allocation({ id: "adm", scopeKind: "admins" });
const group = allocation({ id: "grp", scopeKind: "groups", assignedGroupIds: ["team-a"] });
const person = allocation({ id: "me", scopeKind: "people", assignedPersonIds: ["u1"], priority: 9 });

describe("resolveAllocation rank", () => {
  const owner = payer("u1", "owner", ["team-a"]);

  it("ranks person over group over admins over everyone, and rank beats a worse priority", () => {
    expect(winnerId(resolveAllocation(owner, [everyone, admins, group, person]))).toBe("me");
    expect(winnerId(resolveAllocation(owner, [everyone, admins, group]))).toBe("grp");
    expect(winnerId(resolveAllocation(owner, [everyone, admins]))).toBe("adm");
    expect(winnerId(resolveAllocation(owner, [everyone]))).toBe("all");
  });

  it("is independent of input order", () => {
    expect(winnerId(resolveAllocation(owner, [person, group, admins, everyone]))).toBe("me");
    expect(winnerId(resolveAllocation(owner, [everyone, group, admins]))).toBe("grp");
  });

  it("ranks admins under the admins scope only for owner and admin roles", () => {
    expect(winnerId(resolveAllocation(payer("u2", "admin"), [everyone, admins]))).toBe("adm");
    expect(winnerId(resolveAllocation(payer("u3", "member"), [everyone, admins]))).toBe("all");
    expect(winnerId(resolveAllocation(payer("u4", "builder"), [everyone, admins]))).toBe("all");
  });

  it("matches a group allocation only when the payer is in one of its groups", () => {
    const other = allocation({ id: "grp-b", scopeKind: "groups", assignedGroupIds: ["team-b"] });
    expect(winnerId(resolveAllocation(payer("u5", "member", ["team-b"]), [other, everyone]))).toBe("grp-b");
    expect(winnerId(resolveAllocation(payer("u5", "member", ["team-c"]), [other, everyone]))).toBe("all");
  });

  it("does not match a person allocation for another person", () => {
    expect(winnerId(resolveAllocation(payer("u9", "member"), [person, everyone]))).toBe("all");
  });
});

describe("resolveAllocation ties inside one rank", () => {
  const member = payer("u7", "member", ["team-a"]);

  it("breaks a tie on priority ascending first", () => {
    const high = allocation({
      id: "g-high",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      priority: 2,
      createdAt: 1,
    });
    const low = allocation({
      id: "g-low",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      priority: 1,
      createdAt: 5,
    });
    expect(winnerId(resolveAllocation(member, [high, low]))).toBe("g-low");
  });

  it("breaks a priority tie on createdAt ascending", () => {
    const late = allocation({ id: "g-late", scopeKind: "groups", assignedGroupIds: ["team-a"], createdAt: 2_000 });
    const early = allocation({ id: "g-early", scopeKind: "groups", assignedGroupIds: ["team-a"], createdAt: 1_000 });
    expect(winnerId(resolveAllocation(member, [late, early]))).toBe("g-early");
  });

  it("breaks a priority and createdAt tie on id ascending", () => {
    const b = allocation({ id: "g-b", scopeKind: "groups", assignedGroupIds: ["team-a"], createdAt: 500 });
    const a = allocation({ id: "g-a", scopeKind: "groups", assignedGroupIds: ["team-a"], createdAt: 500 });
    expect(winnerId(resolveAllocation(member, [b, a]))).toBe("g-a");
  });

  it("applies the same tie-break to two person allocations that both match one person", () => {
    const p2 = allocation({ id: "p2", scopeKind: "people", assignedPersonIds: ["u7"], priority: 0, createdAt: 1 });
    const p1 = allocation({ id: "p1", scopeKind: "people", assignedPersonIds: ["u7"], priority: 0, createdAt: 1 });
    expect(winnerId(resolveAllocation(member, [p2, p1]))).toBe("p1");
  });
});

describe("resolveAllocation status and membership", () => {
  it("returns a paused winner as quota_paused and does not fall through to a broader pool", () => {
    const paused = { ...person, status: "paused" as const };
    const result = resolveAllocation(payer("u1", "member"), [paused, everyone]);
    expect(result).toEqual({ ok: false, code: "quota_paused", allocation: paused });
  });

  it("ignores archived allocations entirely", () => {
    const archived = { ...person, status: "archived" as const };
    expect(winnerId(resolveAllocation(payer("u1", "member"), [archived, everyone]))).toBe("all");
  });

  it("returns quota_none for a non-member even when a company-wide pool exists", () => {
    expect(resolveAllocation(payer("u8", null), [everyone, admins])).toEqual({ ok: false, code: "quota_none" });
    expect(resolveAllocation(payer("u1", null), [person])).toEqual({ ok: false, code: "quota_none" });
  });

  it("returns quota_none for a member who matches no allocation", () => {
    const teamB = allocation({ id: "grp-b", scopeKind: "groups", assignedGroupIds: ["team-b"] });
    expect(resolveAllocation(payer("u6", "member", ["team-a"]), [teamB])).toEqual({ ok: false, code: "quota_none" });
    expect(resolveAllocation(payer("u6", "member"), [])).toEqual({ ok: false, code: "quota_none" });
  });

  it("does not fall through to the everyone pool when the person's allocation is exhausted", () => {
    const exhausted = allocation({
      id: "me",
      scopeKind: "people",
      assignedPersonIds: ["u1"],
      limitMicros: 1_000,
      spentMicros: 900,
      heldMicros: 100,
    });
    const result = resolveAllocation(payer("u1", "member"), [exhausted, everyone]);
    expect(result).toEqual({ ok: true, allocation: exhausted });
    expect(headroomMicros(exhausted)).toBe(0);
  });
});

describe("modelAllowed", () => {
  it("allows any model in mode all, but never an empty model id", () => {
    const open = allocation({ id: "a", scopeKind: "everyone", modelsMode: "all" });
    expect(modelAllowed(open, "gpt-4o")).toBe(true);
    expect(modelAllowed(open, "  ")).toBe(false);
    expect(modelAllowed(open, "")).toBe(false);
  });

  it("compares trimmed and lower-cased ids in list mode", () => {
    const listed = allocation({
      id: "a",
      scopeKind: "everyone",
      modelsMode: "list",
      models: ["GPT-4o ", " claude-3-5-sonnet"],
    });
    expect(modelAllowed(listed, " gpt-4O")).toBe(true);
    expect(modelAllowed(listed, "CLAUDE-3-5-SONNET")).toBe(true);
    expect(modelAllowed(listed, "gemini-2.5-pro")).toBe(false);
  });

  it("allows nothing in list mode with an empty list", () => {
    const none = allocation({ id: "a", scopeKind: "everyone", modelsMode: "list", models: [] });
    expect(modelAllowed(none, "gpt-4o")).toBe(false);
  });
});

describe("headroomMicros", () => {
  it("is limit minus spent minus held", () => {
    const a = allocation({
      id: "a",
      scopeKind: "everyone",
      limitMicros: 1_000_000,
      spentMicros: 300_000,
      heldMicros: 200_000,
    });
    expect(headroomMicros(a)).toBe(500_000);
  });

  it("floors at zero when spent and held exceed the limit", () => {
    const over = allocation({ id: "a", scopeKind: "everyone", limitMicros: 1_000, spentMicros: 800, heldMicros: 400 });
    expect(headroomMicros(over)).toBe(0);
  });

  it("is zero, not NaN, for a corrupt limit", () => {
    const corrupt = allocation({ id: "a", scopeKind: "everyone", limitMicros: Number.NaN });
    expect(headroomMicros(corrupt)).toBe(0);
  });

  it("takes the smaller of the pool headroom and the person's own headroom when a per-person limit is set", () => {
    const pooled = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 1_000_000,
      spentMicros: 0,
      heldMicros: 0,
      perPersonLimitMicros: 200_000,
      personSpentMicros: 50_000,
      personHeldMicros: 25_000,
    });
    expect(headroomMicros(pooled)).toBe(125_000);
  });

  it("returns the pool headroom when the pool is the tighter of the two", () => {
    const tight = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 100_000,
      spentMicros: 90_000,
      heldMicros: 0,
      perPersonLimitMicros: 500_000,
      personSpentMicros: 0,
      personHeldMicros: 0,
    });
    expect(headroomMicros(tight)).toBe(10_000);
  });

  it("floors the person's room at zero when their spend and holds exceed their limit", () => {
    const spent = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 1_000_000,
      perPersonLimitMicros: 10_000,
      personSpentMicros: 8_000,
      personHeldMicros: 5_000,
    });
    expect(headroomMicros(spent)).toBe(0);
  });

  it("refuses when a per-person limit is set but the person's spend or holds are missing", () => {
    const missingSpent = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 1_000_000,
      perPersonLimitMicros: 200_000,
      personHeldMicros: 0,
    });
    const missingHeld = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 1_000_000,
      perPersonLimitMicros: 200_000,
      personSpentMicros: 0,
    });
    expect(headroomMicros(missingSpent)).toBe(0);
    expect(headroomMicros(missingHeld)).toBe(0);
  });

  it("uses the pool alone when no per-person limit is set, whatever the person fields say", () => {
    const pooled = allocation({
      id: "g",
      scopeKind: "groups",
      assignedGroupIds: ["team-a"],
      limitMicros: 1_000_000,
      spentMicros: 100_000,
      heldMicros: 0,
      personSpentMicros: 999_999,
      personHeldMicros: 999_999,
    });
    expect(headroomMicros(pooled)).toBe(900_000);
  });
});
