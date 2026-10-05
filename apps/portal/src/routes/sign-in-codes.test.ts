/**
 * Two things the sign-in codes must not do, found by driving the pilot (2026-10-01):
 *
 *   M1  a code that a newer one replaced signed somebody in again, once the newer one was used;
 *   M2  a double submit, a reload or a re-post of the same step mailed two or three codes and spent
 *       the three-a-quarter-hour budget, while only the newest code works.
 *
 * Driven the way a person drives it: a real server, the posted forms, a captured mailbox. Each test
 * runs from an address of its own (`x-forwarded-for`) so the per-IP budgets are not shared.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUser, type Fixture } from "../testing/fixtures";
import { fixedClock } from "../testing/pg";
import { startTestPortal, type PortalHarness } from "../testing/server";
import {
  browserAt,
  emailStep,
  inviteStep,
  nextAddress,
  operatorInvites,
  otpMails,
  postStep,
  setupPilot,
  startPage,
  statusOf,
  verifyStep,
} from "../testing/sign-in-kit";

const clock = fixedClock();
let portal: PortalHarness;
let fixture: Fixture;

beforeAll(async () => {
  portal = await startTestPortal({ trustProxy: true, clock });
  fixture = await setupPilot(portal);
}, 180_000);

afterAll(async () => {
  await portal?.close();
});

beforeEach(() => {
  portal.mailer.clear();
  clock.set(new Date());
});

function words(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const MINUTE = 60 * 1000;

describe("M1: a code that was replaced stays dead", () => {
  it("does not sign anybody in after the code that replaced it was used", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m1-a", email);
    expect(otpMails(portal)).toHaveLength(1);
    clock.advance(2 * MINUTE);
    const second = await postStep(agent, "/authorize/email", first, "m1-a", { email, resend: "1" });
    expect(otpMails(portal)).toHaveLength(2);
    const codeA = otpMails(portal)[0].code ?? "";
    const codeB = otpMails(portal)[1].code ?? "";
    expect(codeA).not.toBe(codeB);

    const done = await verifyStep(agent, second, "m1-a", email, codeB);
    expect(done.status).toBe(302);
    expect(new URL(done.location as string).searchParams.get("code")).toBeTruthy();

    // The page that signed in is gone; a second browser, with no portal session, replays code A.
    const thief = browserAt(portal);
    const entry = await startPage(thief, "m1-a2");
    const replay = await verifyStep(thief, entry, "m1-a2", email, codeA);

    expect(replay.status).toBe(400);
    expect(replay.location).toBeNull();
    expect(words(replay.text)).toContain("That code has expired. Start again.");
  });

  it("does not sign anybody in with the first code once a second was requested, even before the second is used", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m1-b", email);
    clock.advance(2 * MINUTE);
    await postStep(agent, "/authorize/email", first, "m1-b", { email, resend: "1" });
    const codeA = otpMails(portal)[0].code ?? "";

    const reply = await verifyStep(agent, first, "m1-b", email, codeA);

    expect(reply.status).toBe(400);
    expect(reply.location).toBeNull();
  });
});

describe("M2: one request is one code", () => {
  it("answers a repeated post of the e-mail step with the code page and mails nothing more", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m2-a", email);
    expect(otpMails(portal)).toHaveLength(1);

    const again = await postStep(agent, "/authorize/email", first, "m2-a", { email });
    const third = await postStep(agent, "/authorize/email", again, "m2-a", { email });

    // The page is the code page, saying the true thing: a code was sent.
    for (const reply of [again, third]) {
      expect(reply.status).toBe(200);
      expect(words(reply.text)).toContain(`We sent a sign-in code to ${email}.`);
      expect(reply.text).toContain('name="code"');
    }
    expect(otpMails(portal)).toHaveLength(1);
    // And the one code that went still works: nobody burned a guess on a stale one.
    const done = await verifyStep(agent, third, "m2-a", email, otpMails(portal)[0].code ?? "");
    expect(done.status).toBe(302);
  });

  it("does not spend the three sends a quarter hour allows on repeats", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    let page = await emailStep(agent, "m2-b", email);
    for (let repeat = 0; repeat < 4; repeat += 1) {
      page = await postStep(agent, "/authorize/email", page, "m2-b", { email });
    }
    expect(otpMails(portal)).toHaveLength(1);

    // Two explicit resends are still there to use: three sends in all.
    clock.advance(2 * MINUTE);
    const resent = await postStep(agent, "/authorize/email", page, "m2-b", { email, resend: "1" });
    expect(resent.status).toBe(200);
    clock.advance(2 * MINUTE);
    const resentAgain = await postStep(agent, "/authorize/email", resent, "m2-b", { email, resend: "1" });
    expect(resentAgain.status).toBe(200);
    expect(otpMails(portal)).toHaveLength(3);
  });

  it("makes one code of two posts that arrive together", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const start = await startPage(agent, "m2-c");

    const [one, two] = await Promise.all([
      postStep(agent, "/authorize/email", start, "m2-c", { email }),
      postStep(agent, "/authorize/email", start, "m2-c", { email }),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("sends a fresh code when the same step is posted again after the window", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m2-d", email);
    clock.advance(30 * 1000);

    const later = await postStep(agent, "/authorize/email", first, "m2-d", { email });

    expect(later.status).toBe(200);
    expect(otpMails(portal)).toHaveLength(2);
    // The newest is the one that works; the first was retired by it (M1).
    expect((await verifyStep(agent, later, "m2-d", email, otpMails(portal)[1].code ?? "")).status).toBe(302);
  });

  it("still holds an explicit 'send me a new code' to its own minute", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m2-e", email);
    clock.advance(30 * 1000);

    const tooSoon = await postStep(agent, "/authorize/email", first, "m2-e", { email, resend: "1" });

    expect(tooSoon.status).toBe(429);
    expect(words(tooSoon.text)).toContain("A code was sent a moment ago");
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("does not take a used code for a live one: signing in, then starting again at once, sends a code", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "m2-f", email);
    expect((await verifyStep(agent, first, "m2-f", email, otpMails(portal)[0].code ?? "")).status).toBe(302);

    const other = browserAt(portal);
    await emailStep(other, "m2-f2", email);

    expect(otpMails(portal)).toHaveLength(2);
  });

  it("does not tell a person a code was sent when the mail transport had refused it", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    portal.mailer.failNext();
    const failed = await emailStep(agent, "m2-g", email);
    expect(failed.status).toBe(503);
    expect(otpMails(portal)).toHaveLength(0);

    // A reload of that posted page: nothing was delivered, so something has to be.
    const again = await postStep(agent, "/authorize/email", failed, "m2-g", { email });

    expect(again.status).toBe(200);
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("answers a repeated post of the invite step without a second code", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "m2-h", email);

    const redeemed = await inviteStep(agent, entry, "m2-h", email, code);
    expect(words(redeemed.text)).toContain(`We just sent a sign-in code to ${email} to confirm it is your inbox.`);
    const repeat = await inviteStep(agent, redeemed, "m2-h", email, code);
    // Whatever was typed, the member is active now: the page is the code page, the code is the one
    // that was mailed, and no wrong-code attempt was counted against anything.
    expect(repeat.status).toBe(200);
    expect(repeat.text).toContain('name="code"');
    expect(otpMails(portal)).toHaveLength(1);
    expect(await statusOf(portal, fixture, email)).toBe("active");

    const done = await verifyStep(agent, repeat, "m2-h", email, otpMails(portal)[0].code ?? "");
    expect(done.status).toBe(302);
  });

  it("makes one code of a double-clicked invite", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "m2-i", email);

    const [one, two] = await Promise.all([
      inviteStep(agent, entry, "m2-i", email, code),
      inviteStep(agent, entry, "m2-i", email, code),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    expect(otpMails(portal)).toHaveLength(1);
  });
});
