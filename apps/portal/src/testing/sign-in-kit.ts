/**
 * What the sign-in suites share: a pilot tenant with one OAuth client, an operator who invites an
 * address (the portal e-mails the code, as it does for real), and the posts of the sign-in as a
 * browser makes them -- each one filled in from the page the previous step rendered.
 *
 * The invite code is read from the CAPTURED MAIL, never from the issuing function's return value,
 * because that is where a tester gets it: a suite that passed a code straight from `issueInvite`
 * to the form would not notice the mail carrying a different one.
 */
import { randomToken } from "../crypto";
import { issueInvite, mailInvite, type IssuedInvite } from "../invites";
import type { UserRole } from "../store/types";
import type { MailLocale } from "../mail";
import { seedFixture, type Fixture } from "./fixtures";
import { createAgent, hiddenValue, type Agent, type CapturedMail, type PortalHarness, type Reply } from "./server";

export const CLIENT_ID = "agentforge-web";
export const REDIRECT = "https://localhost:3443/auth/callback";

export function authorizeUrl(state: string): string {
  return `/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    state,
  }).toString()}`;
}

/** A tenant, its org and owner, and the OAuth client the browser flow needs (secret returned). */
export async function setupPilot(
  portal: PortalHarness,
  slug = "pilot",
): Promise<Fixture & { readonly clientSecret: string }> {
  const fixture = await seedFixture(portal.store.store, { slug, email: `owner@${slug}.test` });
  const clientSecret = randomToken();
  await portal.store.store.tx(fixture.tenant.id, (ops) =>
    ops.oauthClients.create({
      clientId: CLIENT_ID,
      tenantId: fixture.tenant.id,
      name: "Nultron",
      secret: clientSecret,
      redirectUris: [REDIRECT],
    }),
  );
  return { ...fixture, clientSecret };
}

let addressSeq = 0;
export function nextAddress(domain = "pilot.test"): string {
  addressSeq += 1;
  return `tester${addressSeq}@${domain}`;
}

let ipSeq = 0;
/** A browser at an address of its own, on a portal started with `trustProxy: true`. */
export function browserAt(portal: PortalHarness, ip?: string): Agent {
  ipSeq += 1;
  const own = `10.20.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  return createAgent(portal.origin, { headers: { "x-forwarded-for": ip ?? own } });
}

/** The mails that carried a six-digit sign-in code, which is every mail that is not an invite. */
export function otpMails(portal: PortalHarness): readonly CapturedMail[] {
  return portal.mailer.sent.filter((mail) => mail.inviteCode === null);
}

export function inviteMails(portal: PortalHarness): readonly CapturedMail[] {
  return portal.mailer.sent.filter((mail) => mail.inviteCode !== null);
}

export interface OperatorInvite {
  readonly issued: IssuedInvite;
  /** From the e-mail, as the tester reads it. */
  readonly code: string;
}

/** What `pnpm portal:invite` does: issue the invite and e-mail the code to the address. */
export async function operatorInvites(
  portal: PortalHarness,
  fixture: Fixture,
  email: string,
  options: { readonly ttlMs?: number; readonly locale?: MailLocale; readonly role?: UserRole } = {},
): Promise<OperatorInvite> {
  const issued = await issueInvite(portal.store.store, {
    tenantSlug: fixture.tenant.slug,
    email,
    ttlMs: options.ttlMs,
    role: options.role,
  });
  if (!issued.ok) {
    throw new Error(`could not issue an invite: ${issued.reason}`);
  }
  const before = inviteMails(portal).length;
  const mailed = await mailInvite(
    { store: portal.store.store, mailer: portal.mailer, log: portal.log },
    {
      tenantId: issued.tenantId,
      orgId: issued.orgId,
      inviteId: issued.inviteId,
      code: issued.code,
      email: issued.email,
      expiresAt: issued.expiresAt,
      locale: options.locale,
      action: "invite.mailed",
    },
  );
  if (mailed !== "sent" || inviteMails(portal).length !== before + 1) {
    throw new Error("the invite e-mail did not go");
  }
  const code = inviteMails(portal).at(-1)?.inviteCode;
  if (!code) {
    throw new Error("the invite e-mail carried no code");
  }
  return { issued, code };
}

/** The hidden fields every form of the authorize flow carries. */
function carried(state: string): Record<string, string> {
  return { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state };
}

/** The first page of the flow: its CSRF token is what the first post sends. */
export async function startPage(agent: Agent, state: string): Promise<Reply> {
  return agent.get(authorizeUrl(state));
}

function csrfFrom(page: Reply | string): string {
  return hiddenValue(typeof page === "string" ? page : page.text, "csrf_token") as string;
}

/** A post to one of the sign-in endpoints, using the CSRF token of the page the browser last saw. */
export async function postStep(
  agent: Agent,
  path: string,
  page: Reply | string,
  state: string,
  fields: Readonly<Record<string, string>>,
): Promise<Reply> {
  return agent.postForm(path, { csrf_token: csrfFrom(page), ...carried(state), ...fields });
}

/** Step one, from a fresh visit: GET the sign-in page, then post the address. */
export async function emailStep(
  agent: Agent,
  state: string,
  email: string,
  extra: Readonly<Record<string, string>> = {},
  path = "/authorize/email",
): Promise<Reply> {
  const start = await startPage(agent, state);
  return postStep(agent, path, start, state, { email, ...extra });
}

export function inviteStep(agent: Agent, page: Reply, state: string, email: string, inviteCode: string) {
  return postStep(agent, "/authorize/invite", page, state, { email, invite_code: inviteCode });
}

export function resendInviteStep(agent: Agent, page: Reply, state: string, email: string) {
  return postStep(agent, "/authorize/invite/resend", page, state, { email });
}

export function verifyStep(agent: Agent, page: Reply, state: string, email: string, code: string) {
  return postStep(agent, "/authorize/verify", page, state, { email, code });
}

/** A reply with the two things that legitimately differ per request taken out. */
export function shapeOf(reply: Reply): { readonly status: number; readonly page: string } {
  return {
    status: reply.status,
    page: reply.text
      .replace(/name="csrf_token" value="[^"]*"/g, 'name="csrf_token" value="-"')
      .replace(/value="[^"]*@[^"]*"/g, 'value="-"')
      .replace(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[a-z]+/g, "<address>"),
  };
}

export async function statusOf(portal: PortalHarness, fixture: Fixture, email: string): Promise<string | undefined> {
  return (
    await portal.store.store.tx(fixture.tenant.id, (ops) => ops.users.findByEmail(fixture.tenant.id, email))
  )?.status;
}

export function auditRows(portal: PortalHarness, fixture: Fixture, action: string) {
  return portal.store.store.tx(fixture.tenant.id, (ops) => ops.audit.list({ tenantId: fixture.tenant.id, action }));
}
