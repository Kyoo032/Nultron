/**
 * The operator's side of an invite: `pnpm portal:invite`, minus the shell around it.
 *
 * Everything the CLI decides is here -- which org, which refusals, what is written, what the audit
 * row holds -- so the script itself stays a parse-open-print-close wrapper like `scripts/seed.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { normaliseInviteCode } from "../crypto";
import type { PortalStore } from "../store/types";
import { addUser, seedFixture, type Fixture } from "../testing/fixtures";
import { createTestStore, type TestStore } from "../testing/pg";
import { INVITE_DEFAULT_TTL_DAYS, InviteArgsError, parseInviteArgs } from "./args";
import { formatInviteReport, issueInvite } from "./issue";

let harness: TestStore;
let store: PortalStore;
let fixture: Fixture;
const slug = `pilot${randomUUID().replace(/-/g, "").slice(0, 8)}`;

beforeAll(async () => {
  harness = await createTestStore();
  store = harness.store;
  fixture = await seedFixture(store, { slug, email: `owner@${slug}.test` });
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

let seq = 0;
function nextAddress(): string {
  seq += 1;
  return `tester${seq}@${slug}.test`;
}

describe("issueInvite", () => {
  it("creates an invited member and hands back a one-time code in the printed shape", async () => {
    const email = nextAddress();
    const result = await issueInvite(store, { tenantSlug: slug, email: email.toUpperCase() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    expect(result.email).toBe(email);
    expect(result.tenantId).toBe(fixture.tenant.id);
    expect(result.orgId).toBe(fixture.org.id);
    expect(result.userCreated).toBe(true);
    expect(result.replacedEarlier).toBe(false);

    const lifetimeDays = (new Date(result.expiresAt).getTime() - store.clock.now().getTime()) / 86_400_000;
    expect(lifetimeDays).toBeGreaterThan(INVITE_DEFAULT_TTL_DAYS - 0.01);
    expect(lifetimeDays).toBeLessThan(INVITE_DEFAULT_TTL_DAYS + 0.01);

    const user = await store.tx(fixture.tenant.id, (ops) => ops.users.findByEmail(fixture.tenant.id, email));
    expect(user).toMatchObject({ status: "invited", role: "member", orgId: fixture.org.id });
  });

  it("writes the invite as a hash and the audit row without the code", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress() });
    if (!result.ok) throw new Error(`expected an invite, got ${result.reason}`);

    const audit = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "invite.issued" }),
    );
    const row = audit.find((entry) => entry.targetId === result.inviteId);
    expect(row).toBeDefined();
    expect(row?.actorKind).toBe("support");
    const written = JSON.stringify(row);
    expect(written).not.toContain(result.code);
    expect(written).not.toContain(normaliseInviteCode(result.code));

    // And the code the operator was shown is the one that redeems.
    const redeemed = await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.redeem({ tenantId: fixture.tenant.id, email: result.email, rawCode: result.code }),
    );
    expect(redeemed.ok).toBe(true);
  });

  it("replaces a live invite for the same address: the new code works and the old one does not", async () => {
    const email = nextAddress();
    const first = await issueInvite(store, { tenantSlug: slug, email });
    const second = await issueInvite(store, { tenantSlug: slug, email });
    if (!first.ok || !second.ok) throw new Error("expected two invites");

    expect(second.userCreated).toBe(false);
    expect(second.replacedEarlier).toBe(true);
    expect(second.code).not.toBe(first.code);

    const redeem = (rawCode: string) =>
      store.tx(fixture.tenant.id, (ops) => ops.invites.redeem({ tenantId: fixture.tenant.id, email, rawCode }));
    expect((await redeem(first.code)).ok).toBe(false);
    expect((await redeem(second.code)).ok).toBe(true);
  });

  it("refuses an address that is already an active member, and writes nothing", async () => {
    const email = nextAddress();
    await addUser(store, fixture, email);

    const result = await issueInvite(store, { tenantSlug: slug, email });

    expect(result).toMatchObject({ ok: false, reason: "already_member" });
    const row = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, email));
    expect(row).toBeNull();
  });

  it("refuses a disabled member: an invite is not how someone is let back in", async () => {
    const email = nextAddress();
    const user = await addUser(store, fixture, email);
    await store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(user.id, "disabled"));

    expect(await issueInvite(store, { tenantSlug: slug, email })).toMatchObject({
      ok: false,
      reason: "user_disabled",
    });
  });

  it("refuses an address that already belongs to another tenant, which would make sign-in ambiguous", async () => {
    const other = await seedFixture(store, { slug: `other${slug}`.slice(0, 31), email: `shared@elsewhere.test` });
    expect(other.user.email).toBe("shared@elsewhere.test");

    expect(await issueInvite(store, { tenantSlug: slug, email: "shared@elsewhere.test" })).toMatchObject({
      ok: false,
      reason: "other_tenant",
    });
  });

  it("refuses an unknown tenant, an unknown org, and an address that is not one", async () => {
    expect(await issueInvite(store, { tenantSlug: "nosuchtenant", email: nextAddress() })).toMatchObject({
      ok: false,
      reason: "unknown_tenant",
    });
    expect(
      await issueInvite(store, { tenantSlug: slug, orgSlug: "nosuchorg", email: nextAddress() }),
    ).toMatchObject({ ok: false, reason: "unknown_org" });
    expect(await issueInvite(store, { tenantSlug: slug, email: "not-an-address" })).toMatchObject({
      ok: false,
      reason: "invalid_email",
    });
  });

  it("asks for an org when the tenant has more than one, and takes the named one", async () => {
    const multi = await seedFixture(store, { slug: `multi${slug}`.slice(0, 31), email: "boss@multi.test" });
    const second = await store.tx(multi.tenant.id, (ops) =>
      ops.orgs.create({ tenantId: multi.tenant.id, name: "Second", slug: "second", seatCap: 5 }),
    );
    const email = nextAddress();

    expect(await issueInvite(store, { tenantSlug: multi.tenant.slug, email })).toMatchObject({
      ok: false,
      reason: "choose_org",
    });

    const named = await issueInvite(store, { tenantSlug: multi.tenant.slug, orgSlug: "second", email });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.orgId).toBe(second.id);
  });

  it("honours a shorter lifetime", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress(), ttlMs: 60 * 60 * 1000 });
    if (!result.ok) throw new Error("expected an invite");
    const hours = (new Date(result.expiresAt).getTime() - store.clock.now().getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.99);
    expect(hours).toBeLessThan(1.01);
  });
});

describe("formatInviteReport", () => {
  it("does not print the code unless asked: it exists in the e-mail and nowhere else", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress() });
    if (!result.ok) throw new Error("expected an invite");

    const report = formatInviteReport(result, { mailed: true, printCode: false });

    expect(report).not.toContain(result.code);
    expect(report).toContain(result.email);
    expect(report).toMatch(/was e-mailed to that address/);
    expect(report).toMatch(/--print/);
    // The tester still proves the mailbox: the invite only opens the first sign-in.
    expect(report).toMatch(/e-mails a six-digit/i);
  });

  it("prints the code once, with --print, and says it cannot be shown again", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress() });
    if (!result.ok) throw new Error("expected an invite");

    const report = formatInviteReport(result, { mailed: true, printCode: true });

    expect(report).toContain(result.code);
    expect(report).toMatch(/only time the code can be displayed/i);
  });

  it("says plainly when the e-mail did not go", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress() });
    if (!result.ok) throw new Error("expected an invite");

    expect(formatInviteReport(result, { mailed: false, printCode: true })).toMatch(/NOT sent/);
  });
});

describe("parseInviteArgs", () => {
  it("needs an address and defaults the rest, with the code not printed", () => {
    expect(parseInviteArgs(["--email", "a@b.test"])).toEqual({
      email: "a@b.test",
      tenantSlug: "nultron",
      orgSlug: null,
      ttlDays: INVITE_DEFAULT_TTL_DAYS,
      role: null,
      language: "en",
      printCode: false,
      gatewayEndpoint: null,
    });
    expect(parseInviteArgs(["--email", "a@b.test", "--gateway-endpoint", "https://gw.example/v1/"])).toMatchObject({
      gatewayEndpoint: "https://gw.example/v1",
    });
    expect(() => parseInviteArgs(["--email", "a@b.test", "--gateway-endpoint", "http://bad.example/v1"])).toThrow(
      InviteArgsError,
    );
    expect(() => parseInviteArgs([])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["--email", "no-at-sign"])).toThrow(InviteArgsError);
  });

  it("takes a tenant, an org, a lifetime and a language, and bounds the lifetime", () => {
    expect(
      parseInviteArgs(["--email", "a@b.test", "--tenant", "Pilot", "--org-slug", "kyo", "--ttl-days", "3", "--lang", "ID"]),
    ).toMatchObject({ tenantSlug: "pilot", orgSlug: "kyo", ttlDays: 3, language: "id" });
    expect(() => parseInviteArgs(["--email", "a@b.test", "--ttl-days", "0"])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["--email", "a@b.test", "--ttl-days", "31"])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["--email", "a@b.test", "--ttl-days", "1.5"])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["--email", "a@b.test", "--lang", "fr"])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["stray"])).toThrow(InviteArgsError);
  });

  it("takes a role, and refuses anything but owner, admin or member", () => {
    expect(parseInviteArgs(["--email", "a@b.test", "--role", "ADMIN"]).role).toBe("admin");
    expect(parseInviteArgs(["--email", "a@b.test", "--role=owner"]).role).toBe("owner");
    expect(() => parseInviteArgs(["--email", "a@b.test", "--role", "superuser"])).toThrow(InviteArgsError);
    expect(() => parseInviteArgs(["--email", "a@b.test", "--role"])).toThrow(InviteArgsError);
  });

  it("reads --print as a switch wherever it sits, and ignores the separator pnpm forwards", () => {
    expect(parseInviteArgs(["--", "--print", "--email", "a@b.test"]).printCode).toBe(true);
    expect(parseInviteArgs(["--email", "a@b.test", "--print"]).printCode).toBe(true);
    expect(parseInviteArgs(["--email=a@b.test", "--print", "--tenant", "pilot"])).toMatchObject({
      email: "a@b.test",
      printCode: true,
      tenantSlug: "pilot",
    });
  });
});

describe("issueInvite and roles", () => {
  it("invites as a member unless told otherwise, and carries the role it was told onto the member and the invite", async () => {
    const plain = await issueInvite(store, { tenantSlug: slug, email: nextAddress() });
    const admin = await issueInvite(store, { tenantSlug: slug, email: nextAddress(), role: "admin" });
    if (!plain.ok || !admin.ok) throw new Error("expected invites");

    expect(plain.role).toBe("member");
    expect(admin.role).toBe("admin");
    const row = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, admin.email));
    const member = await store.tx(fixture.tenant.id, (ops) => ops.users.findById(admin.userId));
    expect(row?.role).toBe("admin");
    expect(member?.role).toBe("admin");
  });

  it("puts the role in the audit row, which still carries no code", async () => {
    const result = await issueInvite(store, { tenantSlug: slug, email: nextAddress(), role: "admin" });
    if (!result.ok) throw new Error("expected an invite");

    const rows = await store.tx(fixture.tenant.id, (ops) =>
      ops.audit.list({ tenantId: fixture.tenant.id, action: "invite.issued" }),
    );
    const row = rows.find((entry) => entry.targetId === result.inviteId);
    expect(row?.after).toMatchObject({ role: "admin" });
    expect(JSON.stringify(row)).not.toContain(result.code);
  });

  it("lets a re-invite change an invited member's role, on the member and on the new invite", async () => {
    const email = nextAddress();
    await issueInvite(store, { tenantSlug: slug, email, role: "member" });

    const again = await issueInvite(store, { tenantSlug: slug, email, role: "admin" });

    if (!again.ok) throw new Error("expected an invite");
    expect(again.role).toBe("admin");
    const member = await store.tx(fixture.tenant.id, (ops) => ops.users.findById(again.userId));
    expect(member?.role).toBe("admin");
  });

  it("requires an owner for the first invite of a tenant that has none, and then lets members in", async () => {
    const empty = await seedFixture(store, { slug: `noown${slug}`.slice(0, 31), email: "last@noown.test" });
    await store.tx(empty.tenant.id, (ops) => ops.users.setStatus(empty.user.id, "disabled"));
    const email = nextAddress();

    expect(await issueInvite(store, { tenantSlug: empty.tenant.slug, email })).toMatchObject({
      ok: false,
      reason: "owner_required",
    });
    expect(await issueInvite(store, { tenantSlug: empty.tenant.slug, email, role: "admin" })).toMatchObject({
      ok: false,
      reason: "owner_required",
    });
    expect(await issueInvite(store, { tenantSlug: empty.tenant.slug, email, role: "owner" })).toMatchObject({
      ok: true,
      role: "owner",
    });
    // Now there is an owner (invited), so a member invite is allowed.
    expect(await issueInvite(store, { tenantSlug: empty.tenant.slug, email: nextAddress() })).toMatchObject({
      ok: true,
      role: "member",
    });
  });

  it("refuses a re-invite that would demote the only owner, which is an invited owner", async () => {
    const empty = await seedFixture(store, { slug: `solo${slug}`.slice(0, 31), email: "gone@solo.test" });
    await store.tx(empty.tenant.id, (ops) => ops.users.setStatus(empty.user.id, "disabled"));
    const email = nextAddress();
    await issueInvite(store, { tenantSlug: empty.tenant.slug, email, role: "owner" });

    expect(await issueInvite(store, { tenantSlug: empty.tenant.slug, email, role: "member" })).toMatchObject({
      ok: false,
      reason: "owner_required",
    });
  });

  it("refuses an invited member's re-invite into a different org (the org_mismatch refusal)", async () => {
    const multi = await seedFixture(store, { slug: `orgs${slug}`.slice(0, 31), email: "boss@orgs.test" });
    await store.tx(multi.tenant.id, (ops) =>
      ops.orgs.create({ tenantId: multi.tenant.id, name: "Second", slug: "second", seatCap: 5 }),
    );
    const email = nextAddress();
    await issueInvite(store, { tenantSlug: multi.tenant.slug, orgSlug: "kyo", email });

    expect(await issueInvite(store, { tenantSlug: multi.tenant.slug, orgSlug: "second", email })).toMatchObject({
      ok: false,
      reason: "org_mismatch",
    });
  });
});
