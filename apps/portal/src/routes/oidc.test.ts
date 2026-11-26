/**
 * The OIDC routes (F8b) against a stub IdP: `discovery` and the token exchange go through the
 * seam's `fetchImpl`, and `verifyIdToken` is stubbed so the suite decides which claims a token
 * carried. Everything else is real -- the state rows, the seal, the seat match, the audit rows
 * and the sign-in tail.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomToken } from "../crypto";
import { addUser, type Fixture } from "../testing/fixtures";
import { REDIRECT, authorizeUrl, browserAt, setupPilot } from "../testing/sign-in-kit";
import { emailStep, otpMails, startPage, verifyStep } from "../testing/sign-in-kit";
import {
  makePerson,
  postPassword,
  startPasswordPilot,
  startPage as passwordStartPage,
} from "../testing/password-kit";
import { startTestPortal, type PortalHarness } from "../testing/server";
import type { IdTokenResult } from "../oidc/verify-id-token";

const IDP = "https://idp.test";
const DISCOVERY_DOC = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: `${IDP}/authorize`,
  token_endpoint: `${IDP}/token`,
  jwks_uri: `${IDP}/jwks`,
};

/** What the stub IdP answers; `tokenStatus` flips the exchange to a failure for one test. */
const idp = { tokenStatus: 200 };

const idpFetch: typeof fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith("https://accounts.google.com/") || url.startsWith("https://login.microsoftonline.com/")) {
    return new Response(JSON.stringify(DISCOVERY_DOC), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === `${IDP}/token`) {
    if (idp.tokenStatus !== 200) {
      return new Response("denied", { status: idp.tokenStatus });
    }
    return new Response(JSON.stringify({ id_token: "stub-token", token_type: "Bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** The claims the stubbed verifier returns next; null means a verification failure. */
let nextVerify: IdTokenResult = {
  ok: true,
  claims: { sub: "subj-1", iss: "https://accounts.google.com", email: "", email_verified: true },
};
const stubVerify = async (): Promise<IdTokenResult> => nextVerify;

function verifyAs(email: string, subject = "subj-1"): void {
  nextVerify = {
    ok: true,
    claims: { sub: subject, iss: "https://accounts.google.com", email, email_verified: true },
  };
}

/** The google route's `start` URL, taken off the sign-in page itself. */
function ssoLink(page: string, provider = "google"): string {
  const match = new RegExp(`href="(/auth/oidc/${provider}/start[^"]*)"`).exec(page);
  if (!match) {
    throw new Error(`no ${provider} SSO link on the page`);
  }
  return match[1].replace(/&amp;/g, "&");
}

async function startRoundTrip(agent: ReturnType<typeof browserAt>, provider = "google"): Promise<string> {
  const page = await startPage(agent, "st-1");
  const start = await agent.get(ssoLink(page.text, provider));
  expect(start.status).toBe(302);
  const target = new URL(start.location as string);
  expect(target.origin).toBe(IDP);
  expect(target.pathname).toBe("/authorize");
  expect(target.searchParams.get("response_type")).toBe("code");
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  expect(target.searchParams.get("state")).toBeTruthy();
  return target.searchParams.get("state") as string;
}

/** The claims the microsoft stub returns next: Entra verified e-mail, or the own-tenant UPN. */
function verifyAsMicrosoft(email: string | null, subject = "msub-1", tid = "tenant-1"): void {
  nextVerify = {
    ok: true,
    claims: {
      sub: subject,
      iss: `https://login.microsoftonline.com/${tid}/v2.0`,
      tid,
      ...(email === null ? { preferred_username: "upn@pilot.test" } : { email, email_verified: true }),
    },
  };
}

async function auditActions(portal: PortalHarness, tenantId: string): Promise<string[]> {
  return portal.store.store.tx(tenantId, async (ops) => {
    const entries = await ops.audit.list({ tenantId });
    return entries.map((entry) => `${entry.action}:${entry.reasonCode ?? ""}`);
  });
}

let portal: PortalHarness;
let fixture: Fixture & { readonly clientSecret: string };

beforeAll(async () => {
  portal = await startTestPortal({
    config: {
      oidc: {
        google: { clientId: "g-client", clientSecret: "g-secret" },
        microsoft: { clientId: "m-client", clientSecret: "m-secret", tenant: "tenant-1" },
      },
    },
    routeOptions: { oidcSeams: { fetchImpl: idpFetch, verifyIdTokenImpl: stubVerify } },
  });
  fixture = await setupPilot(portal);
}, 120_000);

afterAll(async () => {
  await portal?.close();
});

describe("OIDC sign-in (F8b)", () => {
  it("offers a button per configured provider on the authorize page", async () => {
    const page = await browserAt(portal).get(authorizeUrl("st-x"));
    expect(ssoLink(page.text, "google")).toContain("/auth/oidc/google/start");
    expect(ssoLink(page.text, "microsoft")).toContain("/auth/oidc/microsoft/start");
    expect(page.text).toContain("Sign in with Google");
  });

  it("signs a member in through the whole round trip and audits it", async () => {
    verifyAs(fixture.user.email);
    const agent = browserAt(portal);
    const state = await startRoundTrip(agent);
    const reply = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(302);
    expect(reply.location?.startsWith(REDIRECT)).toBe(true);
    expect(new URL(reply.location as string).searchParams.get("code")).toBeTruthy();
    expect(agent.cookies.size).toBeGreaterThan(0);

    const actions = await auditActions(portal, fixture.tenant.id);
    expect(actions).toContain("oidc.sign_in:");
  });

  it("refuses a replayed callback: the state row is single-use", async () => {
    verifyAs(fixture.user.email);
    const agent = browserAt(portal);
    const state = await startRoundTrip(agent);
    const first = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(first.status).toBe(302);
    const replay = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(replay.status).toBe(400);
  });

  it("refuses an e-mail no seat matches, and audits the refusal", async () => {
    verifyAs("nobody@elsewhere.test", "subj-nobody");
    const agent = browserAt(portal);
    const state = await startRoundTrip(agent);
    const reply = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(400);
    const actions = await auditActions(portal, fixture.tenant.id);
    expect(actions).toContain("login.denied:oidc_no_member");
  });

  it("refuses a token that fails verification or an exchange that fails", async () => {
    nextVerify = { ok: false, reason: "bad_signature" };
    let agent = browserAt(portal);
    let state = await startRoundTrip(agent);
    let reply = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(400);
    let actions = await auditActions(portal, fixture.tenant.id);
    expect(actions).toContain("login.denied:oidc_token_bad_signature");

    verifyAs(fixture.user.email);
    idp.tokenStatus = 500;
    agent = browserAt(portal);
    state = await startRoundTrip(agent);
    reply = await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(400);
    idp.tokenStatus = 200;
    actions = await auditActions(portal, fixture.tenant.id);
    expect(actions).toContain("login.denied:oidc_token_exchange");
  });

  it("binds the identity on first sign-in, so the second does not ask the e-mail again", async () => {
    const member = await addUser(portal.store.store, fixture, "bound@pilot.test");
    verifyAs(member.email, "subj-bound");
    let agent = browserAt(portal);
    let state = await startRoundTrip(agent);
    expect(
      (await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=a`)).status,
    ).toBe(302);
    const bound = await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.oidc.findUserByIdentity(fixture.tenant.id, "https://accounts.google.com", "subj-bound"),
    );
    expect(bound).toBe(member.id);

    // Second sign-in with the same subject but an e-mail that matches nobody still signs in.
    verifyAs("changed@elsewhere.test", "subj-bound");
    agent = browserAt(portal);
    state = await startRoundTrip(agent);
    expect(
      (await agent.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=b`)).status,
    ).toBe(302);
  });

  it("refuses a callback in a browser that never started the sign-in", async () => {
    verifyAs(fixture.user.email);
    const starter = browserAt(portal);
    const state = await startRoundTrip(starter);
    // Another browser never received the transaction cookie, so a forwarded callback URL cannot
    // plant this sign-in's session in it -- and the real browser's round trip still works.
    const outsider = browserAt(portal);
    const planted = await outsider.get(
      `/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`,
    );
    expect(planted.status).toBe(400);
    const reply = await starter.get(`/auth/oidc/google/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(302);
  });

  it("does not trust a Microsoft UPN a different tenant asserted", async () => {
    // preferred_username is tenant-verified only inside the deployment's own Entra tenant: a
    // foreign tenant's admin can set any UPN they like, so it matches no seat.
    nextVerify = {
      ok: true,
      claims: {
        sub: "msub-foreign",
        iss: "https://login.microsoftonline.com/other-tid/v2.0",
        tid: "other-tid",
        preferred_username: fixture.user.email,
      },
    };
    const agent = browserAt(portal);
    const state = await startRoundTrip(agent, "microsoft");
    const reply = await agent.get(`/auth/oidc/microsoft/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(reply.status).toBe(400);
    const actions = await auditActions(portal, fixture.tenant.id);
    expect(actions).toContain("login.denied:oidc_no_member");
  });

  it("shows no SSO buttons on a bare /activate with no pending code", async () => {
    const reply = await browserAt(portal).get("/activate");
    expect(reply.status).toBe(200);
    expect(reply.text).not.toContain("/auth/oidc/");
  });

  it("redirects /activate to the tenant's sso_provider instead of the e-mail page", async () => {
    const device = await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.deviceCodes.create({ rawDeviceCode: randomToken(), installId: "inst-1", tenantId: fixture.tenant.id }),
    );
    await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.tenantConfig.upsert({ tenantId: fixture.tenant.id, featureFlags: { sso_provider: "google" } }),
    );
    const reply = await browserAt(portal).get(`/activate?code=${encodeURIComponent(device.userCode)}`);
    expect(reply.status).toBe(302);
    expect(reply.location).toContain("/auth/oidc/google/start");
    expect(reply.location).toContain("door=activate");
    await portal.store.store.tx(fixture.tenant.id, (ops) =>
      ops.tenantConfig.upsert({ tenantId: fixture.tenant.id, featureFlags: { sso_provider: null } }),
    );
  });
});

describe("sso_required", () => {
  it("turns the e-mailed code off for non-owners and says so", async () => {
    const member = await addUser(portal.store.store, fixture, "member@pilot.test");
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, true));
    try {
      const agent = browserAt(portal);
      const reply = await emailStep(agent, "st-sso", member.email);
      expect(reply.status).toBe(403);
      expect(reply.text).toContain("single sign-on");
      // And no code was sent.
      expect(portal.mailer.newest()?.to).not.toBe(member.email);
    } finally {
      await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, false));
    }
  });

  it("denies a non-owner who signed in through the provider sso_provider does not name", async () => {
    const member = await addUser(portal.store.store, fixture, "wrongprov@pilot.test");
    await portal.store.store.tx(fixture.tenant.id, async (ops) => {
      await ops.orgs.setSsoRequired(fixture.org.id, true);
      await ops.tenantConfig.upsert({ tenantId: fixture.tenant.id, featureFlags: { sso_provider: "google" } });
    });
    try {
      verifyAsMicrosoft(member.email, "msub-wrong");
      const agent = browserAt(portal);
      const state = await startRoundTrip(agent, "microsoft");
      const reply = await agent.get(
        `/auth/oidc/microsoft/callback?state=${encodeURIComponent(state)}&code=abc`,
      );
      expect(reply.status).toBe(400);
      const actions = await auditActions(portal, fixture.tenant.id);
      expect(actions).toContain("login.denied:oidc_wrong_provider");
    } finally {
      await portal.store.store.tx(fixture.tenant.id, async (ops) => {
        await ops.orgs.setSsoRequired(fixture.org.id, false);
        await ops.tenantConfig.upsert({ tenantId: fixture.tenant.id, featureFlags: { sso_provider: null } });
      });
    }
  });

  it("refuses an e-mail code that was still live when sso_required flipped on", async () => {
    const member = await addUser(portal.store.store, fixture, "pending@pilot.test");
    const agent = browserAt(portal);
    const codePage = await emailStep(agent, "st-pend", member.email);
    const code = otpMails(portal).at(-1)?.code;
    expect(code).toBeTruthy();
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, true));
    try {
      const reply = await verifyStep(agent, codePage, "st-pend", member.email, code as string);
      expect(reply.status).toBe(400);
      expect(reply.location ?? "").not.toContain(REDIRECT);
    } finally {
      await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, false));
    }
  });

  it("leaves the owner's code sign-in alone", async () => {
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, true));
    try {
      const agent = browserAt(portal);
      const reply = await emailStep(agent, "st-sso2", fixture.user.email);
      expect(reply.status).toBe(200);
      expect(reply.text).toContain(fixture.user.email);
    } finally {
      await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSsoRequired(fixture.org.id, false));
    }
  });
});

describe("sso_required under the password sign-in", () => {
  it("answers the SSO page text for a non-owner, not the one refusal", async () => {
    const pilot = await startPasswordPilot();
    try {
      const person = await makePerson(pilot, { role: "member", chosen: "Chosen-Password-1" });
      await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
        ops.orgs.setSsoRequired(pilot.fixture.org.id, true),
      );
      const agent = browserAt(pilot.portal);
      const page = await passwordStartPage(agent, "st-pw");
      const reply = await postPassword(agent, page, "st-pw", person.username, "Chosen-Password-1");
      expect(reply.status).toBe(403);
      expect(reply.text).toContain("single sign-on");
    } finally {
      await pilot.portal.close();
    }
  });
});
