/**
 * invites: one code per address, bound to that address, 7 days, single use, five wrong guesses.
 *
 * The store is the half that decides, so this is where every refusal is pinned one at a time. The
 * wire suite (`routes/invite.test.ts`) then proves the page a person sees collapses all of them
 * into one sentence.
 */
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normaliseInviteCode, randomInviteCode } from "../../crypto";
import { seedFixture, type Fixture } from "../../testing/fixtures";
import { appClientFor, createTestStore, type TestStore } from "../../testing/pg";
import type { PortalStore, User } from "../types";

let harness: TestStore;
let store: PortalStore;
let fixture: Fixture;
let raw: Client;
let seq = 0;

beforeAll(async () => {
  harness = await createTestStore();
  store = harness.store;
  fixture = await seedFixture(store, { slug: "invitees" });
  raw = await appClientFor(harness.database);
}, 120_000);

afterAll(async () => {
  await raw?.end();
  await harness?.close();
});

function address(): string {
  seq += 1;
  return `tester${seq}@invitees.test`;
}

/** An `invited` member with no invite yet, which is what the operator's tool creates first. */
async function invitedUser(email: string = address()): Promise<User> {
  return store.tx(fixture.tenant.id, (ops) =>
    ops.users.create({
      tenantId: fixture.tenant.id,
      orgId: fixture.org.id,
      email,
      status: "invited",
      role: "member",
    }),
  );
}

async function invite(user: User, options: { rawCode?: string; ttlMs?: number } = {}) {
  const rawCode = options.rawCode ?? randomInviteCode();
  const created = await store.tx(fixture.tenant.id, (ops) =>
    ops.invites.create({
      tenantId: fixture.tenant.id,
      orgId: fixture.org.id,
      userId: user.id,
      email: user.email,
      rawCode,
      ttlMs: options.ttlMs,
    }),
  );
  return { invite: created, rawCode };
}

function redeem(email: string, rawCode: string) {
  return store.tx(fixture.tenant.id, (ops) =>
    ops.invites.redeem({ tenantId: fixture.tenant.id, email, rawCode }),
  );
}

async function userStatus(id: string): Promise<string | undefined> {
  return (await store.tx(fixture.tenant.id, (ops) => ops.users.findById(id)))?.status;
}

/** One statement under the tenant's scope, as the application role, so RLS is in force. */
async function rawRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await raw.query("BEGIN");
  try {
    await raw.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenant.id]);
    return (await raw.query(sql, params)).rows as T[];
  } finally {
    await raw.query("ROLLBACK");
  }
}

describe("creating an invite", () => {
  it("stores only the sha256 of the normalised code, never the code", async () => {
    const user = await invitedUser();
    const { invite: created, rawCode } = await invite(user);

    const [row] = await rawRows<{ code_hash: Buffer; as_text: string }>(
      `SELECT code_hash, row_to_json(i)::text AS as_text FROM invites i WHERE id = $1`,
      [created.id],
    );
    expect(row.code_hash.equals(createHash("sha256").update(normaliseInviteCode(rawCode)).digest())).toBe(
      true,
    );
    // Nothing in the row, in any column, spells the code in either of its two shapes.
    expect(row.as_text).not.toContain(rawCode);
    expect(row.as_text).not.toContain(normaliseInviteCode(rawCode));
  });

  it("binds the invite to the address, the org and the invited member, and lasts seven days", async () => {
    const user = await invitedUser("Mixed.Case@Invitees.Test");
    const { invite: created } = await invite(user);

    expect(created.email).toBe("mixed.case@invitees.test");
    expect(created.userId).toBe(user.id);
    expect(created.orgId).toBe(fixture.org.id);
    expect(created.redeemedAt).toBeNull();
    expect(created.revokedAt).toBeNull();
    expect(created.failedAttempts).toBe(0);

    const lifetime = new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime();
    expect(Math.abs(lifetime - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
  });

  it("retires an older live invite for the same address, so one code is live at a time", async () => {
    const user = await invitedUser();
    const first = await invite(user);
    const second = await invite(user);

    const stale = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, user.email));
    expect(stale?.id).toBe(second.invite.id);
    const [old] = await rawRows<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM invites WHERE id = $1`,
      [first.invite.id],
    );
    expect(old.revoked_at).not.toBeNull();

    // The retired code is a wrong code now, and the current one still works.
    expect((await redeem(user.email, first.rawCode)).ok).toBe(false);
    expect((await redeem(user.email, second.rawCode)).ok).toBe(true);
  });
});

describe("redeeming an invite", () => {
  it("marks it used and activates the membership in the same step", async () => {
    const user = await invitedUser();
    const { rawCode, invite: created } = await invite(user);
    expect(await userStatus(user.id)).toBe("invited");

    const result = await redeem(user.email, rawCode);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invite.id).toBe(created.id);
    expect(result.invite.redeemedAt).not.toBeNull();
    expect(result.user.status).toBe("active");
    expect(await userStatus(user.id)).toBe("active");
  });

  it("matches the address without regard to case, and the code without regard to dashes or case", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);

    const result = await redeem(user.email.toUpperCase(), rawCode.toLowerCase().replace(/-/g, " "));

    expect(result.ok).toBe(true);
  });

  it("refuses a wrong code, counts it, and leaves the member invited", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);
    const wrong = randomInviteCode();

    const first = await redeem(user.email, wrong);
    expect(first).toMatchObject({ ok: false, reason: "wrong_code", attemptsRemaining: 4 });
    const second = await redeem(user.email, wrong);
    expect(second).toMatchObject({ ok: false, reason: "wrong_code", attemptsRemaining: 3 });

    expect(await userStatus(user.id)).toBe("invited");
    // A wrong guess did not spend the invite: the right code still redeems.
    expect((await redeem(user.email, rawCode)).ok).toBe(true);
  });

  it("is locked after five wrong guesses, and then refuses even the right code", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await redeem(user.email, randomInviteCode());
      expect(result).toMatchObject({ ok: false, reason: "wrong_code" });
    }

    expect(await redeem(user.email, rawCode)).toMatchObject({ ok: false, reason: "locked" });
    expect(await userStatus(user.id)).toBe("invited");
  });

  it("refuses an expired invite, and leaves the member invited", async () => {
    const user = await invitedUser();
    // A negative lifetime is how a test asks for a row that is already past its expiry
    // (store/types.ts, invariant 4): the injected clock never travels.
    const { rawCode } = await invite(user, { ttlMs: -1_000 });

    expect(await redeem(user.email, rawCode)).toMatchObject({ ok: false, reason: "expired" });
    expect(await userStatus(user.id)).toBe("invited");
  });

  it("refuses a second redemption of the same code", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);
    expect((await redeem(user.email, rawCode)).ok).toBe(true);

    expect(await redeem(user.email, rawCode)).toMatchObject({ ok: false, reason: "already_used" });
  });

  it("refuses a code that belongs to another address, and does not spend it", async () => {
    const owner = await invitedUser();
    const other = await invitedUser();
    const ownerInvite = await invite(owner);
    await invite(other);

    // The other tester presents the owner's code under their own address.
    const stolen = await redeem(other.email, ownerInvite.rawCode);
    expect(stolen).toMatchObject({ ok: false, reason: "wrong_code" });
    expect(await userStatus(other.id)).toBe("invited");

    // And the owner's invite is untouched: still unredeemed, still zero failed attempts.
    const still = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, owner.email));
    expect(still?.redeemedAt).toBeNull();
    expect(still?.failedAttempts).toBe(0);
    expect((await redeem(owner.email, ownerInvite.rawCode)).ok).toBe(true);
  });

  it("answers no_invite for an address that was never invited, whatever code is presented", async () => {
    expect(await redeem("nobody@invitees.test", randomInviteCode())).toMatchObject({
      ok: false,
      reason: "no_invite",
    });
  });

  it("will not bring a disabled member back, and leaves the invite unspent", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);
    await store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(user.id, "disabled"));

    expect(await redeem(user.email, rawCode)).toMatchObject({ ok: false, reason: "not_invitable" });
    expect(await userStatus(user.id)).toBe("disabled");
    const row = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, user.email));
    expect(row?.redeemedAt).toBeNull();
  });

  it("does not redeem a retired invite", async () => {
    const user = await invitedUser();
    const first = await invite(user);
    await invite(user);

    const result = await redeem(user.email, first.rawCode);
    expect(result.ok).toBe(false);
  });
});

describe("the role an invite carries", () => {
  it("is member unless told otherwise, and is what the member holds once the invite is redeemed", async () => {
    const plainUser = await invitedUser();
    const adminUser = await invitedUser();
    const plain = await invite(plainUser);
    const adminCode = randomInviteCode();
    const withRole = await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        userId: adminUser.id,
        email: adminUser.email,
        rawCode: adminCode,
        role: "admin",
      }),
    );
    expect(plain.invite.role).toBe("member");
    expect(withRole.role).toBe("admin");

    const redeemed = await redeem(adminUser.email, adminCode);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.user.role).toBe("admin");
    expect((await redeem(plainUser.email, plain.rawCode).then((r) => (r.ok ? r.user.role : "refused")))).toBe("member");
  });

  it("is copied onto the member at redemption, and never changes a member who was already active", async () => {
    const user = await invitedUser();
    const rawCode = randomInviteCode();
    await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        userId: user.id,
        email: user.email,
        rawCode,
        role: "owner",
      }),
    );
    // The invited row was created as a member; the INVITE is what decides the role on redemption.
    expect((await store.tx(fixture.tenant.id, (ops) => ops.users.findById(user.id)))?.role).toBe("member");

    const redeemed = await redeem(user.email, rawCode);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.user.role).toBe("owner");

    // A seeded active admin who also has a live invite as owner keeps being an admin: an invite never
    // promotes somebody who is already in.
    const seeded = await store.tx(fixture.tenant.id, (ops) =>
      ops.users.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        email: address(),
        status: "active",
        role: "admin",
      }),
    );
    const code2 = randomInviteCode();
    await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        userId: seeded.id,
        email: seeded.email,
        rawCode: code2,
        role: "owner",
      }),
    );
    const second = await redeem(seeded.email, code2);
    expect(second.ok).toBe(true);
    expect((await store.tx(fixture.tenant.id, (ops) => ops.users.findById(seeded.id)))?.role).toBe("admin");
  });

  it("is refused outside owner, admin and member by the table itself", async () => {
    const user = await invitedUser();
    await expect(
      store.tx(fixture.tenant.id, (ops) =>
        ops.invites.create({
          tenantId: fixture.tenant.id,
          orgId: fixture.org.id,
          userId: user.id,
          email: user.email,
          rawCode: randomInviteCode(),
          role: "superuser" as never,
        }),
      ),
    ).rejects.toThrow(/invites_role_chk/);
  });
});

describe("one live invite per address, by the database and not only by the application", () => {
  it("lets exactly one of two simultaneous creates succeed; the other hits the live-invite index", async () => {
    const user = await invitedUser();
    const create = (ops: Parameters<Parameters<PortalStore["tx"]>[1]>[0]) =>
      ops.invites.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        userId: user.id,
        email: user.email,
        rawCode: randomInviteCode(),
      });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // The first transaction holds its new invite uncommitted while the second one runs, so the
    // second one's retire-the-live-one UPDATE cannot see it: only the index can refuse the INSERT.
    const first = store.tx(fixture.tenant.id, async (ops) => {
      await create(ops);
      await pause(400);
    });
    await pause(100);
    const second = store.tx(fixture.tenant.id, (ops) => create(ops));

    const results = await Promise.allSettled([first, second]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/uq_invites_live/);
  });
});

describe("the history the resend budget reads", () => {
  it("counts every invite for the address since a moment, retired ones included, with the oldest and newest", async () => {
    const user = await invitedUser();
    const before = new Date(Date.now() - 1000).toISOString();
    const first = await invite(user);
    const second = await invite(user);
    const third = await invite(user);

    const history = await store.tx(fixture.tenant.id, (ops) => ops.invites.issuedSince(fixture.tenant.id, user.email, before));

    expect(history.count).toBe(3);
    expect(history.oldestAt).toBe(first.invite.createdAt);
    expect(history.newestAt).toBe(third.invite.createdAt);
    expect(second.invite.createdAt >= first.invite.createdAt).toBe(true);
  });

  it("is empty for an address that was never invited, and for a moment after the last one", async () => {
    const user = await invitedUser();
    await invite(user);

    const never = await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.issuedSince(fixture.tenant.id, "never@invitees.test", new Date(0).toISOString()),
    );
    const later = await store.tx(fixture.tenant.id, (ops) =>
      ops.invites.issuedSince(fixture.tenant.id, user.email, new Date(Date.now() + 60_000).toISOString()),
    );

    expect(never).toEqual({ count: 0, oldestAt: null, newestAt: null });
    expect(later.count).toBe(0);
  });
});

describe("wrong guesses that arrive together", () => {
  it("are counted one at a time and stop at five: the row lock serialises them, so the CHECK is never hit", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => redeem(user.email, randomInviteCode())),
    );

    const reasons = results.map((result) => (result.ok ? "ok" : result.reason));
    expect(reasons.filter((reason) => reason === "wrong_code")).toHaveLength(5);
    expect(reasons.filter((reason) => reason === "locked")).toHaveLength(3);
    const row = await store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, user.email));
    expect(row?.failedAttempts).toBe(5);
    expect(await redeem(user.email, rawCode)).toMatchObject({ ok: false, reason: "locked" });
  });

  it("let exactly one of two simultaneous right codes through", async () => {
    const user = await invitedUser();
    const { rawCode } = await invite(user);

    const results = await Promise.all([redeem(user.email, rawCode), redeem(user.email, rawCode)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ reason: "already_used" });
  });
});

describe("the table", () => {
  it("is invisible to the application role outside a tenant scope", async () => {
    await raw.query("BEGIN");
    try {
      await raw.query("SELECT set_config('app.tenant_id', '', true)");
      const { rows } = await raw.query(`SELECT count(*)::int AS n FROM invites`);
      expect(rows[0].n).toBe(0);
    } finally {
      await raw.query("ROLLBACK");
    }
  });
});
