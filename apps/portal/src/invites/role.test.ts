/**
 * Changing the role of a member who is already in. The operator's tool and nobody else's: there is no
 * portal route that reaches this.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortalStore } from "../store/types";
import { addUser, seedFixture, type Fixture } from "../testing/fixtures";
import { createTestStore, type TestStore } from "../testing/pg";
import { changeMemberRole, formatRoleReport, issueInvite } from "./index";

let harness: TestStore;
let store: PortalStore;
let fixture: Fixture;
const slug = `roles${randomUUID().replace(/-/g, "").slice(0, 8)}`;
let seq = 0;

beforeAll(async () => {
  harness = await createTestStore();
  store = harness.store;
  fixture = await seedFixture(store, { slug, email: `owner@${slug}.test` });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

function next(): string {
  seq += 1;
  return `member${seq}@${slug}.test`;
}

describe("changeMemberRole", () => {
  it("promotes and demotes an active member, and audits who it was, from what, to what", async () => {
    const email = next();
    const member = await addUser(store, fixture, email);

    const up = await changeMemberRole(store, { tenantSlug: slug, email: email.toUpperCase(), role: "admin" });

    expect(up).toMatchObject({ ok: true, from: "member", to: "admin", userId: member.id });
    expect((await store.tx(fixture.tenant.id, (ops) => ops.users.findById(member.id)))?.role).toBe("admin");
    const rows = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "member.role_changed" }),
    );
    const row = rows.find((entry) => entry.targetId === member.id);
    expect(row).toMatchObject({ actorKind: "support", before: { role: "member" }, after: { role: "admin" } });

    expect(await changeMemberRole(store, { tenantSlug: slug, email, role: "member" })).toMatchObject({
      ok: true,
      from: "admin",
      to: "member",
    });
  });

  it("refuses the role the member already has", async () => {
    const email = next();
    await addUser(store, fixture, email);

    expect(await changeMemberRole(store, { tenantSlug: slug, email, role: "member" })).toMatchObject({
      ok: false,
      reason: "same_role",
    });
  });

  it("will not demote the tenant's last owner, and will once there is another", async () => {
    // The fixture's owner is the only one.
    expect(await changeMemberRole(store, { tenantSlug: slug, email: fixture.user.email, role: "admin" })).toMatchObject({
      ok: false,
      reason: "last_owner",
    });

    const second = next();
    await addUser(store, fixture, second);
    expect(await changeMemberRole(store, { tenantSlug: slug, email: second, role: "owner" })).toMatchObject({ ok: true });
    expect(await changeMemberRole(store, { tenantSlug: slug, email: fixture.user.email, role: "admin" })).toMatchObject({
      ok: true,
      from: "owner",
      to: "admin",
    });
  });

  it("cannot be raced past the last-owner rule: two operators demoting the only two owners at once, one is refused", async () => {
    const racing = await seedFixture(store, { slug: `race${slug}`.slice(0, 31), email: "one@race.test" });
    const second = await addUser(store, racing, "two@race.test");
    await store.tx(racing.tenant.id, (ops) => ops.users.setRole(second.id, "owner"));

    const results = await Promise.all([
      changeMemberRole(store, { tenantSlug: racing.tenant.slug, email: "one@race.test", role: "admin" }),
      changeMemberRole(store, { tenantSlug: racing.tenant.slug, email: "two@race.test", role: "admin" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ reason: "last_owner" });
    const owners = await store.tx(racing.tenant.id, (ops) => ops.users.lockOwners(racing.tenant.id));
    expect(owners).toBe(1);
  });

  it("is not how an invited member's role is set: that is the invite's, so it says to re-invite", async () => {
    const email = next();
    await issueInvite(store, { tenantSlug: slug, email });

    expect(await changeMemberRole(store, { tenantSlug: slug, email, role: "admin" })).toMatchObject({
      ok: false,
      reason: "not_active",
    });
  });

  it("refuses a disabled member, a stranger and an unknown tenant", async () => {
    const email = next();
    const member = await addUser(store, fixture, email);
    await store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(member.id, "disabled"));

    expect(await changeMemberRole(store, { tenantSlug: slug, email, role: "admin" })).toMatchObject({
      ok: false,
      reason: "user_disabled",
    });
    expect(await changeMemberRole(store, { tenantSlug: slug, email: "nobody@elsewhere.test", role: "admin" })).toMatchObject({
      ok: false,
      reason: "not_a_member",
    });
    expect(await changeMemberRole(store, { tenantSlug: "nosuchtenant", email, role: "admin" })).toMatchObject({
      ok: false,
      reason: "unknown_tenant",
    });
  });

  it("reports the change, and says no invite went", async () => {
    const email = next();
    await addUser(store, fixture, email);
    const result = await changeMemberRole(store, { tenantSlug: slug, email, role: "admin" });
    if (!result.ok) throw new Error("expected a change");

    const report = formatRoleReport(result);

    expect(report).toContain("role       member -> admin");
    expect(report).toMatch(/No invite was sent/);
  });
});
