/**
 * Phase 3 lane C — provisioning a portal identity and resolving it back.
 *
 * In-memory SQLite built by `ensureSchema`, the same fixture `migrate-0015.test.ts` uses for the
 * fresh-database cases. Nothing here touches a data dir or the repo's own database.
 */
import { LOCAL_TENANT_ID } from "@agentforge/core";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { ensurePortalOwner, PortalProvisionError, resolvePortalTenant, syncPortalRole } from "./portal-owner";
import * as schema from "./schema";
import { organizationMembers, organizations, user, workspaceMembers, workspaces } from "./schema";

// The three ids a session carries. `resolvePortalTenant` takes exactly these.
const A = { tenantId: "tnt_a", orgId: "org_a", userId: "usr_a" };
const B = { tenantId: "tnt_b", orgId: "org_b", userId: "usr_b" };
// What a sign-in hands `ensurePortalOwner`: the ids plus what the portal said the person is.
const OWNER_A = { ...A, role: "owner" as const };
const OWNER_B = { ...B, role: "owner" as const };

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  db = drizzle(sqlite, { schema });
});

afterEach(() => {
  sqlite.close();
});

describe("ensurePortalOwner", () => {
  it("writes the tenant, org, user, membership and a home desk from the portal's ids", async () => {
    const tenant = await ensurePortalOwner(db, OWNER_A);

    expect(tenant).toMatchObject({ tenantId: "tnt_a", organizationId: "org_a", userId: "usr_a", role: "owner" });
    const [org] = await db.select().from(organizations).where(eq(organizations.id, "org_a"));
    expect(org.tenantId).toBe("tnt_a");
    const desks = await db.select().from(workspaces).where(eq(workspaces.organizationId, "org_a"));
    expect(desks).toHaveLength(1);
    expect(desks[0].slug).toBe("home");
  });

  it("is idempotent: a second sign-in adds no second org, desk or user", async () => {
    const first = await ensurePortalOwner(db, OWNER_A);
    const second = await ensurePortalOwner(db, OWNER_A);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(await db.select().from(workspaces).where(eq(workspaces.organizationId, "org_a"))).toHaveLength(1);
    expect(await db.select().from(user)).toHaveLength(1);
  });

  it("keys the user on the portal id and never on an address anyone else could claim", async () => {
    await ensurePortalOwner(db, OWNER_A);

    const [row] = await db.select().from(user).where(eq(user.id, "usr_a"));
    expect(row.id).toBe("usr_a");
    // RFC 2606 reserves `.invalid`, so this can never collide with a real address.
    expect(row.email).toMatch(/@portal\.invalid$/);
    expect(row.emailVerified).toBe(false);
  });

  it("leaves the local tenant alone, so a desktop database that signs in still opens", async () => {
    await ensurePortalOwner(db, OWNER_A);

    const rows = await db.select().from(schema.tenants);
    expect(rows.map((row) => row.id).sort()).toEqual([LOCAL_TENANT_ID, "tnt_a"].sort());
  });

  it("refuses to re-home an org that already belongs to another tenant", async () => {
    await ensurePortalOwner(db, OWNER_A);

    await expect(ensurePortalOwner(db, { ...OWNER_A, tenantId: "tnt_b" })).rejects.toBeInstanceOf(PortalProvisionError);
  });

  it("gives two tenants disjoint orgs and desks", async () => {
    const a = await ensurePortalOwner(db, OWNER_A);
    const b = await ensurePortalOwner(db, OWNER_B);

    expect(a.organizationId).not.toBe(b.organizationId);
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });
});

describe("resolvePortalTenant", () => {
  it("resolves a provisioned identity to its own org and home desk", async () => {
    const provisioned = await ensurePortalOwner(db, OWNER_A);

    const resolution = await resolvePortalTenant(db, A);

    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.tenant).toMatchObject({
      tenantId: "tnt_a",
      organizationId: "org_a",
      workspaceId: provisioned.workspaceId,
      role: "owner",
    });
  });

  it("creates nothing: an identity nobody provisioned is refused, not given a desk", async () => {
    const resolution = await resolvePortalTenant(db, A);

    expect(resolution).toEqual({ ok: false, code: "tenant_inactive" });
    expect(await db.select().from(organizations)).toHaveLength(0);
  });

  it("refuses an inactive tenant", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await db.update(schema.tenants).set({ status: "inactive" }).where(eq(schema.tenants.id, "tnt_a"));

    expect(await resolvePortalTenant(db, A)).toEqual({ ok: false, code: "tenant_inactive" });
  });

  it("refuses an org from another tenant even though both ids are real", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await ensurePortalOwner(db, OWNER_B);

    expect(await resolvePortalTenant(db, { ...A, orgId: "org_b" })).toEqual({ ok: false, code: "org_inactive" });
  });

  it("refuses a user who is not a member of the org the session names", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await ensurePortalOwner(db, OWNER_B);

    expect(await resolvePortalTenant(db, { ...A, userId: "usr_b" })).toEqual({ ok: false, code: "user_inactive" });
  });

  it("refuses a desk that belongs to another tenant instead of substituting home", async () => {
    await ensurePortalOwner(db, OWNER_A);
    const b = await ensurePortalOwner(db, OWNER_B);

    expect(await resolvePortalTenant(db, A, b.workspaceId)).toEqual({ ok: false, code: "workspace_not_found" });
  });

  it("honours a desk the session's own org owns", async () => {
    const a = await ensurePortalOwner(db, OWNER_A);

    const resolution = await resolvePortalTenant(db, A, a.workspaceId);

    expect(resolution.ok && resolution.tenant.workspaceId).toBe(a.workspaceId);
  });

  it("treats an empty or whitespace desk preference as no preference", async () => {
    const a = await ensurePortalOwner(db, OWNER_A);

    for (const blank of ["", "   ", null, undefined]) {
      const resolution = await resolvePortalTenant(db, A, blank);
      expect(resolution.ok && resolution.tenant.workspaceId).toBe(a.workspaceId);
    }
  });
});

// The hole this block closes: `ensurePortalOwner` used to write `owner` for everybody it provisioned,
// because the portal sent no role, so "owner" on the host meant "signed in" and any colleague could
// erase the company. The role is now the portal's word, and the host never defaults to owner.
describe("the role the portal sends", () => {
  const MEMBER_B = { tenantId: "tnt_a", orgId: "org_a", userId: "usr_member" };
  const ADMIN_C = { tenantId: "tnt_a", orgId: "org_a", userId: "usr_admin" };

  async function orgRole(userId: string): Promise<string | undefined> {
    const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, userId));
    return rows[0]?.role;
  }

  async function deskRole(userId: string): Promise<string | undefined> {
    const rows = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    return rows[0]?.role;
  }

  it("gives an owner the owner role, on the membership and on the tenant it returns", async () => {
    const tenant = await ensurePortalOwner(db, OWNER_A);

    expect(tenant.role).toBe("owner");
    expect(await orgRole("usr_a")).toBe("owner");
    expect(await deskRole("usr_a")).toBe("owner");
  });

  it("gives an admin the admin role", async () => {
    const tenant = await ensurePortalOwner(db, { ...ADMIN_C, role: "admin" });

    expect(tenant.role).toBe("admin");
    expect(await orgRole("usr_admin")).toBe("admin");
    expect(await deskRole("usr_admin")).toBe("admin");
  });

  it("gives a member the member role, even when they are the first person in the org", async () => {
    const tenant = await ensurePortalOwner(db, { ...MEMBER_B, role: "member" });

    expect(tenant.role).toBe("member");
    expect(await orgRole("usr_member")).toBe("member");
    expect(await deskRole("usr_member")).toBe("member");
  });

  it("gives a colleague who signs in after the owner the member role, not a second owner", async () => {
    await ensurePortalOwner(db, OWNER_A);
    const colleague = await ensurePortalOwner(db, { ...MEMBER_B, role: "member" });

    expect(colleague.role).toBe("member");
    const owners = await db.select().from(organizationMembers).where(eq(organizationMembers.role, "owner"));
    expect(owners.map((row) => row.userId)).toEqual(["usr_a"]);
  });

  it("gives no role no rights: the first sign-in is a member, never an owner", async () => {
    const tenant = await ensurePortalOwner(db, { ...MEMBER_B, role: null });

    expect(tenant.role).toBe("member");
    expect(await orgRole("usr_member")).toBe("member");
  });

  it("applies the portal's new word on the next sign-in: a promotion", async () => {
    await ensurePortalOwner(db, { ...MEMBER_B, role: "member" });

    const promoted = await ensurePortalOwner(db, { ...MEMBER_B, role: "admin" });

    expect(promoted.role).toBe("admin");
    expect(await orgRole("usr_member")).toBe("admin");
    expect(await deskRole("usr_member")).toBe("admin");
  });

  it("applies the portal's new word on the next sign-in: a demotion", async () => {
    await ensurePortalOwner(db, OWNER_A);

    const demoted = await ensurePortalOwner(db, { ...A, role: "member" });

    expect(demoted.role).toBe("member");
    expect(await orgRole("usr_a")).toBe("member");
    expect(await deskRole("usr_a")).toBe("member");
  });

  it("downgrades a row written as owner before the portal sent a role, to what the portal now says", async () => {
    await ensurePortalOwner(db, OWNER_A);
    // The shape every pre-fix deployment holds: a colleague whose row says owner because they signed in.
    sqlite
      .prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)")
      .run("usr_member", "usr_member", "usr_member@portal.invalid");
    sqlite
      .prepare("INSERT INTO organization_members (id, organization_id, user_id, role) VALUES (?, 'org_a', ?, 'owner')")
      .run("legacy-membership", "usr_member");
    expect(await orgRole("usr_member")).toBe("owner");

    const tenant = await ensurePortalOwner(db, { ...MEMBER_B, role: "member" });

    expect(tenant.role).toBe("member");
    expect(await orgRole("usr_member")).toBe("member");
  });

  it("reads the role from the row on every request, so a change shows without a new session", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await db.update(organizationMembers).set({ role: "member" }).where(eq(organizationMembers.userId, "usr_a"));

    const resolution = await resolvePortalTenant(db, A);

    expect(resolution.ok && resolution.tenant.role).toBe("member");
  });

  it("reads a role the host does not know as a member, never as itself", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await db.update(organizationMembers).set({ role: "superuser" }).where(eq(organizationMembers.userId, "usr_a"));

    const resolution = await resolvePortalTenant(db, A);

    expect(resolution.ok && resolution.tenant.role).toBe("member");
  });
});

describe("syncPortalRole (a refresh's reconciliation)", () => {
  async function orgRole(userId: string): Promise<string | undefined> {
    const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, userId));
    return rows[0]?.role;
  }

  it("changes the role when the portal's role changed, and says so", async () => {
    await ensurePortalOwner(db, OWNER_A);

    expect(await syncPortalRole(db, A, "admin")).toBe(true);

    expect(await orgRole("usr_a")).toBe("admin");
  });

  it("downgrades an owner row for a portal member, on the membership and the desk", async () => {
    await ensurePortalOwner(db, OWNER_A);

    expect(await syncPortalRole(db, A, "member")).toBe(true);

    expect(await orgRole("usr_a")).toBe("member");
    const desks = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, "usr_a"));
    expect(desks.map((row) => row.role)).toEqual(["member"]);
  });

  it("reads no role as a member: an owner row loses its rights when the portal says nothing usable", async () => {
    await ensurePortalOwner(db, OWNER_A);

    expect(await syncPortalRole(db, A, null)).toBe(true);

    expect(await orgRole("usr_a")).toBe("member");
  });

  it("writes nothing when the role is what the row already says", async () => {
    await ensurePortalOwner(db, OWNER_A);

    expect(await syncPortalRole(db, A, "owner")).toBe(false);

    expect(await orgRole("usr_a")).toBe("owner");
  });

  it("creates nothing for a person who was never provisioned", async () => {
    await ensurePortalOwner(db, OWNER_A);

    expect(await syncPortalRole(db, { ...A, userId: "usr_stranger" }, "owner")).toBe(false);

    expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, "usr_stranger"))).toEqual(
      [],
    );
    expect(await db.select().from(user).where(eq(user.id, "usr_stranger"))).toEqual([]);
  });

  it("never touches another org's membership of the same user id", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await ensurePortalOwner(db, { ...OWNER_B, userId: "usr_a" });

    await syncPortalRole(db, A, "member");

    const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, "usr_a"));
    const byOrg = Object.fromEntries(rows.map((row) => [row.organizationId, row.role]));
    expect(byOrg).toEqual({ org_a: "member", org_b: "owner" });
  });

  it("never touches another member of the same org", async () => {
    await ensurePortalOwner(db, OWNER_A);
    await ensurePortalOwner(db, { tenantId: "tnt_a", orgId: "org_a", userId: "usr_colleague", role: "member" });

    await syncPortalRole(db, A, "admin");

    expect(await orgRole("usr_colleague")).toBe("member");
  });
});
