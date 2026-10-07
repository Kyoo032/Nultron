/**
 * `user_credentials` against a real Postgres, connected as the plain application role so the tenant
 * policies in `0004_rls.sql` and `0012_password_signin.sql` are in force.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordHasher, type PasswordHash } from "../../password";
import { appClientFor, asAppRole, createTestStore, fixedClock, type TestStore } from "../../testing/pg";
import { addUser, seedFixture, type Fixture } from "../../testing/fixtures";
import { openPostgresStore } from "./index";
import type { PortalStore } from "../types";
import { PASSWORD_GRACE_ATTEMPTS, PASSWORD_LOCK_MS, PASSWORD_MAX_FAILED_ATTEMPTS } from "./credentials";

const hasher = createPasswordHasher({ params: { n: 2 ** 14, r: 8, p: 1, keyLength: 32 } });

let test: TestStore;
let store: PortalStore;
let a: Fixture;
let b: Fixture;
let secret: PasswordHash;

beforeAll(async () => {
  test = await createTestStore();
  store = test.store;
  a = await seedFixture(store, { slug: "tenant_a", email: "owner@tenant-a.test" });
  b = await seedFixture(store, { slug: "tenant_b", email: "owner@tenant-b.test" });
  secret = await hasher.hash("fake-password-for-the-store-tests");
}, 180_000);

afterAll(async () => {
  await test?.close();
});

let seq = 0;
async function personIn(fixture: Fixture, username?: string) {
  seq += 1;
  const user = await addUser(store, fixture, `store.person.${seq}@${fixture.tenant.slug}.test`);
  const credential = await store.tx(fixture.tenant.id, (ops) =>
    ops.credentials.create({
      userId: user.id,
      username: username ?? `store.person.${seq}`,
      secret,
      now: new Date(),
    }),
  );
  return { user, credential };
}

function reserve(fixture: Fixture, userId: string, now: Date) {
  return store.tx(fixture.tenant.id, (ops) =>
    ops.credentials.reserveAttempt({
      userId,
      now,
      maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
      lockMs: PASSWORD_LOCK_MS,
    }),
  );
}

describe("create", () => {
  it("takes the tenant from the person's row and returns no hash, salt or cost parameter", async () => {
    const { user, credential } = await personIn(a);
    expect(credential).not.toBeNull();
    expect(credential?.tenantId).toBe(a.tenant.id);
    expect(credential?.userId).toBe(user.id);
    expect(credential?.mustChange).toBe(true);
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeNull();
    for (const key of Object.keys(credential ?? {})) {
      expect(key).not.toMatch(/hash|salt|scrypt/i);
    }
    expect(Object.isFrozen(credential)).toBe(true);
  });

  it("conflicts, as null, for a second credential on one person and for a taken username", async () => {
    const { user } = await personIn(a, "taken.name");
    const again = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.create({ userId: user.id, username: "another.name", secret, now: new Date() }),
    );
    expect(again).toBeNull();

    const other = await addUser(store, a, "someone.else@tenant-a.test");
    const clash = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.create({ userId: other.id, username: "taken.name", secret, now: new Date() }),
    );
    expect(clash).toBeNull();
    // citext: another case of the same name is the same name.
    const alsoClash = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.create({ userId: other.id, username: "Taken.Name", secret, now: new Date() }),
    );
    expect(alsoClash).toBeNull();
  });

  it("lets two tenants use the same username", async () => {
    const first = await personIn(a, "shared.name");
    const second = await personIn(b, "shared.name");
    expect(first.credential).not.toBeNull();
    expect(second.credential).not.toBeNull();
  });

  it("refuses at the schema what is plainly wrong: a cost below the floor, a bad username, a bad length", async () => {
    const user = await addUser(store, a, "schema.checks@tenant-a.test");
    const attempt = (override: Partial<PasswordHash>, username = "schema.checks") =>
      store.tx(a.tenant.id, (ops) =>
        ops.credentials.create({ userId: user.id, username, secret: { ...secret, ...override }, now: new Date() }),
      );
    await expect(attempt({ params: { n: 1024, r: 8, p: 1, keyLength: 32 } })).rejects.toThrow(/scrypt_n_chk/);
    await expect(attempt({ params: { n: 30000, r: 8, p: 1, keyLength: 32 } })).rejects.toThrow(/scrypt_n_chk/);
    await expect(attempt({}, "Has Space")).rejects.toThrow(/username_chk/);
    await expect(attempt({}, "ab")).rejects.toThrow(/username_chk/);
    await expect(attempt({}, "a@b.test")).rejects.toThrow(/username_chk/);
    await expect(attempt({ hash: Buffer.alloc(8) })).rejects.toThrow(/hash_len_chk/);
  });
});

describe("tenant isolation", () => {
  it("shows one tenant none of another's credentials, by id, by username or in a list", async () => {
    const { user } = await personIn(a, "only.in.a");
    expect(await store.tx(b.tenant.id, (ops) => ops.credentials.findByUserId(user.id))).toBeNull();
    expect(await store.tx(b.tenant.id, (ops) => ops.credentials.findAccount(b.tenant.id, "only.in.a"))).toBeNull();
    expect(await store.tx(b.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, "only.in.a"))).toBeNull();
    const listed = await store.tx(b.tenant.id, (ops) => ops.credentials.listPeople(b.tenant.id, b.org.id));
    expect(listed.every((person) => person.user.tenantId === b.tenant.id)).toBe(true);
    // And with no tenant in scope at all, nothing: the pre-authentication window reaches this table
    // through the resolver and never through the table.
    expect(await store.tx(null, (ops) => ops.credentials.findByUserId(user.id))).toBeNull();
  });

  it("cannot be written across tenants", async () => {
    const stranger = await addUser(store, a, "cross.tenant@tenant-a.test");
    await expect(
      store.tx(b.tenant.id, (ops) =>
        ops.credentials.create({ userId: stranger.id, username: "cross.tenant", secret, now: new Date() }),
      ),
    ).resolves.toBeNull();
  });

  it("is granted to the application role without DELETE, and not at all to the read-only role", async () => {
    const client = await appClientFor(test.database);
    try {
      const { rows } = await client.query<{ app_select: boolean; app_delete: boolean; readonly_select: boolean }>(
        `SELECT has_table_privilege('portal_app', 'user_credentials', 'SELECT') AS app_select,
                has_table_privilege('portal_app', 'user_credentials', 'DELETE') AS app_delete,
                has_table_privilege('tenant_readonly', 'user_credentials', 'SELECT') AS readonly_select`,
      );
      expect(rows[0]).toEqual({ app_select: true, app_delete: false, readonly_select: false });
    } finally {
      await client.end();
    }
  });
});

describe("the username resolver", () => {
  it("answers a tenant for a username used once, nothing for an unknown one or one used in two tenants", async () => {
    await personIn(a, "only.one.tenant");
    await personIn(a, "in.both.tenants");
    await personIn(b, "in.both.tenants");
    expect(await store.resolve.byUsername("only.one.tenant")).toBe(a.tenant.id);
    expect(await store.resolve.byUsername("  ONLY.One.Tenant ")).toBe(a.tenant.id);
    expect(await store.resolve.byUsername("in.both.tenants")).toBeNull();
    expect(await store.resolve.byUsername("never.heard.of.them")).toBeNull();
  });
});

describe("findAccount", () => {
  it("finds a person by username or by the address on record, never by one for the other", async () => {
    const { user } = await personIn(a, "by.either.way");
    const byName = await store.tx(a.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, "by.either.way"));
    const byAddress = await store.tx(a.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, user.email));
    expect(byName?.user.id).toBe(user.id);
    expect(byAddress?.user.id).toBe(user.id);
    expect(byName?.credential.username).toBe("by.either.way");
    // An address that is not an address on record, and a username that is somebody's address' local part.
    expect(
      await store.tx(a.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, "by.either.way@tenant-a.test")),
    ).toBeNull();
    expect(
      await store.tx(a.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, user.email.split("@")[0])),
    ).toBeNull();
  });

  it("does not find a person who has no credential", async () => {
    const bare = await addUser(store, a, "no.credential@tenant-a.test");
    expect(await store.tx(a.tenant.id, (ops) => ops.credentials.findAccount(a.tenant.id, bare.email))).toBeNull();
    const everyone = await store.tx(a.tenant.id, (ops) => ops.credentials.listPeople(a.tenant.id, a.org.id));
    expect(everyone.find((person) => person.user.id === bare.id)?.credential).toBeNull();
  });
});

describe("reserveAttempt", () => {
  it("counts each attempt before any comparison, and locks on the fifth", async () => {
    const { user } = await personIn(a);
    const clock = fixedClock();
    for (let attempt = 1; attempt <= PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const result = await reserve(a, user.id, clock.now());
      expect(result.kind).toBe("reserved");
      if (result.kind === "reserved") {
        expect(result.attemptsUsed).toBe(attempt);
        expect(result.lockedNow).toBe(attempt === PASSWORD_MAX_FAILED_ATTEMPTS);
        // Only a caller that won an increment is handed the hash.
        expect(await hasher.verify("fake-password-for-the-store-tests", result.secret)).toBe(true);
      }
    }
    const sixth = await reserve(a, user.id, clock.now());
    expect(sixth.kind).toBe("locked");
    if (sixth.kind === "locked") {
      expect(new Date(sixth.until).getTime()).toBe(clock.now().getTime() + PASSWORD_LOCK_MS);
    }
  });

  it("opens a fresh window when the lock has run out, and not a moment before", async () => {
    const { user } = await personIn(a);
    const clock = fixedClock();
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await reserve(a, user.id, clock.now());
    }
    clock.advance(PASSWORD_LOCK_MS - 1);
    expect((await reserve(a, user.id, clock.now())).kind).toBe("locked");
    clock.advance(1);
    const reopened = await reserve(a, user.id, clock.now());
    expect(reopened.kind).toBe("reserved");
    if (reopened.kind === "reserved") {
      expect(reopened.attemptsUsed).toBe(1);
      expect(reopened.lockedNow).toBe(false);
    }
  });

  it("gives fifty parallel callers exactly five comparisons between them", async () => {
    const { user } = await personIn(a);
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(a, user.id, now)));
    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(PASSWORD_MAX_FAILED_ATTEMPTS);
    expect(results.filter((result) => result.kind === "locked")).toHaveLength(50 - PASSWORD_MAX_FAILED_ATTEMPTS);
    const numbers = results
      .flatMap((result) => (result.kind === "reserved" ? [result.attemptsUsed] : []))
      .sort((x, y) => x - y);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it("says none for a person with no credential", async () => {
    const bare = await addUser(store, a, "reserve.none@tenant-a.test");
    expect((await reserve(a, bare.id, new Date())).kind).toBe("none");
  });
});

describe("reserveAttempt past the lock: the grace slots", () => {
  /** Five attempts spent: the account is locked at `at`. */
  async function lockedAt(at: Date) {
    const { user } = await personIn(a);
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await reserve(a, user.id, at);
    }
    return user;
  }

  function reserveWithGrace(userId: string, now: Date, graceAttempts: number) {
    return store.tx(a.tenant.id, (ops) =>
      ops.credentials.reserveAttempt({
        userId,
        now,
        maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
        lockMs: PASSWORD_LOCK_MS,
        graceAttempts,
      }),
    );
  }

  it("is three, a small fixed number the schema holds as well as the code", () => {
    expect(PASSWORD_GRACE_ATTEMPTS).toBe(3);
  });

  it("hands a caller that asks for them three more attempts under the lock, and then none", async () => {
    const now = new Date();
    const user = await lockedAt(now);
    for (let slot = 1; slot <= PASSWORD_GRACE_ATTEMPTS; slot += 1) {
      const result = await reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS);
      expect(result.kind).toBe("reserved");
      if (result.kind === "reserved") {
        expect(result.graceUsed).toBe(slot);
        // Still the same lock: no second lock is made by an attempt that was only let through it.
        expect(result.lockedNow).toBe(false);
        expect(await hasher.verify("fake-password-for-the-store-tests", result.secret)).toBe(true);
      }
    }
    expect((await reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS)).kind).toBe("locked");
  });

  it("hands nothing to a caller that does not ask, however often it asks, and asking does not spend a slot", async () => {
    const now = new Date();
    const user = await lockedAt(now);
    for (let ask = 0; ask < 10; ask += 1) {
      expect((await reserve(a, user.id, now)).kind).toBe("locked");
    }
    // None of those spent anything: all three slots are still there for a caller that asks.
    for (let slot = 1; slot <= PASSWORD_GRACE_ATTEMPTS; slot += 1) {
      expect((await reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS)).kind).toBe("reserved");
    }
  });

  it("gives fifty parallel callers, every one of them asking, five comparisons plus three and no more", async () => {
    const user = await personIn(a).then((made) => made.user);
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS)),
    );
    const reserved = results.filter((result) => result.kind === "reserved");
    expect(reserved).toHaveLength(PASSWORD_MAX_FAILED_ATTEMPTS + PASSWORD_GRACE_ATTEMPTS);
    expect(results.filter((result) => result.kind === "locked")).toHaveLength(
      50 - PASSWORD_MAX_FAILED_ATTEMPTS - PASSWORD_GRACE_ATTEMPTS,
    );
    const graceTaken = reserved.flatMap((result) => (result.kind === "reserved" ? [result.graceUsed] : []));
    expect(graceTaken.filter((used) => used > 0).sort()).toEqual([1, 2, 3]);
  });

  it("keeps the count in the database: a fresh connection (a restart) finds the slots as they were left", async () => {
    const now = new Date();
    const user = await lockedAt(now);
    await reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS);
    await reserveWithGrace(user.id, now, PASSWORD_GRACE_ATTEMPTS);

    const fresh = openPostgresStore({ databaseUrl: asAppRole(test.database.url), maxConnections: 1 });
    try {
      const third = await fresh.tx(a.tenant.id, (ops) =>
        ops.credentials.reserveAttempt({
          userId: user.id,
          now,
          maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
          lockMs: PASSWORD_LOCK_MS,
          graceAttempts: PASSWORD_GRACE_ATTEMPTS,
        }),
      );
      expect(third.kind === "reserved" ? third.graceUsed : -1).toBe(3);
      const fourth = await fresh.tx(a.tenant.id, (ops) =>
        ops.credentials.reserveAttempt({
          userId: user.id,
          now,
          maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
          lockMs: PASSWORD_LOCK_MS,
          graceAttempts: PASSWORD_GRACE_ATTEMPTS,
        }),
      );
      expect(fourth.kind).toBe("locked");
    } finally {
      await fresh.close();
    }
  });

  it("starts them again with a fresh window, and a success clears them with the lock", async () => {
    const clock = fixedClock();
    const user = await lockedAt(clock.now());
    await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS);
    await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS);
    await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS);

    // The lock runs out: the next window is five attempts and three slots again, not what was left.
    clock.advance(PASSWORD_LOCK_MS);
    for (let attempt = 1; attempt <= PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect((await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS)).kind).toBe("reserved");
    }
    const firstSlot = await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS);
    expect(firstSlot.kind === "reserved" ? firstSlot.graceUsed : -1).toBe(1);

    // A proved password clears the lock, the count and the slots.
    await store.tx(a.tenant.id, (ops) =>
      ops.credentials.recordSuccess({ userId: user.id, now: clock.now(), expectHash: secret.hash }),
    );
    const afterSuccess = await reserveWithGrace(user.id, clock.now(), PASSWORD_GRACE_ATTEMPTS);
    expect(afterSuccess.kind === "reserved" ? [afterSuccess.attemptsUsed, afterSuccess.graceUsed] : null).toEqual([1, 0]);
  });

  it("is capped by the schema as well: a count past three cannot be written", async () => {
    const { user } = await personIn(a);
    const client = await appClientFor(test.database);
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenant.id]);
      await expect(
        client.query("UPDATE user_credentials SET grace_attempts = 4 WHERE user_id = $1", [user.id]),
      ).rejects.toThrow(/grace_attempts_chk/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});

describe("clearAttempts", () => {
  it("clears the count, the lock and the slots, and nothing else", async () => {
    const now = new Date();
    const { user } = await personIn(a);
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await reserve(a, user.id, now);
    }
    await store.tx(a.tenant.id, (ops) =>
      ops.credentials.reserveAttempt({
        userId: user.id,
        now,
        maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
        lockMs: PASSWORD_LOCK_MS,
        graceAttempts: PASSWORD_GRACE_ATTEMPTS,
      }),
    );
    await store.tx(a.tenant.id, (ops) => ops.credentials.clearAttempts(user.id));

    const credential = await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id));
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeNull();
    expect(credential?.mustChange).toBe(true);
    const next = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.reserveAttempt({
        userId: user.id,
        now,
        maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
        lockMs: PASSWORD_LOCK_MS,
        graceAttempts: PASSWORD_GRACE_ATTEMPTS,
      }),
    );
    expect(next.kind === "reserved" ? [next.attemptsUsed, next.graceUsed] : null).toEqual([1, 0]);
  });
});

describe("recordSuccess and setPassword", () => {
  it("clears the count and the lock, and can replace the hash with a newer one", async () => {
    const { user } = await personIn(a);
    const now = new Date();
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await reserve(a, user.id, now);
    }
    const newer = await createPasswordHasher({ params: { n: 2 ** 15, r: 8, p: 1, keyLength: 32 } }).hash(
      "fake-password-for-the-store-tests",
    );
    const wrote = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.recordSuccess({ userId: user.id, now, rehash: newer, expectHash: secret.hash }),
    );
    expect(wrote).toBe(true);

    const credential = await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id));
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeNull();
    expect(credential?.lastSignInAt).not.toBeNull();
    const reserved = await reserve(a, user.id, now);
    expect(reserved.kind).toBe("reserved");
    if (reserved.kind === "reserved") {
      expect(reserved.secret.params.n).toBe(2 ** 15);
      expect(reserved.secret.hash.equals(newer.hash)).toBe(true);
    }
  });

  it("writes a new password only while the hash is still the one that was proved", async () => {
    const { user } = await personIn(a);
    const fresh = await hasher.hash("a-replacement-fake-password");
    const stale = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.setPassword({
        userId: user.id,
        secret: fresh,
        mustChange: false,
        now: new Date(),
        expectHash: Buffer.alloc(32, 7),
      }),
    );
    expect(stale).toBe(false);
    expect((await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id)))?.mustChange).toBe(true);

    const current = await reserve(a, user.id, new Date());
    const ok = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.setPassword({
        userId: user.id,
        secret: fresh,
        mustChange: false,
        now: new Date(),
        expectHash: current.kind === "reserved" ? current.secret.hash : undefined,
      }),
    );
    expect(ok).toBe(true);
    const after = await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id));
    expect(after?.mustChange).toBe(false);
    expect(after?.failedAttempts).toBe(0);
  });

  it("does not write an older hash back over a password the operator has reset since it was proved", async () => {
    const { user } = await personIn(a);
    const now = new Date();
    // A sign-in proves the password: this is the hash it compared.
    const proved = await reserve(a, user.id, now);
    expect(proved.kind).toBe("reserved");
    const provedHash = proved.kind === "reserved" ? proved.secret.hash : Buffer.alloc(0);

    // While its re-hash is being made, the operator resets the password.
    const issued = await hasher.hash("an-operator-issued-fake-password");
    await store.tx(a.tenant.id, (ops) =>
      ops.credentials.setPassword({ userId: user.id, secret: issued, mustChange: true, now }),
    );

    // The sign-in's write comes late. It finds another hash than the one it proved, and writes nothing.
    const newer = await createPasswordHasher({ params: { n: 2 ** 15, r: 8, p: 1, keyLength: 32 } }).hash(
      "fake-password-for-the-store-tests",
    );
    const wrote = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.recordSuccess({ userId: user.id, now, rehash: newer, expectHash: provedHash }),
    );
    expect(wrote).toBe(false);

    const state = await reserve(a, user.id, now);
    expect(state.kind).toBe("reserved");
    if (state.kind === "reserved") {
      expect(await hasher.verify("an-operator-issued-fake-password", state.secret)).toBe(true);
      expect(await hasher.verify("fake-password-for-the-store-tests", state.secret)).toBe(false);
      expect(state.secret.params.n).toBe(2 ** 14);
    }
    // Nor did it stamp a sign-in, or touch the flag the reset set.
    const credential = await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id));
    expect(credential?.mustChange).toBe(true);
    expect(credential?.lastSignInAt).toBeNull();
  });

  it("guards the plain success the same way: a stale proof clears nothing", async () => {
    const { user } = await personIn(a);
    const now = new Date();
    await reserve(a, user.id, now);
    const issued = await hasher.hash("another-operator-issued-fake-password");
    await store.tx(a.tenant.id, (ops) =>
      ops.credentials.setPassword({ userId: user.id, secret: issued, mustChange: true, now }),
    );
    // The new password has taken a failure already.
    await reserve(a, user.id, now);
    const wrote = await store.tx(a.tenant.id, (ops) =>
      ops.credentials.recordSuccess({ userId: user.id, now, expectHash: secret.hash }),
    );
    expect(wrote).toBe(false);
    expect((await store.tx(a.tenant.id, (ops) => ops.credentials.findByUserId(user.id)))?.failedAttempts).toBe(1);
  });
});

describe("audit.countByTarget", () => {
  it("counts rows of one action since a moment, per target, inside the tenant's own scope", async () => {
    const { user } = await personIn(a);
    const other = await personIn(a);
    const stranger = await personIn(b);
    const write = (fixture: Fixture, targetId: string, action: string) =>
      store.tx(fixture.tenant.id, (ops) =>
        ops.audit.append({
          tenantId: fixture.tenant.id,
          orgId: fixture.org.id,
          actorKind: "system",
          action,
          targetKind: "user",
          targetId,
        }),
      );
    await write(a, user.id, "password.locked");
    await write(a, user.id, "password.locked");
    await write(a, other.user.id, "password.locked");
    await write(a, user.id, "password.failed");
    await write(b, stranger.user.id, "password.locked");

    const since = new Date(Date.now() - 60_000);
    const counts = await store.tx(a.tenant.id, (ops) =>
      ops.audit.countByTarget({ tenantId: a.tenant.id, action: "password.locked", since }),
    );
    expect(counts.get(user.id)).toBe(2);
    expect(counts.get(other.user.id)).toBe(1);
    // Nothing of another tenant, and no row of another action.
    expect(counts.has(stranger.user.id)).toBe(false);
    expect(counts.size).toBe(2);

    const one = await store.tx(a.tenant.id, (ops) =>
      ops.audit.countByTarget({ tenantId: a.tenant.id, action: "password.locked", since, targetId: user.id }),
    );
    expect([...one.entries()]).toEqual([[user.id, 2]]);

    const later = await store.tx(a.tenant.id, (ops) =>
      ops.audit.countByTarget({
        tenantId: a.tenant.id,
        action: "password.locked",
        since: new Date(Date.now() + 60_000),
      }),
    );
    expect(later.size).toBe(0);
  });
});

describe("countProvisioned", () => {
  it("counts people who are not disabled, invited ones included", async () => {
    const fixture = await seedFixture(store, { slug: "tenant_count", email: "owner@tenant-count.test" });
    expect(await store.tx(fixture.tenant.id, (ops) => ops.orgs.countProvisioned(fixture.org.id))).toBe(1);
    const two = await addUser(store, fixture, "two@tenant-count.test");
    await store.tx(fixture.tenant.id, (ops) =>
      ops.users.create({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        email: "three@tenant-count.test",
        status: "invited",
      }),
    );
    expect(await store.tx(fixture.tenant.id, (ops) => ops.orgs.countProvisioned(fixture.org.id))).toBe(3);
    await store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(two.id, "disabled"));
    expect(await store.tx(fixture.tenant.id, (ops) => ops.orgs.countProvisioned(fixture.org.id))).toBe(2);
  });
});
