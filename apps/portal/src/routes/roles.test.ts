/**
 * The role an operator invites someone with, round-tripped to what the host reads.
 *
 * The host used to give `owner` to every first-time sign-in, because the portal sent no role. Now the
 * invite carries one (`owner | admin | member`), redeeming it sets the member's, and the portal puts
 * it in the access token (claim `role`) and in the token response (`role`, beside `user_id`). These
 * tests walk it from `issueInvite` through a real browser sign-in and the token exchange to the
 * claim, then through a refresh after the operator changes it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { changeMemberRole } from "../invites";
import { addUser, type Fixture } from "../testing/fixtures";
import { startTestPortal, createAgent, type PortalHarness } from "../testing/server";
import {
  CLIENT_ID,
  REDIRECT,
  browserAt,
  emailStep,
  inviteStep,
  nextAddress,
  operatorInvites,
  otpMails,
  setupPilot,
  verifyStep,
} from "../testing/sign-in-kit";
import type { UserRole } from "../store/types";

let portal: PortalHarness;
let fixture: Fixture;
let clientSecret: string;

beforeAll(async () => {
  portal = await startTestPortal({ trustProxy: true });
  const pilot = await setupPilot(portal);
  fixture = pilot;
  clientSecret = pilot.clientSecret;
}, 180_000);

afterAll(async () => {
  await portal?.close();
});

beforeEach(() => {
  portal.mailer.clear();
});

interface TokenBody {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly device_id: string;
  readonly user_id: string;
  readonly role: UserRole;
}

function claimsOf(accessToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
}

/** An invitee's whole first sign-in, then the host's code exchange. */
async function signInAndExchange(email: string, inviteCode: string | null, state: string): Promise<TokenBody> {
  const agent = browserAt(portal);
  const entry = await emailStep(agent, state, email);
  const page = inviteCode === null ? entry : await inviteStep(agent, entry, state, email, inviteCode);
  const done = await verifyStep(agent, page, state, email, otpMails(portal).at(-1)?.code ?? "");
  expect(done.status).toBe(302);
  const code = new URL(done.location as string).searchParams.get("code") as string;

  const reply = await createAgent(portal.origin).postJson("/auth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    client_secret: clientSecret,
  });
  expect(reply.status).toBe(200);
  return reply.json<TokenBody>();
}

function refresh(body: TokenBody) {
  return createAgent(portal.origin).postJson("/auth/token", {
    grant_type: "refresh_token",
    refresh_token: body.refresh_token,
    device_id: body.device_id,
    client_id: CLIENT_ID,
    client_secret: clientSecret,
  });
}

describe("an invite's role reaches the token", () => {
  it.each(["owner", "admin", "member"] as const)(
    "carries %s from the invite to the member, the token response and the access token claim",
    async (role) => {
      const email = nextAddress();
      // A tenant with an owner already, so the invite's own role is what is under test.
      const { code, issued } = await operatorInvites(portal, fixture, email, { role });
      expect(issued.role).toBe(role);
      const member = await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.findById(issued.userId));
      expect(member).toMatchObject({ status: "invited", role });

      const body = await signInAndExchange(email, code, `role-${role}`);

      expect(body.role).toBe(role);
      expect(claimsOf(body.access_token).role).toBe(role);
      const redeemed = await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.findById(issued.userId));
      expect(redeemed).toMatchObject({ status: "active", role });
    },
  );

  it("is member by default: nobody is made an owner by leaving a flag out", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email);

    const body = await signInAndExchange(email, code, "role-default");

    expect(body.role).toBe("member");
    expect(claimsOf(body.access_token).role).toBe("member");
  });

  it("is the member's own row for a seeded owner and for a seeded member, never a default", async () => {
    const owner = await signInAndExchange(fixture.user.email, null, "role-seed-owner");
    const seeded = nextAddress();
    await addUser(portal.store.store, fixture, seeded);
    const member = await signInAndExchange(seeded, null, "role-seed-member");

    expect(owner.role).toBe("owner");
    expect(member.role).toBe("member");
    expect(claimsOf(member.access_token).role).toBe("member");
  });

  it("is on /auth/session too, under the member", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email, { role: "admin" });
    const body = await signInAndExchange(email, code, "role-session");

    const reply = await createAgent(portal.origin).get("/auth/session", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });

    expect(reply.status).toBe(200);
    expect(reply.json<{ user: { role: string } }>().user.role).toBe("admin");
  });
});

describe("a role the operator changes", () => {
  it("arrives with the next refresh, in the response and in the claim, and the old token is untouched", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email, { role: "member" });
    const first = await signInAndExchange(email, code, "role-change");
    expect(claimsOf(first.access_token).role).toBe("member");

    const changed = await changeMemberRole(portal.store.store, {
      tenantSlug: fixture.tenant.slug,
      email,
      role: "admin",
    });
    expect(changed).toMatchObject({ ok: true, from: "member", to: "admin" });

    const refreshed = (await refresh(first)).json<TokenBody>();
    expect(refreshed.role).toBe("admin");
    expect(claimsOf(refreshed.access_token).role).toBe("admin");
    // What was already issued is a signed statement; it is not rewritten.
    expect(claimsOf(first.access_token).role).toBe("member");
  });

  it("is refused at refresh for a member who was disabled, so no token carries any role for them", async () => {
    const email = nextAddress();
    const { code } = await operatorInvites(portal, fixture, email, { role: "admin" });
    const first = await signInAndExchange(email, code, "role-gone");
    const member = await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.findByEmail(fixture.tenant.id, email));

    // The refresh is refused outright, so no token is minted at all; and `roleOf` (flows/token.ts)
    // answers member, never owner, for a member it cannot read.
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.setStatus(member?.id as string, "disabled"));
    const refused = await refresh(first);

    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.json())).not.toContain("owner");
  });
});
