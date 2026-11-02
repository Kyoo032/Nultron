/**
 * The seat cap, told at the first step instead of at the last (L2, 2026-10-01).
 *
 * The cap used to be checked only when the authorization code was exchanged. An invitee redeemed
 * their invite, typed the six-digit code from the mail, and only then landed on
 * `/sign-in?reason=seat_cap_reached` -- with the invite already spent. Now the e-mail step and the
 * invite step ask first (`orgs.hasSeatFor`, the seat branch of `login_precheck`), say "no seats
 * left" with the existing copy, and spend nothing: no invite, no code, no wrong-guess count.
 *
 * The exchange still checks, because a seat can go between the page and the exchange; that half is
 * pinned in `browser.test.ts` ("the login gate").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addUser, type Fixture } from "../testing/fixtures";
import { fixedClock } from "../testing/pg";
import { startTestPortal, type PortalHarness } from "../testing/server";
import {
  auditRows,
  browserAt,
  emailStep,
  inviteMails,
  inviteStep,
  nextAddress,
  operatorInvites,
  otpMails,
  setupPilot,
  startPage,
  statusOf,
  verifyStep,
} from "../testing/sign-in-kit";

const clock = fixedClock();
let portal: PortalHarness;
let fixture: Fixture;

/** The English line the portal already has for the `seat_cap_reached` reason. */
const NO_SEATS_EN = "No seats left in your organisation.";
const NO_SEATS_ID = "Semua kursi di organisasi Anda sudah terpakai.";

beforeAll(async () => {
  portal = await startTestPortal({ trustProxy: true, clock });
  fixture = await setupPilot(portal);
  // A one-seat org, and the owner holds the seat: a live session inside the 30-day window.
  await portal.store.store.tx(fixture.tenant.id, async (ops) => {
    await ops.orgs.setSeatCap(fixture.org.id, 1);
    const upserted = await ops.devices.upsert({
      tenantId: fixture.tenant.id,
      orgId: fixture.org.id,
      userId: fixture.user.id,
      installId: "install-seat-holder",
      platform: "windows",
    });
    if (!upserted.ok) {
      throw new Error("device revoked");
    }
    await ops.sessions.create({
      tenantId: fixture.tenant.id,
      orgId: fixture.org.id,
      userId: fixture.user.id,
      deviceId: upserted.device.id,
    });
  });
}, 180_000);

afterAll(async () => {
  await portal?.close();
});

beforeEach(async () => {
  portal.mailer.clear();
  clock.set(new Date());
  await setSeatCap(1);
});

function setSeatCap(seatCap: number): Promise<unknown> {
  return portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSeatCap(fixture.org.id, seatCap));
}

function words(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the e-mail step", () => {
  it("tells an invitee there is no seat before they are asked for an invite code", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);

    const page = await emailStep(browserAt(portal), "seat-a", email);

    expect(page.status).toBe(403);
    expect(words(page.text)).toContain(NO_SEATS_EN);
    expect(words(page.text)).toContain("Ask your admin");
    // Not the invite screen, not the code screen, and a way to try another address.
    expect(page.text).not.toContain('name="invite_code"');
    expect(page.text).not.toContain('name="code"');
    expect(page.text).toContain("Use a different e-mail");
    expect(otpMails(portal)).toHaveLength(0);
    expect(await statusOf(portal, fixture, email)).toBe("invited");
    const withheld = await auditRows(portal, fixture, "otp.withheld");
    expect(withheld.some((row) => row.reasonCode === "seat_cap_reached")).toBe(true);
  });

  it("says it in Indonesian when the browser asks for it", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);

    const page = await emailStep(browserAt(portal), "seat-b", email, {}, "/authorize/email?lang=id");

    expect(page.status).toBe(403);
    expect(words(page.text)).toContain(NO_SEATS_ID);
  });

  it("sends no sign-in code to an active member who would need a new seat", async () => {
    const email = nextAddress();
    await addUser(portal.store.store, fixture, email);

    const page = await emailStep(browserAt(portal), "seat-c", email);

    expect(page.status).toBe(403);
    expect(words(page.text)).toContain(NO_SEATS_EN);
    expect(otpMails(portal)).toHaveLength(0);
  });

  it("still signs in the person who already holds the seat, on a second browser", async () => {
    const agent = browserAt(portal);

    const page = await emailStep(agent, "seat-d", fixture.user.email);

    expect(page.status).toBe(200);
    expect(words(page.text)).toContain(`We sent a sign-in code to ${fixture.user.email}.`);
    expect(otpMails(portal)).toHaveLength(1);
    const done = await verifyStep(agent, page, "seat-d", fixture.user.email, otpMails(portal)[0].code ?? "");
    expect(done.status).toBe(302);
    expect(new URL(done.location as string).searchParams.get("code")).toBeTruthy();
  });

  it("lets an invitee through once a seat is added, with the invite never having been spent", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    expect((await emailStep(agent, "seat-e", email)).status).toBe(403);

    await setSeatCap(2);
    const entry = await emailStep(agent, "seat-e2", email);
    expect(words(entry.text)).toContain(`Enter the invite code we e-mailed to ${email}.`);
    const next = await inviteStep(agent, entry, "seat-e2", email, code);

    expect(next.status).toBe(200);
    expect(await statusOf(portal, fixture, email)).toBe("active");
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("is the same page on the device-code door", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const start = await agent.get("/activate");
    const csrf = start.text.match(/name="csrf_token" value="([^"]*)"/)?.[1] ?? "";

    const page = await agent.postForm("/activate/email", { csrf_token: csrf, user_code: "", email });

    expect(page.status).toBe(403);
    expect(words(page.text)).toContain(NO_SEATS_EN);
    expect(otpMails(portal)).toHaveLength(0);
  });
});

describe("the invite step", () => {
  it("does not redeem the invite, and says there is no seat, for a page that was open before the seat went", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    // The invite page is up while a seat is free...
    await setSeatCap(2);
    const entry = await emailStep(agent, "seat-f", email);
    expect(entry.text).toContain('name="invite_code"');
    // ...and the seat is taken before the code is posted.
    await setSeatCap(1);

    const posted = await inviteStep(agent, entry, "seat-f", email, code);

    expect(posted.status).toBe(403);
    expect(words(posted.text)).toContain(NO_SEATS_EN);
    expect(await statusOf(portal, fixture, email)).toBe("invited");
    expect(otpMails(portal)).toHaveLength(0);
    const invite = await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.invites.latestForEmail(fixture.tenant.id, email),
    );
    expect(invite?.redeemedAt).toBeNull();
    expect((await auditRows(portal, fixture, "invite.redeemed")).some((row) => row.targetId === invite?.id)).toBe(false);

    // The same invite works once there is room: nothing was spent.
    await setSeatCap(2);
    const retry = await inviteStep(agent, posted, "seat-f", email, code);
    expect(retry.status).toBe(200);
    expect(await statusOf(portal, fixture, email)).toBe("active");
    expect(otpMails(portal)).toHaveLength(1);
  });

  it("counts no wrong guess against the invite while there is no seat to give", async () => {
    const email = nextAddress();
    await operatorInvites(portal, fixture, email);
    const agent = browserAt(portal);
    const entry = await startPage(agent, "seat-g");

    let last = entry;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      last = await inviteStep(agent, last, "seat-g", email, `WRONG-${attempt}`.padEnd(23, "A"));
      expect(last.status).toBe(403);
    }

    const invite = await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.invites.latestForEmail(fixture.tenant.id, email),
    );
    expect(invite?.failedAttempts).toBe(0);
    expect(inviteMails(portal)).toHaveLength(1);
  });
});
