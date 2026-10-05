/**
 * The limits that stand in for the neutral page.
 *
 * The e-mail step used to answer every address the same way, so nobody could tell a member from a
 * stranger. Since the owner's 2026-10-01 decision it tells them (SR-30), and what keeps that from
 * being a cheap way to sweep for addresses is these limits: on the e-mail step per IP and per
 * address, on typed invite codes per IP and per invite, and on "e-mail me my invite again" per
 * address. This suite runs on the limits as shipped (`emailStepLimits: "production"`); the others
 * lift the two e-mail ones because they are not about them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUser, type Fixture } from "../testing/fixtures";
import { fixedClock } from "../testing/pg";
import { startTestPortal, type PortalHarness } from "../testing/server";
import {
  browserAt,
  emailStep,
  inviteMails,
  inviteStep,
  nextAddress,
  operatorInvites,
  otpMails,
  resendInviteStep,
  setupPilot,
  shapeOf,
  statusOf,
} from "../testing/sign-in-kit";

const clock = fixedClock();
let portal: PortalHarness;
let fixture: Fixture;

beforeAll(async () => {
  portal = await startTestPortal({ trustProxy: true, emailStepLimits: "production", clock });
  fixture = await setupPilot(portal);
}, 180_000);

afterAll(async () => {
  await portal?.close();
});

beforeEach(() => {
  portal.mailer.clear();
  clock.set(new Date());
});

describe("the e-mail step, per IP", () => {
  it("allows fifteen looks in a quarter hour from one address, then refuses, and not another address", async () => {
    const sweeper = browserAt(portal, "10.50.0.1");

    for (let n = 0; n < 15; n += 1) {
      const reply = await emailStep(sweeper, `ip-${n}`, `ghost${n}@pilot.test`);
      expect(reply.status, `look ${n + 1}`).toBe(200);
    }
    const sixteenth = await emailStep(sweeper, "ip-15", "ghost15@pilot.test");

    expect(sixteenth.status).toBe(429);
    expect(sixteenth.text).toContain("Too many attempts");
    // The refusal is about the caller, so someone else is unaffected...
    expect((await emailStep(browserAt(portal, "10.50.0.2"), "ip-x", "ghost16@pilot.test")).status).toBe(200);
    // ...and it frees up when the window rolls.
    clock.advance(16 * 60 * 1000);
    expect((await emailStep(sweeper, "ip-16", "ghost17@pilot.test")).status).toBe(200);
  });

  it("refuses a real member and a stranger in exactly the same words, so the limit is no oracle", async () => {
    const member = nextAddress();
    await addUser(portal.store.store, fixture, member);
    const busy = browserAt(portal, "10.50.1.1");
    for (let n = 0; n < 15; n += 1) {
      await emailStep(busy, `same-${n}`, `ghost-b${n}@pilot.test`);
    }

    const forMember = await emailStep(busy, "same-x", member);
    const forStranger = await emailStep(busy, "same-x", "ghost-c@pilot.test");

    expect(forMember.status).toBe(429);
    expect(shapeOf(forMember)).toEqual(shapeOf(forStranger));
  });
});

describe("the e-mail step, per address", () => {
  it("allows six looks at one address in a quarter hour, from anywhere, then refuses a seventh from a fresh IP", async () => {
    const member = nextAddress();
    await addUser(portal.store.store, fixture, member);

    for (let n = 0; n < 6; n += 1) {
      const reply = await emailStep(browserAt(portal), `addr-${n}`, member);
      // The fourth look onwards is "we already sent several codes", a page of its own; what none of
      // the first six is, is the limit's refusal.
      expect(reply.text, `look ${n + 1}`).not.toContain("Too many attempts. Try again in a few minutes.");
    }
    const seventh = await emailStep(browserAt(portal), "addr-6", member);

    expect(seventh.status).toBe(429);
    expect(seventh.text).toContain("Too many attempts. Try again in a few minutes.");
    // Only three of those looks could mail a code anyway: the DB limit binds the mail itself.
    expect(otpMails(portal).length).toBeLessThanOrEqual(3);
  });

  it("keys on the address as the person typed it, so capitals do not buy a fresh budget", async () => {
    const member = nextAddress();
    await addUser(portal.store.store, fixture, member);
    for (let n = 0; n < 6; n += 1) {
      await emailStep(browserAt(portal), `case-${n}`, n % 2 === 0 ? member : member.toUpperCase());
    }

    const seventh = await emailStep(browserAt(portal), "case-6", `  ${member.toUpperCase()} `);

    expect(seventh.status).toBe(429);
    expect(seventh.text).toContain("Too many attempts. Try again in a few minutes.");
  });
});

describe("typed invite codes, per IP", () => {
  it("allows ten in a quarter hour, then refuses before looking anything up, even the right code", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const noisy = browserAt(portal, "10.50.2.1");
    const entry = await emailStep(noisy, "inv-entry", email);

    for (let n = 0; n < 10; n += 1) {
      const reply = await inviteStep(noisy, entry, "inv-entry", `ghost-d${n}@pilot.test`, "AAAAA-AAAAA-AAAAA-AAAAA");
      expect(reply.status, `guess ${n + 1}`).toBe(200); // a stranger's address: "no access", not a throttle
    }
    const throttled = await inviteStep(noisy, entry, "inv-entry", email, code);

    expect(throttled.status).toBe(429);
    expect(otpMails(portal)).toHaveLength(0);
    expect(await statusOf(portal, fixture, email)).toBe("invited");

    // It was the caller that ran out, not the code.
    const elsewhere = browserAt(portal, "10.50.2.2");
    const page = await emailStep(elsewhere, "inv-elsewhere", email);
    const ok = await inviteStep(elsewhere, page, "inv-elsewhere", email, code);
    expect(ok.status).toBe(200);
    expect(await statusOf(portal, fixture, email)).toBe("active");
  });
});

describe("'e-mail me my invite again', per address", () => {
  it("allows four invites an hour for an address, operator-issued included, then says how long to wait", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "rs-0", email);

    for (let n = 1; n <= 3; n += 1) {
      clock.advance(61 * 1000);
      const reply = await resendInviteStep(agent, entry, "rs-0", email);
      expect(reply.status, `resend ${n}`).toBe(200);
    }
    expect(inviteMails(portal)).toHaveLength(4);

    clock.advance(61 * 1000);
    const blocked = await resendInviteStep(agent, entry, "rs-0", email);

    expect(blocked.status).toBe(429);
    expect(blocked.text).toContain("An invite was e-mailed recently");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(inviteMails(portal)).toHaveLength(4);

    // An hour on, the oldest has aged out and another is allowed.
    clock.advance(60 * 60 * 1000);
    expect((await resendInviteStep(agent, entry, "rs-0", email)).status).toBe(200);
  });

  it("is refused for a locked invite: five wrong codes need the admin, not another e-mail", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    let page = await emailStep(agent, "lk-0", email);
    for (let n = 0; n < 5; n += 1) {
      page = await inviteStep(agent, page, "lk-0", email, `NOPE${n}`.padEnd(20, "B"));
    }
    clock.advance(2 * 60 * 1000);

    const reply = await resendInviteStep(agent, page, "lk-0", email);

    expect(reply.status).toBe(429);
    expect(reply.text).toContain("Too many wrong invite codes");
    expect(inviteMails(portal)).toHaveLength(1);
  });
});
