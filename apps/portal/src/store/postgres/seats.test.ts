/**
 * `count_active_users` and `login_precheck` — the seat definition and the login gate, as the
 * plpgsql functions in `0005_functions.sql` implement them.
 *
 * "Active user" = `users.status = 'active'` AND at least one non-revoked session seen in the last
 * 30 days. Nothing in TypeScript re-states that; these tests are here to prove the store is asking
 * the right question of the right function.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDevice, addUser, seedFixture, type Fixture } from "../../testing/fixtures";
import { createTestStore, type TestStore } from "../../testing/pg";
import type { PortalStore, User } from "../types";

let harness: TestStore;
let store: PortalStore;

beforeAll(async () => {
  harness = await createTestStore();
  store = harness.store;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

async function signIn(fixture: Fixture, user: User, options: { lastSeenAt?: Date } = {}) {
  const device = await addDevice(store, fixture, user, randomUUID());
  return store.tx(fixture.tenant.id, async (ops) => {
    const session = await ops.sessions.create({
      tenantId: fixture.tenant.id,
      orgId: fixture.org.id,
      userId: user.id,
      deviceId: device.id,
      lastSeenAt: options.lastSeenAt?.toISOString(),
    });
    return { session, device };
  });
}

function countSeats(fixture: Fixture): Promise<number> {
  return store.tx(fixture.tenant.id, (ops) => ops.orgs.countActiveUsers(fixture.org.id));
}

describe("count_active_users", () => {
  it("counts nobody until someone has a live session", async () => {
    const fixture = await seedFixture(store);
    expect(await countSeats(fixture)).toBe(0);
    await signIn(fixture, fixture.user);
    expect(await countSeats(fixture)).toBe(1);
  });

  it("counts a person once however many devices they are on", async () => {
    const fixture = await seedFixture(store);
    await signIn(fixture, fixture.user);
    await signIn(fixture, fixture.user);
    expect(await countSeats(fixture)).toBe(1);
  });

  it("stops counting a session that was revoked", async () => {
    const fixture = await seedFixture(store);
    const { session } = await signIn(fixture, fixture.user);
    expect(await countSeats(fixture)).toBe(1);
    await store.tx(fixture.tenant.id, (ops) => ops.sessions.revoke(session.id, "logout"));
    expect(await countSeats(fixture)).toBe(0);
  });

  it("stops counting a session last seen more than 30 days ago", async () => {
    const fixture = await seedFixture(store);
    await signIn(fixture, fixture.user, { lastSeenAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS) });
    expect(await countSeats(fixture)).toBe(0);
  });

  it("stops counting a user an admin disabled", async () => {
    const fixture = await seedFixture(store);
    await signIn(fixture, fixture.user);
    await store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(fixture.user.id, "disabled"));
    expect(await countSeats(fixture)).toBe(0);
  });
});

describe("login_precheck", () => {
  it("passes a healthy first login", async () => {
    const fixture = await seedFixture(store);
    const device = await addDevice(store, fixture, fixture.user);
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: fixture.user.id, deviceId: device.id }),
    );
    expect(reason).toBe("ok");
  });

  it("reports seat_cap_reached for the user who would exceed the cap", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    expect(await countSeats(fixture)).toBe(1);

    const second = await addUser(store, fixture, "second@example.test");
    const device = await addDevice(store, fixture, second);
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: second.id, deviceId: device.id }),
    );
    expect(reason).toBe("seat_cap_reached");
  });

  it("does not charge a second seat to someone already inside the active set", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    const anotherDevice = await addDevice(store, fixture, fixture.user, randomUUID());
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: fixture.user.id, deviceId: anotherDevice.id }),
    );
    expect(reason).toBe("ok");
  });

  it("skips the seat check on a refresh, which cannot grow the active set", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    const second = await addUser(store, fixture, "third@example.test");
    const { session, device } = await signIn(fixture, second);

    // The org is now over its cap, but an existing session may still refresh.
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: second.id, deviceId: device.id, sessionId: session.id }),
    );
    expect(reason).toBe("ok");
  });

  it("reports the outermost failing scope first", async () => {
    const fixture = await seedFixture(store);
    const device = await addDevice(store, fixture, fixture.user);
    const precheck = () =>
      store.tx(fixture.tenant.id, (ops) =>
        ops.loginPrecheck({ userId: fixture.user.id, deviceId: device.id }),
      );

    await store.tx(fixture.tenant.id, (ops) => ops.orgs.setStatus(fixture.org.id, "past_due"));
    expect(await precheck()).toBe("org_past_due");

    await store.tx(fixture.tenant.id, (ops) => ops.orgs.setStatus(fixture.org.id, "suspended"));
    expect(await precheck()).toBe("org_inactive");

    // A suspended tenant outranks everything below it and leaks no per-user state.
    await store.tx(fixture.tenant.id, (ops) => ops.tenants.setStatus(fixture.tenant.id, "suspended"));
    expect(await precheck()).toBe("tenant_inactive");
  });

  it("reports device_revoked for a device an admin signed out", async () => {
    const fixture = await seedFixture(store);
    const device = await addDevice(store, fixture, fixture.user);
    await store.tx(fixture.tenant.id, (ops) => ops.devices.revoke(device.id, "admin"));
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: fixture.user.id, deviceId: device.id }),
    );
    expect(reason).toBe("device_revoked");
  });

  it("reports user_inactive — never a distinct 'not found' — for an unknown user", async () => {
    const fixture = await seedFixture(store);
    const device = await addDevice(store, fixture, fixture.user);
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: randomUUID(), deviceId: device.id }),
    );
    expect(reason).toBe("user_inactive");
  });

  it("refuses to resurrect a revoked install", async () => {
    const fixture = await seedFixture(store);
    const installId = randomUUID();
    const device = await addDevice(store, fixture, fixture.user, installId);
    await store.tx(fixture.tenant.id, (ops) => ops.devices.revoke(device.id, "admin"));

    const result = await store.tx(fixture.tenant.id, (ops) =>
      ops.devices.upsert({
        tenantId: fixture.tenant.id,
        orgId: fixture.org.id,
        userId: fixture.user.id,
        installId,
        platform: "windows",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("device_revoked");
  });
});

/**
 * `orgs.hasSeatFor` is the question a sign-in PAGE asks before it spends an invite or a code
 * (L2, 2026-10-01): would a new session for this person fit the org's cap right now? It is the
 * seat branch of `login_precheck` without its advisory lock, so these tests hold it to that
 * function's own answer rather than to a second definition of a seat.
 */
describe("orgs.hasSeatFor", () => {
  async function hasSeat(fixture: Fixture, user: User): Promise<boolean> {
    return store.tx(fixture.tenant.id, (ops) => ops.orgs.hasSeatFor(fixture.org.id, user.id));
  }

  async function precheckSaysOk(fixture: Fixture, user: User): Promise<boolean> {
    const device = await addDevice(store, fixture, user, randomUUID());
    const reason = await store.tx(fixture.tenant.id, (ops) =>
      ops.loginPrecheck({ userId: user.id, deviceId: device.id }),
    );
    return reason === "ok";
  }

  it("is true while the org has a free seat, for a member with no session and for an invitee", async () => {
    const fixture = await seedFixture(store, { seatCap: 2 });
    await signIn(fixture, fixture.user);
    const invitee = await store.tx(fixture.tenant.id, (ops) =>
      ops.users.create({ tenantId: fixture.tenant.id, orgId: fixture.org.id, email: "invitee@example.test", status: "invited" }),
    );
    const idle = await addUser(store, fixture, "idle@example.test");

    expect(await hasSeat(fixture, invitee)).toBe(true);
    expect(await hasSeat(fixture, idle)).toBe(true);
  });

  it("is false for a person with no live session once the cap is reached", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    const idle = await addUser(store, fixture, "idle2@example.test");
    const invitee = await store.tx(fixture.tenant.id, (ops) =>
      ops.users.create({ tenantId: fixture.tenant.id, orgId: fixture.org.id, email: "invitee2@example.test", status: "invited" }),
    );

    expect(await hasSeat(fixture, idle)).toBe(false);
    expect(await hasSeat(fixture, invitee)).toBe(false);
  });

  it("is true for the person who already holds a seat: a second device is not a second seat", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);

    expect(await hasSeat(fixture, fixture.user)).toBe(true);
  });

  it("is false for a person whose last session aged out of the 30-day window, in a full org", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    const lapsed = await addUser(store, fixture, "lapsed@example.test");
    await signIn(fixture, lapsed, { lastSeenAt: new Date(Date.now() - THIRTY_ONE_DAYS_MS) });

    expect(await hasSeat(fixture, lapsed)).toBe(false);
  });

  it("is false even for a seated person when the org is over its cap, exactly as login_precheck is", async () => {
    const fixture = await seedFixture(store, { seatCap: 2 });
    await signIn(fixture, fixture.user);
    const second = await addUser(store, fixture, "second2@example.test");
    await signIn(fixture, second);
    await store.tx(fixture.tenant.id, (ops) => ops.orgs.setSeatCap(fixture.org.id, 1));

    expect(await hasSeat(fixture, fixture.user)).toBe(false);
  });

  it("agrees with login_precheck in every state above", async () => {
    const fixture = await seedFixture(store, { seatCap: 1 });
    await signIn(fixture, fixture.user);
    const idle = await addUser(store, fixture, "agree@example.test");

    expect(await hasSeat(fixture, fixture.user)).toBe(await precheckSaysOk(fixture, fixture.user));
    expect(await hasSeat(fixture, idle)).toBe(await precheckSaysOk(fixture, idle));
    await store.tx(fixture.tenant.id, (ops) => ops.orgs.setSeatCap(fixture.org.id, 2));
    expect(await hasSeat(fixture, idle)).toBe(await precheckSaysOk(fixture, idle));
  });
});
