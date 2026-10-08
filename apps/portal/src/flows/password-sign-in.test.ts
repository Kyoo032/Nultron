/**
 * The decisions of the password sign-in (`flows/password-sign-in.ts`) against a real Postgres, without
 * the HTTP layer: what the lock does to a person who is not the one hammering it, how many passwords a
 * window can ever try, what a restart and a reset do to a sign-in already under way, and what the
 * audit table is allowed to grow by. The pages and the status codes are `routes/password-sign-in.test.ts`.
 *
 * Every value here is fake. People are made by the operator's own `createAccount`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccount, disableAccount } from "../accounts";
import { createPasswordHasher } from "../password";
import { createPasswordAttempts } from "../security/password-attempts";
import { PASSWORD_GRACE_ATTEMPTS, PASSWORD_LOCK_MS, PASSWORD_MAX_FAILED_ATTEMPTS } from "../store/postgres/credentials";
import { seedFixture, type Fixture } from "../testing/fixtures";
import { countingHasher, credentialRowIn, gatedHasher, type CountingHasher } from "../testing/password-kit";
import { createTestStore, fixedClock, type TestStore } from "../testing/pg";
import type { Clock } from "../store/types";
import { changePasswordAndSignIn, signInWithPassword, type PasswordDeps } from "./password-sign-in";

const SLUG = "flowpilot";
const CHOSEN = "chosen-fake-password-1";
const WRONG = "wrong-fake-password-0";
const WINDOW_BOUND = PASSWORD_MAX_FAILED_ATTEMPTS + PASSWORD_GRACE_ATTEMPTS;

let test: TestStore;
let fixture: Fixture;
const real = createPasswordHasher();

beforeAll(async () => {
  test = await createTestStore();
  fixture = await seedFixture(test.store, { slug: SLUG, email: "owner@flowpilot.test", seatCap: 500 });
}, 180_000);

afterAll(async () => {
  await test?.close();
});

let seq = 0;

interface Person {
  readonly userId: string;
  readonly username: string;
  readonly email: string;
}

/** A person who has already chosen a password, made the way the operator makes one. */
async function person(
  options: { readonly password?: string; readonly hasher?: ReturnType<typeof createPasswordHasher> } = {},
): Promise<Person> {
  seq += 1;
  const username = `flow.person.${seq}`;
  const created = await createAccount(
    { store: test.store, passwords: real, clock: test.store.clock },
    { tenantSlug: SLUG, orgSlug: null, username, email: `${username}@flowpilot.test`, role: null, displayName: null },
  );
  if (!created.ok) {
    throw new Error(`could not make a person: ${created.reason}`);
  }
  const secret = await (options.hasher ?? real).hash(options.password ?? CHOSEN);
  await test.store.tx(fixture.tenant.id, (ops) =>
    ops.credentials.setPassword({ userId: created.userId, secret, mustChange: false, now: new Date() }),
  );
  return { userId: created.userId, username, email: created.email };
}

function stateOf(who: Person) {
  return credentialRowIn(test.database, fixture.tenant.id, who.userId);
}

function depsWith(
  passwords: CountingHasher | ReturnType<typeof createPasswordHasher>,
  clock: Clock = fixedClock(),
  attempts = createPasswordAttempts({ clock }),
): PasswordDeps {
  return { store: test.store, passwords, clock, attempts };
}

function signIn(deps: PasswordDeps, who: Person, password: string, source: string) {
  return signInWithPassword(deps, {
    identifier: who.username,
    password,
    requiredTenantId: fixture.tenant.id,
    ip: "10.9.8.7",
    source,
  });
}

function rowsOf(action: string, who: Person) {
  return test.store
    .tx(fixture.tenant.id, (ops) => ops.audit.list({ tenantId: fixture.tenant.id, action, limit: 1000 }))
    .then((rows) => rows.filter((row) => row.targetId === who.userId));
}

/** `maxInFlight` high enough that the suite is about the lock and not about the gate in front of it. */
function wideHasher(): CountingHasher {
  return countingHasher(createPasswordHasher({ maxInFlight: 256 }));
}

describe("the lock is not a free way to keep a named person out", () => {
  it("lets the person in from an address of their own while the attacker's address stays locked out", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();

    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect((await signIn(deps, who, WRONG, "198.51.100.1")).kind).toBe("refused");
    }
    expect((await stateOf(who)).lockedUntil).not.toBeNull();

    // The attacker, from the address that has failed: refused, even with the right password, and nothing
    // is compared for it. (It does not know it; this is what the lock is for.)
    const compared = hasher.calls.verify;
    expect((await signIn(deps, who, CHOSEN, "198.51.100.1")).kind).toBe("refused");
    expect((await signIn(deps, who, WRONG, "198.51.100.1")).kind).toBe("refused");
    expect(hasher.calls.verify).toBe(compared);

    // The person, from another address, with the right password: in.
    const outcome = await signIn(deps, who, CHOSEN, "203.0.113.50");
    expect(outcome.kind).toBe("signed_in");
    expect(hasher.calls.verify).toBe(compared + 1);

    // The lock, the count and the slots are cleared with the sign-in, as any success clears them.
    const after = await stateOf(who);
    expect([after.failedAttempts, after.graceAttempts, after.lockedUntil]).toEqual([0, 0, null]);
    // And the operator can see that this one got through a lock.
    const verified = await rowsOf("password.verified", who);
    expect(verified).toHaveLength(1);
    expect(verified[0].reasonCode).toBe("while_locked");
  }, 60_000);

  it("refuses a wrong password from that other address as it would anywhere, and it spends one of the three slots", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(deps, who, WRONG, "198.51.100.1");
    }
    const compared = hasher.calls.verify;
    expect((await signIn(deps, who, WRONG, "203.0.113.50")).kind).toBe("refused");
    expect(hasher.calls.verify).toBe(compared + 1);
    expect((await stateOf(who)).graceAttempts).toBe(1);
    // That address has failed now: the same refusal as the first one, with nothing compared.
    expect((await signIn(deps, who, CHOSEN, "203.0.113.50")).kind).toBe("refused");
    expect(hasher.calls.verify).toBe(compared + 1);

    const failed = (await rowsOf("password.failed", who)).map((row) => row.reasonCode);
    expect(failed.filter((reason) => reason === "wrong_password")).toHaveLength(PASSWORD_MAX_FAILED_ATTEMPTS);
    expect(failed.filter((reason) => reason === "wrong_password_while_locked")).toHaveLength(1);
  }, 60_000);

  it("never compares more than five plus three passwords in a window, fired at once from forty addresses", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();
    const before = { ...hasher.calls };

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, index) => signIn(deps, who, `${WRONG}-${index}`, `198.51.100.${index + 1}`)),
    );
    expect(outcomes.every((outcome) => outcome.kind === "refused")).toBe(true);
    expect(hasher.calls.verify - before.verify).toBe(WINDOW_BOUND);
    expect(hasher.calls.dummy - before.dummy).toBe(40 - WINDOW_BOUND);

    const state = await stateOf(who);
    expect([state.failedAttempts, state.graceAttempts]).toEqual([
      PASSWORD_MAX_FAILED_ATTEMPTS,
      PASSWORD_GRACE_ATTEMPTS,
    ]);
  }, 60_000);

  it("holds the same bound when every one of fifteen addresses fires four at once", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();
    const before = hasher.calls.verify;

    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        signIn(deps, who, `${WRONG}-${index}`, `198.51.100.${(index % 15) + 1}`),
      ),
    );
    const compared = hasher.calls.verify - before;
    expect(compared).toBeLessThanOrEqual(WINDOW_BOUND);
    expect(compared).toBeGreaterThanOrEqual(PASSWORD_MAX_FAILED_ATTEMPTS);
    const state = await stateOf(who);
    expect(state.failedAttempts + state.graceAttempts).toBeLessThanOrEqual(WINDOW_BOUND);
  }, 60_000);

  it("gives one address exactly five comparisons however many requests it fires at once", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();
    const before = hasher.calls.verify;
    await Promise.all(Array.from({ length: 20 }, (_, index) => signIn(deps, who, `${WRONG}-${index}`, "198.51.100.1")));
    // Its first request is the only one that is ever clean, and it is charged first: no slot is left
    // for it to find after the lock.
    expect(hasher.calls.verify - before).toBe(PASSWORD_MAX_FAILED_ATTEMPTS);
    expect((await stateOf(who)).graceAttempts).toBe(0);
  }, 60_000);

  it("keeps the bound across a restart: the record of sources is lost, the counts in the database are not", async () => {
    const hasher = wideHasher();
    const who = await person();
    const clock = fixedClock();
    const first = depsWith(hasher, clock);
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(first, who, WRONG, "198.51.100.1");
    }
    expect(hasher.calls.verify).toBeGreaterThanOrEqual(PASSWORD_MAX_FAILED_ATTEMPTS);
    const compared = hasher.calls.verify;

    // The process restarts: a new record, and the same database.
    const second = depsWith(hasher, clock);
    // The source that was locked out is clean again, so it may take a slot...
    await signIn(second, who, WRONG, "198.51.100.1");
    expect(hasher.calls.verify).toBe(compared + 1);
    // ...once: it is marked again, and refused.
    await signIn(second, who, WRONG, "198.51.100.1");
    expect(hasher.calls.verify).toBe(compared + 1);
    // Two more clean sources take the other two slots, and the fourth is refused, as it would have been
    // without a restart.
    await signIn(second, who, WRONG, "198.51.100.2");
    await signIn(second, who, WRONG, "198.51.100.3");
    await signIn(second, who, WRONG, "198.51.100.4");
    expect(hasher.calls.verify - compared).toBe(PASSWORD_GRACE_ATTEMPTS);
    const state = await stateOf(who);
    expect([state.failedAttempts, state.graceAttempts]).toEqual([
      PASSWORD_MAX_FAILED_ATTEMPTS,
      PASSWORD_GRACE_ATTEMPTS,
    ]);
  }, 60_000);

  it("does not hold a person's one mistake against them once they get it right", async () => {
    const deps = depsWith(wideHasher());
    const who = await person();
    expect((await signIn(deps, who, WRONG, "203.0.113.50")).kind).toBe("refused");
    expect((await signIn(deps, who, CHOSEN, "203.0.113.50")).kind).toBe("signed_in");
    // Their address is clean again: after a lock made by somebody else, it may take a slot.
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(deps, who, WRONG, "198.51.100.1");
    }
    expect((await signIn(deps, who, CHOSEN, "203.0.113.50")).kind).toBe("signed_in");
  }, 60_000);
});

describe("the audit table", () => {
  it("names the system as the actor and the person as the target of every row an outsider can cause", async () => {
    const clock = fixedClock();
    const deps = depsWith(wideHasher(), clock);
    const who = await person();
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(deps, who, WRONG, "198.51.100.1");
    }
    // The second lock, sixteen minutes later: within the hour, so it is also the repeated-lock row.
    clock.advance(PASSWORD_LOCK_MS + 60_000);
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(deps, who, WRONG, "198.51.100.1");
    }

    for (const action of ["password.failed", "password.locked", "password.lock_repeated"]) {
      const rows = await rowsOf(action, who);
      expect(rows.length, action).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.actorKind, action).toBe("system");
        expect(row.actorUserId, action).toBeNull();
        expect(row.targetKind, action).toBe("user");
        expect(row.targetId, action).toBe(who.userId);
      }
    }
    expect(await rowsOf("password.failed", who)).toHaveLength(2 * PASSWORD_MAX_FAILED_ATTEMPTS);
    expect(await rowsOf("password.locked", who)).toHaveLength(2);
    const repeated = await rowsOf("password.lock_repeated", who);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].reasonCode).toBe("locked_again_within_an_hour");
  }, 60_000);

  it("writes the repeated-lock row for a second lock inside the hour and not for one an hour apart", async () => {
    const clock = fixedClock();
    const deps = depsWith(wideHasher(), clock);
    const who = await person();
    const lockOnce = async () => {
      for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
        await signIn(deps, who, WRONG, "198.51.100.1");
      }
    };
    await lockOnce();
    expect(await rowsOf("password.lock_repeated", who)).toHaveLength(0);
    clock.advance(PASSWORD_LOCK_MS + 1000);
    await lockOnce();
    expect(await rowsOf("password.lock_repeated", who)).toHaveLength(1);
    // More than an hour after the last one: not "again within an hour".
    clock.advance(61 * 60 * 1000);
    await lockOnce();
    expect(await rowsOf("password.locked", who)).toHaveLength(3);
    expect(await rowsOf("password.lock_repeated", who)).toHaveLength(1);
  }, 60_000);

  it("keeps who proved a password as the actor of the rows that record a proof", async () => {
    const deps = depsWith(wideHasher());
    const who = await person();
    expect((await signIn(deps, who, CHOSEN, "203.0.113.50")).kind).toBe("signed_in");
    const verified = await rowsOf("password.verified", who);
    expect(verified).toHaveLength(1);
    expect(verified[0].actorKind).toBe("user");
    expect(verified[0].actorUserId).toBe(who.userId);
  });

  it("grows by at most five rows however many attempts are made on a disabled person, and gives them no slot", async () => {
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();
    const disabled = await disableAccount(
      { store: test.store, passwords: real, clock: test.store.clock },
      { tenantSlug: SLUG, person: { by: "username", username: who.username } },
    );
    expect(disabled.ok).toBe(true);

    const before = { ...hasher.calls };
    const outcomes = [];
    // Twenty attempts, each from an address of its own: no address has failed, so each is clean, and a
    // disabled person still gets no slot under the lock.
    for (let index = 0; index < 20; index += 1) {
      outcomes.push(await signIn(deps, who, CHOSEN, `198.51.100.${index + 1}`));
    }
    expect(outcomes.every((outcome) => outcome.kind === "refused")).toBe(true);
    // Every one of them paid for a derivation, and none for a comparison with anything.
    expect(hasher.calls.verify - before.verify).toBe(0);
    expect(hasher.calls.dummy - before.dummy).toBe(20);

    const withheld = await rowsOf("password.withheld", who);
    expect(withheld).toHaveLength(PASSWORD_MAX_FAILED_ATTEMPTS);
    for (const row of withheld) {
      expect(row.reasonCode).toBe("user_disabled");
      expect(row.actorKind).toBe("system");
      expect(row.actorUserId).toBeNull();
      expect(row.targetId).toBe(who.userId);
    }
    expect((await stateOf(who)).graceAttempts).toBe(0);
  }, 60_000);
});

describe("a reset that lands while a sign-in is comparing the old password", () => {
  async function raceAReset(options: { readonly oldParams: boolean }) {
    const gated = gatedHasher(real);
    const deps = depsWith(gated);
    // An older cost makes the success a re-hash; the current one makes it a plain success. Both are guarded.
    const older = createPasswordHasher({ params: { n: 2 ** 14, r: 8, p: 1, keyLength: 32 } });
    const who = await person({ hasher: options.oldParams ? older : real });
    const before = await stateOf(who);

    const open = gated.hold();
    const pending = signIn(deps, who, CHOSEN, "203.0.113.50");
    await gated.whenInside(1);

    // The operator resets the password now, while the comparison is in flight.
    const issued = await real.hash("an-operator-issued-fake-password");
    const reset = await test.store.tx(fixture.tenant.id, (ops) =>
      ops.credentials.setPassword({ userId: who.userId, secret: issued, mustChange: true, now: new Date() }),
    );
    expect(reset).toBe(true);
    open();

    return { outcome: await pending, who, issued, before };
  }

  it("does not write the old password back, and does not sign the person in on it", async () => {
    const { outcome, who, issued, before } = await raceAReset({ oldParams: true });
    expect(outcome.kind).toBe("refused");

    const after = await stateOf(who);
    // Still the operator's: the hash, its cost and the flag the reset set.
    expect(after.passwordHash.equals(issued.hash)).toBe(true);
    expect(after.passwordHash.equals(before.passwordHash)).toBe(false);
    expect(after.scryptN).toBe(2 ** 15);
    expect(after.mustChange).toBe(true);
    expect(after.lastSignInAt).toBeNull();
    expect(await rowsOf("password.verified", who)).toHaveLength(0);
  }, 60_000);

  it("is not a reason to refuse a sign-in that was running at the same moment and re-hashed the same password first", async () => {
    const gated = gatedHasher(real);
    const deps = depsWith(gated);
    const older = createPasswordHasher({ params: { n: 2 ** 14, r: 8, p: 1, keyLength: 32 } });
    const who = await person({ hasher: older });

    // A double click, or a second device: both compare the old hash, and both go to re-hash it. Only one
    // write can find the hash it proved; the other finds the password unchanged and is still right.
    const open = gated.hold();
    const first = signIn(deps, who, CHOSEN, "203.0.113.50");
    const second = signIn(deps, who, CHOSEN, "203.0.113.51");
    await gated.whenInside(2);
    open();

    expect([(await first).kind, (await second).kind]).toEqual(["signed_in", "signed_in"]);
    expect((await stateOf(who)).scryptN).toBe(2 ** 15);
    expect(await rowsOf("password.verified", who)).toHaveLength(2);
  }, 60_000);

  it("and a plain success is stale in the same way: nothing is cleared, nothing is stamped", async () => {
    const { outcome, who, issued } = await raceAReset({ oldParams: false });
    expect(outcome.kind).toBe("refused");
    const after = await stateOf(who);
    expect(after.passwordHash.equals(issued.hash)).toBe(true);
    expect(after.mustChange).toBe(true);
    expect(after.lastSignInAt).toBeNull();
    expect(await rowsOf("password.verified", who)).toHaveLength(0);
  }, 60_000);
});

describe("the length cap is measured after NFKC", () => {
  // `e` followed by U+0301 is one character once composed.
  const decomposed = `${"é".repeat(101)}`;
  const composed = "é".repeat(101);

  it("compares a valid password typed in decomposed form instead of refusing it for its raw length", async () => {
    expect([...decomposed].length).toBe(202);
    expect([...decomposed.normalize("NFKC")].length).toBe(101);
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person({ password: composed });

    const before = { ...hasher.calls };
    expect((await signIn(deps, who, decomposed, "203.0.113.50")).kind).toBe("signed_in");
    // It was compared (a real derivation against the stored hash), not turned away with a dummy.
    expect(hasher.calls.verify - before.verify).toBe(1);
    expect(hasher.calls.dummy - before.dummy).toBe(0);
  }, 60_000);

  it("refuses what is too long once composed, as one refusal, without counting an attempt against anybody", async () => {
    // U+3300 is one character that NFKC turns into four.
    const grows = "㌀".repeat(51);
    expect([...grows].length).toBe(51);
    expect([...grows.normalize("NFKC")].length).toBe(204);
    const hasher = wideHasher();
    const deps = depsWith(hasher);
    const who = await person();

    const before = { ...hasher.calls };
    expect((await signIn(deps, who, grows, "203.0.113.50")).kind).toBe("refused");
    expect(hasher.calls.verify - before.verify).toBe(0);
    expect(hasher.calls.dummy - before.dummy).toBe(1);
    expect((await stateOf(who)).failedAttempts).toBe(0);
  }, 60_000);
});

describe("when the portal is already deriving as much as it will", () => {
  it("answers busy before it counts anything or touches any account, and costs nobody an attempt", async () => {
    const hasher = countingHasher(createPasswordHasher({ maxInFlight: 1 }));
    const deps = depsWith(hasher);
    const who = await person();
    const held = hasher.admit();
    expect(held).not.toBeNull();

    const before = { ...hasher.calls };
    const outcome = await signIn(deps, who, CHOSEN, "203.0.113.50");
    expect(outcome.kind).toBe("busy");
    const ghost = await signInWithPassword(deps, {
      identifier: "ghost.person",
      password: CHOSEN,
      requiredTenantId: fixture.tenant.id,
      ip: "10.9.8.7",
      source: "203.0.113.51",
    });
    // The same answer for a person and for nobody: it says nothing about any account.
    expect(ghost.kind).toBe("busy");

    expect(hasher.calls).toEqual(before);
    const state = await stateOf(who);
    expect([state.failedAttempts, state.graceAttempts, state.lockedUntil, state.lastSignInAt]).toEqual([
      0,
      0,
      null,
      null,
    ]);
    for (const action of ["password.failed", "password.verified", "password.locked", "password.withheld"]) {
      expect(await rowsOf(action, who), action).toHaveLength(0);
    }

    // The step that was already in is untouched, and when it lets go the person gets in.
    held?.release();
    expect((await signIn(deps, who, CHOSEN, "203.0.113.50")).kind).toBe("signed_in");
  }, 60_000);

  it("says busy to a password change too, before it checks anything that needs the account", async () => {
    const hasher = countingHasher(createPasswordHasher({ maxInFlight: 1 }));
    const deps = depsWith(hasher);
    const who = await person();
    const held = hasher.admit();
    const outcome = await changePasswordAndSignIn(deps, {
      identifier: who.username,
      currentPassword: CHOSEN,
      newPassword: "a-fresh-fake-password-9",
      confirmPassword: "a-fresh-fake-password-9",
      requiredTenantId: fixture.tenant.id,
      ip: "10.9.8.7",
      source: "203.0.113.50",
    });
    expect(outcome.kind).toBe("busy");
    expect((await stateOf(who)).failedAttempts).toBe(0);
    held?.release();
  }, 60_000);

  it("lets go of its place on every road out, an error included", async () => {
    const hasher = createPasswordHasher({ maxInFlight: 1 });
    const failing = {
      ...hasher,
      verify: () => Promise.reject(new Error("the thread pool went away")),
      admit: () => hasher.admit(),
    };
    const deps = depsWith(failing);
    const who = await person();
    await expect(signIn(deps, who, CHOSEN, "203.0.113.50")).rejects.toThrow("the thread pool went away");
    // The place was given back: the next one is let in.
    const next = hasher.admit();
    expect(next).not.toBeNull();
    next?.release();
  }, 60_000);

  it("lets a sign-in that is refused, and one that succeeds, give their places back as well", async () => {
    const hasher = createPasswordHasher({ maxInFlight: 1 });
    const deps = depsWith(hasher);
    const who = await person();
    for (const password of [WRONG, CHOSEN, WRONG]) {
      await signIn(deps, who, password, "203.0.113.50");
      const place = hasher.admit();
      expect(place).not.toBeNull();
      place?.release();
    }
  }, 60_000);
});
