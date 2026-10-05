/**
 * The sign-in as a state machine, driven the way a person drives it: a real server, the e-mail
 * step, then whichever screen the portal answers with, and a captured mailbox.
 *
 * Owner decision (2026-10-01): nobody signs up; a first sign-in needs the invite an operator had the
 * portal e-mail to that address; every later one needs only the e-mailed six-digit code. And the page
 * says which situation the person is in. This file walks every situation the owner listed:
 *
 *   1. an activated member           2. invited, not yet activated     3. invite expired or used
 *   4. not invited / unknown         5. already signed in              6. locked out
 *   7. wrong invite code             8. address typed with other case or whitespace
 *   9. member removed
 *
 * Each test runs from an address of its own (`x-forwarded-for`, on a portal that trusts the proxy),
 * so the budget for typed invite codes, which is per IP, is not one test spending the next one's.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUser, seedFixture, type Fixture } from "../testing/fixtures";
import { fixedClock } from "../testing/pg";
import { startTestPortal, type PortalHarness } from "../testing/server";
import {
  authorizeUrl,
  auditRows,
  browserAt,
  emailStep,
  inviteMails,
  inviteStep,
  nextAddress,
  operatorInvites,
  otpMails,
  postStep,
  resendInviteStep,
  setupPilot,
  shapeOf,
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
  // The database stamps rows with real time and the portal reads its own clock, so a clock a test
  // moved ahead would make the next test's cooldown and expiry arithmetic compare two timelines.
  clock.set(new Date());
});

/** A page a person reads, flattened: tags and entities gone, whitespace collapsed. */
function words(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("1. an activated member", () => {
  it("is told a sign-in code was sent to their address, and the code signs them in", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);

    const page = await emailStep(agent, "s1-a", email);

    expect(page.status).toBe(200);
    expect(words(page.text)).toContain(`We sent a sign-in code to ${email}.`);
    expect(page.text).toContain('name="code"');
    expect(otpMails(portal)).toHaveLength(1);
    expect(otpMails(portal)[0].to).toBe(email);
    // Never the invite screen, and never a button that promises a code it will not send.
    expect(page.text).not.toContain('name="invite_code"');

    const done = await verifyStep(agent, page, "s1-a", email, otpMails(portal)[0].code ?? "");
    expect(done.status).toBe(302);
    expect(new URL(done.location as string).searchParams.get("code")).toBeTruthy();
  });

  it("never sees the word 'send' on the first button, which is 'Continue'", async () => {
    const start = await startPage(browserAt(portal), "s1-b");

    expect(start.text).toContain(">Continue</button>");
    expect(start.text).not.toContain("Send code");
    expect(start.text.toLowerCase()).not.toContain("password");
  });

  it("can ask for a new code, but not within the first minute", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const first = await emailStep(agent, "s1-c", email);
    expect(otpMails(portal)).toHaveLength(1);

    const tooSoon = await postStep(agent, "/authorize/email", first, "s1-c", { email, resend: "1" });

    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(words(tooSoon.text)).toContain("A code was sent a moment ago");
    expect(otpMails(portal)).toHaveLength(1);

    clock.advance(2 * 60 * 1000);
    const later = await postStep(agent, "/authorize/email", tooSoon, "s1-c", { email, resend: "1" });

    expect(later.status).toBe(200);
    expect(otpMails(portal)).toHaveLength(2);
    // The newest code is the one that works.
    expect((await verifyStep(agent, later, "s1-c", email, otpMails(portal)[1].code ?? "")).status).toBe(302);
  });

  it("is told so, and nothing is sent, when the mail transport refuses the message", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    portal.mailer.failNext();

    const page = await emailStep(browserAt(portal), "s1-d", email);

    expect(page.status).toBe(503);
    expect(words(page.text)).toContain(`We could not send a sign-in code to ${email} just now.`);
    expect(page.text).toContain("Send a new code");
    expect(portal.mailer.sent).toHaveLength(0);
    expect((await auditRows(portal, fixture, "otp.send_failed")).length).toBeGreaterThan(0);
  });
});

describe("2. invited, not yet activated", () => {
  it("is asked for the invite code that was e-mailed to them, and no sign-in code is sent yet", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    expect(await statusOf(portal, fixture, email)).toBe("invited");

    const page = await emailStep(browserAt(portal), "s2-a", email);

    expect(page.status).toBe(200);
    expect(words(page.text)).toContain(`Enter the invite code we e-mailed to ${email}.`);
    expect(page.text).toContain('name="invite_code"');
    expect(page.text).not.toContain('name="code"');
    expect(otpMails(portal)).toHaveLength(0);
    expect(await statusOf(portal, fixture, email)).toBe("invited");
    expect((await auditRows(portal, fixture, "otp.withheld")).some((row) => row.reasonCode === "invite_required")).toBe(
      true,
    );
  });

  it("goes straight to the e-mailed code after a valid invite, which activates the member", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-b", email);

    const next = await inviteStep(agent, entry, "s2-b", email, code);

    expect(next.status).toBe(200);
    expect(words(next.text)).toContain(`We just sent a sign-in code to ${email} to confirm it is your inbox.`);
    expect(otpMails(portal)).toHaveLength(1);
    expect(await statusOf(portal, fixture, email)).toBe("active");
    expect((await auditRows(portal, fixture, "invite.redeemed")).length).toBeGreaterThan(0);

    // The invite opened the door; the mailbox is still proved.
    const done = await verifyStep(agent, next, "s2-b", email, otpMails(portal)[0].code ?? "");
    expect(done.status).toBe(302);
  });

  it("takes the code as a person types it: lower case, spaces, no dashes", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-c", email);

    const next = await inviteStep(agent, entry, "s2-c", email, ` ${code.toLowerCase().replace(/-/g, " ")} `);

    expect(next.status).toBe(200);
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("is not stranded by a double click: the second post carries on to the e-mailed code", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-d", email);

    const [one, two] = await Promise.all([
      inviteStep(agent, entry, "s2-d", email, code),
      inviteStep(agent, entry, "s2-d", email, code),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    expect(words(one.text + two.text)).not.toContain("invite code is not right");
    expect(await statusOf(portal, fixture, email)).toBe("active");
  });

  it("can have the invite e-mailed again, once the minute is up, and only the new code works", async () => {
    const email = nextAddress();
    const { code: original } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-e", email);

    const tooSoon = await resendInviteStep(agent, entry, "s2-e", email);
    expect(tooSoon.status).toBe(429);
    expect(words(tooSoon.text)).toContain("An invite was e-mailed recently");
    expect(inviteMails(portal)).toHaveLength(1);

    clock.advance(2 * 60 * 1000);
    const resent = await resendInviteStep(agent, tooSoon, "s2-e", email);
    expect(resent.status).toBe(200);
    expect(words(resent.text)).toContain("We e-mailed you a new invite code. The earlier one no longer works.");
    expect(inviteMails(portal)).toHaveLength(2);
    const fresh = inviteMails(portal)[1].inviteCode ?? "";
    expect(fresh).not.toBe(original);

    const stale = await inviteStep(agent, resent, "s2-e", email, original);
    expect(stale.status).toBe(400);
    expect(words(stale.text)).toContain("That invite code is not right.");
    const good = await inviteStep(agent, stale, "s2-e", email, fresh);
    expect(good.status).toBe(200);
    expect(await statusOf(portal, fixture, email)).toBe("active");
  });

  it("never extends the invite by asking for it again", async () => {
    const email = nextAddress();
    const { issued } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-f", email);
    clock.advance(2 * 60 * 1000);

    await resendInviteStep(agent, entry, "s2-f", email);

    const latest = await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.invites.latestForEmail(fixture.tenant.id, email),
    );
    expect(latest?.id).not.toBe(issued.inviteId);
    expect(latest?.expiresAt).toBe(issued.expiresAt);
  });

  it("can start over with another address", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s2-g", email);

    const restarted = await postStep(agent, "/authorize/email", entry, "s2-g", { restart: "1" });

    expect(restarted.status).toBe(200);
    expect(restarted.text).toContain('name="email"');
    expect(restarted.text).not.toContain(email);
  });

  it("gets the invite e-mail in Indonesian when the operator asks, and the screens follow the browser", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email, { locale: "id" });
    expect(inviteMails(portal)[0].subject).toContain("Anda diundang");

    const page = await emailStep(browserAt(portal), "s2-h", email, {}, "/authorize/email?lang=id");

    expect(words(page.text)).toContain(`Masukkan kode undangan yang kami kirim ke ${email}.`);
    expect(page.text).toContain("Kirim ulang undangan ke e-mail saya");
  });
});

describe("3. an invite that has expired or was already used", () => {
  it("is told to ask the admin, and no sign-in code is sent", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email, { ttlMs: -1_000 });

    const page = await emailStep(browserAt(portal), "s3-a", email);

    expect(page.status).toBe(200);
    expect(words(page.text)).toContain("This invite has expired or was already used. Ask your admin for a new one.");
    expect(page.text).not.toContain('name="code"');
    expect(page.text).not.toContain('name="invite_code"');
    expect(otpMails(portal)).toHaveLength(0);
  });

  it("is told the same when the code is typed after it expired", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email, { ttlMs: 5_000 });
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s3-b", email);
    expect(words(entry.text)).toContain("Enter the invite code");
    clock.advance(10_000);

    const late = await inviteStep(agent, entry, "s3-b", email, code);

    expect(words(late.text)).toContain("This invite has expired or was already used.");
    expect(otpMails(portal)).toHaveLength(0);
    expect(await statusOf(portal, fixture, email)).toBe("invited");
  });

  it("covers an invite that was used but whose member was set back to invited", async () => {
    const email = nextAddress();
    const { code, issued } = await operatorInvites(portal, fixture, email);
    await portal.store.store.tx(fixture.tenant.id, async (ops) => {
      await ops.invites.redeem({ tenantId: fixture.tenant.id, email, rawCode: code });
      await ops.users.setStatus(issued.userId, "invited");
    });

    const page = await emailStep(browserAt(portal), "s3-c", email);

    expect(words(page.text)).toContain("This invite has expired or was already used.");
    expect(otpMails(portal)).toHaveLength(0);
  });

  it("covers an invited member with no invite at all", async () => {
    const email = nextAddress();
    await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.users.create({ tenantId: fixture.tenant.id, orgId: fixture.org.id, email, status: "invited" }),
    );

    const page = await emailStep(browserAt(portal), "s3-d", email);

    expect(words(page.text)).toContain("Ask your admin for a new one.");
    expect(otpMails(portal)).toHaveLength(0);
  });

  it("has no 'e-mail me my invite again' for an invite that is gone: that is the admin's call", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email, { ttlMs: -1_000 });
    const agent = browserAt(portal);
    const page = await emailStep(agent, "s3-e", email);

    const reply = await resendInviteStep(agent, page, "s3-e", email);

    expect(words(reply.text)).toContain("This invite has expired or was already used.");
    expect(inviteMails(portal)).toHaveLength(1);
  });
});

describe("4. not invited, or unknown", () => {
  it("is told the address has no access yet, and nothing is sent", async () => {
    const page = await emailStep(browserAt(portal), "s4-a", "nobody-at-all@pilot.test");

    expect(page.status).toBe(200);
    expect(words(page.text)).toContain(
      "This e-mail does not have access yet. Ask your company admin to invite you.",
    );
    expect(portal.mailer.sent).toHaveLength(0);
    expect(page.text).toContain("Use a different e-mail");
  });

  it("is the same for a disabled member, who is not mailed a code that could not get them in", async () => {
    const email = nextAddress();
    const member = await addUser(portal.store.store, fixture, email);
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(member.id, "disabled"));

    const page = await emailStep(browserAt(portal), "s4-b", email);

    expect(words(page.text)).toContain("does not have access yet");
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("is the same for an address that belongs to a different tenant than this client's", async () => {
    const elsewhere = await seedFixture(portal.store.store, { slug: "elsewhere", email: "owner@elsewhere.test" });
    const page = await emailStep(browserAt(portal), "s4-c", elsewhere.user.email);

    expect(words(page.text)).toContain("does not have access yet");
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("answers an unknown address and a typed invite code from a stranger with the same page", async () => {
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s4-d", "ghost@pilot.test");
    const typed = await inviteStep(agent, entry, "s4-d", "ghost@pilot.test", "AAAAA-AAAAA-AAAAA-AAAAA");
    const plain = await emailStep(browserAt(portal), "s4-d", "other-ghost@pilot.test");

    expect(shapeOf(typed)).toEqual(shapeOf(plain));
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("is the same page on the device-code sign-in, so neither door says more than the other", async () => {
    const agent = browserAt(portal);
    const start = await agent.get("/activate");
    const page = await agent.postForm("/activate/email", {
      csrf_token: start.text.match(/name="csrf_token" value="([^"]*)"/)?.[1] ?? "",
      user_code: "",
      email: "ghost@pilot.test",
    });

    expect(words(page.text)).toContain("does not have access yet");
  });
});

describe("5. already signed in", () => {
  it("skips the sign-in entirely on the portal's own session, which is how the app is rejoined", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s5-a", email);
    await verifyStep(agent, entry, "s5-a", email, otpMails(portal)[0].code ?? "");
    portal.mailer.clear();

    const again = await agent.get(authorizeUrl("s5-a2"));

    expect(again.status).toBe(302);
    expect(new URL(again.location as string).searchParams.get("state")).toBe("s5-a2");
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("is greeted by address on the portal's own device screen, with a way out", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s5-b", email);
    await verifyStep(agent, entry, "s5-b", email, otpMails(portal)[0].code ?? "");

    const screen = await agent.get("/activate");

    expect(words(screen.text)).toContain(`You are signed in as ${email}.`);
    expect(screen.text).toContain("Not you? Sign out");
    expect(screen.text).toContain('action="/logout"');

    const out = await agent.postForm("/logout", {
      csrf_token: screen.text.match(/name="csrf_token" value="([^"]*)"/)?.[1] ?? "",
    });
    expect(out.status).toBe(200);
    expect(words(out.text)).toContain("Your sign-in on this browser has ended");

    const after = await agent.get("/activate");
    expect(after.text).toContain('name="email"');
    expect(after.text).not.toContain("You are signed in as");
  });
});

describe("6. locked out", () => {
  it("is told an invitee has used up their invite code attempts, and the right code no longer helps", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    let page = await emailStep(agent, "s6-a", email);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      page = await inviteStep(agent, page, "s6-a", email, `WRONG-${attempt}`.padEnd(23, "A"));
    }
    const locked = await inviteStep(agent, page, "s6-a", email, code);

    expect(locked.status).toBe(429);
    expect(words(locked.text)).toContain("Too many wrong invite codes for this e-mail. Ask your admin for a new invite.");
    expect(otpMails(portal)).toHaveLength(0);
    expect(await statusOf(portal, fixture, email)).toBe("invited");

    // And it is what that address is told from the first step onwards.
    const invitedRow = await portal.store.store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, email));
    const again = await emailStep(browserAt(portal), "s6-a2", email);
    expect(words(again.text)).toContain("Too many wrong invite codes");
    const refusals = (await auditRows(portal, fixture, "invite.refused")).filter((row) => row.targetId === (invitedRow?.userId ?? ""));
    expect(refusals.filter((row) => row.reasonCode === "wrong_code")).toHaveLength(5);
    // Nothing is written for the refusals after the lock: the table is append-only.
    expect(refusals.filter((row) => row.reasonCode === "locked")).toHaveLength(0);
  });

  it("is told it is locked by the fifth wrong code itself, not shown '0 attempts left' and the form again", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    let page = await emailStep(agent, "s6-e", email);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      page = await inviteStep(agent, page, "s6-e", email, `WRONG-${attempt}`.padEnd(23, "A"));
      expect(page.status).toBe(400);
      expect(words(page.text)).toContain(`That invite code is not right. ${5 - attempt} attempts left.`);
    }
    const fifth = await inviteStep(agent, page, "s6-e", email, "WRONG-5".padEnd(23, "A"));

    expect(fifth.status).toBe(429);
    expect(words(fifth.text)).toContain(
      "Too many wrong invite codes for this e-mail. Ask your admin for a new invite.",
    );
    expect(words(fifth.text)).not.toContain("0 attempts left");
    // No form to type into: the dead end says ask the admin.
    expect(fifth.text).not.toContain('name="invite_code"');
    // And it is the same page the first step shows from now on.
    const again = await emailStep(browserAt(portal), "s6-e2", email);
    expect(words(again.text)).toContain("Too many wrong invite codes");
  });

  /**
   * Twenty wrong guesses spent today: four codes, five guesses each. Each send and each guess in a
   * transaction of its own, because rows made in one transaction share one created_at and "the
   * newest code" would be ambiguous. The clock ends 16 minutes after the first code was minted.
   */
  async function spendTheDay(email: string): Promise<void> {
    const { store } = portal.store;
    for (let n = 0; n < 4; n += 1) {
      if (n === 3) {
        // Three codes fit in one fifteen-minute window; the fourth waits it out.
        clock.advance(16 * 60 * 1000);
      }
      await store.tx(fixture.tenant.id, (ops) =>
        ops.loginOtps.send({ tenantId: fixture.tenant.id, email, code: String(n + 1).repeat(6), purpose: "portal_login" }),
      );
      for (let guess = 0; guess < 5; guess += 1) {
        await store.tx(fixture.tenant.id, (ops) =>
          ops.loginOtps.verify({ tenantId: fixture.tenant.id, email, code: "999999", purpose: "portal_login" }),
        );
      }
    }
  }

  it("is told when to try again, in both languages, without sending another code", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    await spendTheDay(email);
    // Five hours on, the first code is 5 h 16 min old: the day's total drops under twenty when it
    // leaves the window, 18 h 44 min from now, which the page rounds up to whole hours.
    clock.advance(5 * 60 * 60 * 1000);

    const english = await emailStep(browserAt(portal), "s6-b", email);
    const indonesian = await emailStep(browserAt(portal), "s6-b", email, {}, "/authorize/email?lang=id");

    expect(english.status).toBe(429);
    expect(words(english.text)).toContain("Too many attempts for this e-mail. Try again in 19 h or ask your admin.");
    expect(words(indonesian.text)).toContain("Coba lagi dalam 19 jam atau hubungi admin Anda.");
    expect(otpMails(portal)).toHaveLength(0);
    expect((await auditRows(portal, fixture, "otp.withheld")).some((row) => row.reasonCode === "otp_locked")).toBe(true);
  });

  it("says the wait in minutes once less than an hour is left", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    await spendTheDay(email);
    // 16 min after the first code the clock stands; 23 h 15 min more leaves about 29 minutes.
    clock.advance((23 * 60 + 15) * 60 * 1000);

    const page = await emailStep(browserAt(portal), "s6-c", email);

    expect(page.status).toBe(429);
    expect(words(page.text)).toMatch(/Try again in (2[89]|3[01]) min or ask your admin\./);
  });

  it("says it on the code screen too, for a person who was already past the e-mail step", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const start = await startPage(agent, "s6-d");
    await spendTheDay(email);
    clock.advance(5 * 60 * 60 * 1000);

    const reply = await verifyStep(agent, start, "s6-d", email, "123456");

    expect(words(reply.text)).toContain("Too many attempts for this e-mail. Try again in 19 h or ask your admin.");
  });
});

describe("7. a wrong code", () => {
  it("shows the attempts left for an invite code, and counts down", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s7-a", email);

    const first = await inviteStep(agent, entry, "s7-a", email, "AAAAA-AAAAA-AAAAA-AAAAA");
    const second = await inviteStep(agent, first, "s7-a", email, "BBBBB-BBBBB-BBBBB-BBBBB");

    expect(first.status).toBe(400);
    expect(words(first.text)).toContain("That invite code is not right. 4 attempts left.");
    expect(words(second.text)).toContain("That invite code is not right. 3 attempts left.");
    // Never echoed back, and the address is kept for the next try.
    expect(second.text).not.toContain("BBBBB");
    expect(second.text).toContain(`value="${email}"`);
    expect(otpMails(portal)).toHaveLength(0);
  });

  it("shows the attempts left for a wrong sign-in code too", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s7-b", email);
    const real = otpMails(portal)[0].code;
    const wrong = real === "000000" ? "111111" : "000000";

    const reply = await verifyStep(agent, entry, "s7-b", email, wrong);

    expect(reply.status).toBe(400);
    expect(words(reply.text)).toContain("That code is not right. 4 attempts left.");
    expect(reply.text).toContain("Send a new code");
  });

  it("asks for the invite code when the field is empty, without counting it", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s7-c", email);

    const reply = await inviteStep(agent, entry, "s7-c", email, "   ");

    expect(reply.status).toBe(400);
    expect(words(reply.text)).toContain("Enter the invite code from the e-mail.");
    const row = await portal.store.store.tx(fixture.tenant.id, (ops) => ops.invites.latestForEmail(fixture.tenant.id, email));
    expect(row?.failedAttempts).toBe(0);
  });
});

describe("8. an address typed with another case or whitespace", () => {
  it("is the same address, and binds to the same invite", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const messy = `  ${email.toUpperCase()}  `;

    const entry = await emailStep(agent, "s8-a", messy);
    expect(words(entry.text)).toContain(`Enter the invite code we e-mailed to ${email}.`);

    const next = await inviteStep(agent, entry, "s8-a", ` ${email.toUpperCase()} `, code);
    expect(words(next.text)).toContain(`We just sent a sign-in code to ${email}`);
    expect(otpMails(portal)[0].to).toBe(email);
  });

  it("is the same member for a seeded address typed in capitals", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);

    const page = await emailStep(browserAt(portal), "s8-b", `\t${email.toUpperCase()}`);

    expect(words(page.text)).toContain(`We sent a sign-in code to ${email}.`);
  });
});

describe("9. a member who was removed", () => {
  async function removeMember(email: string): Promise<void> {
    // The portal's own role has no DELETE on users, as it should not: removal is the owner's
    // connection's work. And a plain DELETE does not work for anyone with an audit row, which is
    // everyone who ever signed in, TWICE over. audit_log.actor_user_id is ON DELETE SET NULL, which
    // is an UPDATE the append-only trigger refuses; and with that trigger off, the NULL it writes
    // breaks audit_log_actor_shape_chk, which wants a user actor to name a user. So the audit rows
    // that name this member go first, with the trigger off for the statement -- the shape an erase
    // has to take, and a finding for whoever builds it -- and the member's sessions go with the row.
    const admin = new pg.Client({ connectionString: portal.store.database.url });
    await admin.connect();
    try {
      await admin.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
      await admin.query("DELETE FROM audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE email = $1)", [email]);
      await admin.query("DELETE FROM users WHERE email = $1", [email]);
    } finally {
      await admin.query("ALTER TABLE audit_log ENABLE TRIGGER USER").catch(() => undefined);
      await admin.end();
    }
  }

  it("is told what any stranger is told, and their old browser session is refused", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s9-a", email);
    await verifyStep(agent, entry, "s9-a", email, otpMails(portal)[0].code ?? "");
    expect((await agent.get(authorizeUrl("s9-a2"))).status).toBe(302);
    portal.mailer.clear();

    await removeMember(email);

    // The cookie still verifies, and no longer signs anybody in.
    const revisit = await agent.get(authorizeUrl("s9-a3"));
    expect(revisit.status).toBe(200);
    expect(revisit.location).toBeNull();
    expect(revisit.text).toContain('name="email"');

    const device = await agent.get("/activate");
    expect(device.text).toContain('name="email"');
    expect(device.text).not.toContain("You are signed in as");
    const approve = await agent.postForm("/auth/device/approve", {
      csrf_token: agent.cookies.get("portal_csrf") ?? "",
      user_code: "ABCD-EFGH",
      decision: "approve",
    });
    expect(approve.status).toBe(401);

    const page = await emailStep(browserAt(portal), "s9-a4", email);
    expect(words(page.text)).toContain("does not have access yet");
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("is refused a code and a device approval when the member was disabled instead, cookie and all", async () => {
    const email = nextAddress();
    const member = await addUser(portal.store.store, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "s9-c", email);
    await verifyStep(agent, entry, "s9-c", email, otpMails(portal)[0].code ?? "");
    portal.mailer.clear();
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(member.id, "disabled"));

    // The old cookie is no longer a session on the device screens...
    const device = await agent.get("/activate");
    expect(device.text).toContain('name="email"');
    expect(device.text).not.toContain("You are signed in as");
    // ...is sent back to the app with the portal's reason on /authorize, never with a code...
    const revisit = await agent.get(authorizeUrl("s9-c2"));
    expect(revisit.status).toBe(302);
    const target = new URL(revisit.location as string);
    expect(target.searchParams.get("error")).toBe("user_inactive");
    expect(target.searchParams.get("code")).toBeNull();
    // ...and the address is told what a stranger is told, with no mail.
    const page = await emailStep(browserAt(portal), "s9-c3", email);
    expect(words(page.text)).toContain("does not have access yet");
    expect(portal.mailer.sent).toHaveLength(0);
  });

  it("takes an invited member's invite with them", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    await removeMember(email);

    const page = await emailStep(browserAt(portal), "s9-b", email);

    expect(words(page.text)).toContain("does not have access yet");
  });
});

describe("the device-code door is the same decision", () => {
  it("sends an invitee to the invite screen and a valid code on to the e-mailed code", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const start = await agent.get("/activate");
    const csrf = start.text.match(/name="csrf_token" value="([^"]*)"/)?.[1] ?? "";

    const entry = await agent.postForm("/activate/email", { csrf_token: csrf, user_code: "", email });
    expect(words(entry.text)).toContain(`Enter the invite code we e-mailed to ${email}.`);
    expect(entry.text).toContain('action="/activate/invite"');
    expect(otpMails(portal)).toHaveLength(0);

    const next = await agent.postForm("/activate/invite", { csrf_token: csrf, user_code: "", email, invite_code: code });
    expect(words(next.text)).toContain(`We just sent a sign-in code to ${email}`);
    expect(next.text).toContain('action="/activate/verify"');
    expect(otpMails(portal)).toHaveLength(1);
    expect(await statusOf(portal, fixture, email)).toBe("active");
  });
});

describe("what never happens", () => {
  it("gives an invited member no session: the e-mailed code alone does not exist for them", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "n-a", email);

    // There is nothing to verify, but a forged post must not sign them in either.
    const forged = await verifyStep(agent, entry, "n-a", email, "123456");

    expect(forged.status).toBe(400);
    expect(forged.location).toBeNull();
    expect(agent.cookies.has("portal_session")).toBe(false);
  });

  it("writes no invite code, in either shape, to a log line or an audit row", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await emailStep(agent, "n-b", email);
    const wrong = await inviteStep(agent, entry, "n-b", email, "CCCCC-CCCCC-CCCCC-CCCCC");
    await inviteStep(agent, wrong, "n-b", email, code);

    const everything = [
      portal.logLines.join("\n"),
      JSON.stringify(await auditRows(portal, fixture, "invite.issued")),
      JSON.stringify(await auditRows(portal, fixture, "invite.mailed")),
      JSON.stringify(await auditRows(portal, fixture, "invite.redeemed")),
      JSON.stringify(await auditRows(portal, fixture, "invite.refused")),
    ].join("\n");
    for (const secret of [code, code.replace(/-/g, ""), "CCCCC-CCCCC-CCCCC-CCCCC", "CCCCCCCCCCCCCCCCCCCC"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("puts no password field on any screen of the sign-in", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const screens = [await startPage(agent, "n-c")];
    const entry = await emailStep(agent, "n-c", email);
    screens.push(entry, await inviteStep(agent, entry, "n-c", email, code));
    screens.push(await emailStep(browserAt(portal), "n-c", "ghost@pilot.test"));

    for (const screen of screens) {
      expect(screen.text.toLowerCase()).not.toContain('type="password"');
      expect(screen.text.toLowerCase()).not.toContain("password");
    }
  });
});
