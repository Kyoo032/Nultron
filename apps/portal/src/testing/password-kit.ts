/**
 * What the password sign-in suites share: a portal started in `PORTAL_SIGNIN_MODE=password`, people made
 * the way the operator makes them (the real `createAccount`, so the initial password is the generated
 * one and the row is what the CLI would write), and the posts of the sign-in as a browser makes them.
 *
 * Every value here is fake: the passwords are generated at run time or are obviously not real.
 */
import { createAccount, type CreatedAccount } from "../accounts";
import { createPasswordHasher, type PasswordHasher } from "../password";
import type { Credential, UserRole } from "../store/types";
import { appClientFor } from "./pg";
import { authorizeUrl, browserAt, CLIENT_ID, REDIRECT, setupPilot } from "./sign-in-kit";
import {
  hiddenValue,
  startTestPortal,
  type Agent,
  type PortalHarness,
  type Reply,
  type StartPortalOptions,
} from "./server";
import type { Fixture } from "./fixtures";

export { authorizeUrl, browserAt, CLIENT_ID, REDIRECT };

/** A hasher that counts what it is asked to do, over the real one. */
export interface CountingHasher extends PasswordHasher {
  readonly calls: { hash: number; verify: number; dummy: number };
}

export function countingHasher(inner: PasswordHasher = createPasswordHasher()): CountingHasher {
  const calls = { hash: 0, verify: 0, dummy: 0 };
  return {
    calls,
    hash(password) {
      calls.hash += 1;
      return inner.hash(password);
    },
    verify(password, stored) {
      calls.verify += 1;
      return inner.verify(password, stored);
    },
    verifyDummy(password) {
      calls.dummy += 1;
      return inner.verifyDummy(password);
    },
    needsRehash: (stored) => inner.needsRehash(stored),
    admit: () => inner.admit(),
  };
}

/**
 * A hasher that can be told to stand still inside a derivation, so a suite holds a sign-in at the
 * exact moment it is comparing a password and does something else meanwhile. `hold()` closes the gate
 * and returns the key; everything that derives while it is shut waits for it, and `whenInside(n)`
 * resolves once n derivations are waiting.
 */
export interface GatedHasher extends PasswordHasher {
  hold(): () => void;
  readonly inside: number;
  whenInside(count: number): Promise<void>;
}

export function gatedHasher(inner: PasswordHasher = createPasswordHasher()): GatedHasher {
  let gate: Promise<void> = Promise.resolve();
  let inside = 0;
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  const through = async <T>(work: () => Promise<T>): Promise<T> => {
    inside += 1;
    for (const waiter of waiters) {
      if (inside >= waiter.count) {
        waiter.resolve();
      }
    }
    try {
      await gate;
      return await work();
    } finally {
      inside -= 1;
    }
  };

  return {
    hash: (password) => inner.hash(password),
    verify: (password, stored) => through(() => inner.verify(password, stored)),
    verifyDummy: (password) => through(() => inner.verifyDummy(password)),
    needsRehash: (stored) => inner.needsRehash(stored),
    admit: () => inner.admit(),
    hold() {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
    get inside() {
      return inside;
    },
    whenInside(count) {
      if (inside >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
}

export interface PasswordPilot {
  readonly portal: PortalHarness;
  readonly fixture: Fixture & { readonly clientSecret: string };
  /** The real hasher, for making people: its calls are not the portal's. */
  readonly hasher: PasswordHasher;
}

/**
 * A password-mode portal, one tenant, one org, and the OAuth client the browser flow needs. The org's
 * seat cap is raised to 500 unless a suite says otherwise: a suite that makes forty people is not a
 * suite about the cap, and the ones that are make a tenant of their own.
 */
export async function startPasswordPilot(
  options: StartPortalOptions & { readonly slug?: string; readonly seatCap?: number } = {},
): Promise<PasswordPilot> {
  const portal = await startTestPortal({
    trustProxy: true,
    ...options,
    config: { ...options.config, signInMode: "password" },
  });
  const fixture = await setupPilot(portal, options.slug);
  await portal.store.store.tx(fixture.tenant.id, (ops) => ops.orgs.setSeatCap(fixture.org.id, options.seatCap ?? 500));
  return { portal, fixture, hasher: createPasswordHasher() };
}

let personSeq = 0;

export interface MadePerson extends CreatedAccount {
  /** The password to sign in with: the generated one until `chosen` replaces it. */
  readonly current: string;
}

/**
 * A person, made by the operator's own function. With `chosen`, they have already replaced the
 * generated password (so signing in goes straight to the redirect); without, the first sign-in is the
 * forced change.
 */
export async function makePerson(
  pilot: PasswordPilot,
  options: {
    readonly username?: string;
    readonly email?: string;
    readonly role?: UserRole;
    readonly chosen?: string;
  } = {},
): Promise<MadePerson> {
  personSeq += 1;
  const username = options.username ?? `person.${personSeq}`;
  const created = await createAccount(
    { store: pilot.portal.store.store, passwords: pilot.hasher, clock: pilot.portal.store.store.clock },
    {
      tenantSlug: pilot.fixture.tenant.slug,
      orgSlug: null,
      username,
      email: options.email ?? `${username}@pilot.test`,
      role: options.role ?? null,
      displayName: null,
    },
  );
  if (!created.ok) {
    throw new Error(`could not make a person: ${created.reason}`);
  }
  if (options.chosen === undefined) {
    return { ...created, current: created.password };
  }
  const secret = await pilot.hasher.hash(options.chosen);
  await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
    ops.credentials.setPassword({
      userId: created.userId,
      secret,
      mustChange: false,
      now: pilot.portal.store.store.clock.now(),
    }),
  );
  return { ...created, current: options.chosen };
}

/** The hidden fields every form of the authorize flow carries. */
function carried(state: string): Record<string, string> {
  return { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, state };
}

function csrfFrom(page: Reply | string): string {
  return hiddenValue(typeof page === "string" ? page : page.text, "csrf_token") as string;
}

export function startPage(agent: Agent, state: string): Promise<Reply> {
  return agent.get(authorizeUrl(state));
}

export function postPassword(
  agent: Agent,
  page: Reply | string,
  state: string,
  identifier: string,
  password: string,
  path = "/authorize/password",
): Promise<Reply> {
  return agent.postForm(path, { csrf_token: csrfFrom(page), ...carried(state), identifier, password });
}

export function postChange(
  agent: Agent,
  page: Reply | string,
  state: string,
  fields: {
    readonly identifier: string;
    readonly current: string;
    readonly next: string;
    readonly confirm?: string;
  },
  path = "/authorize/password/change",
): Promise<Reply> {
  return agent.postForm(path, {
    csrf_token: csrfFrom(page),
    ...carried(state),
    identifier: fields.identifier,
    current_password: fields.current,
    new_password: fields.next,
    confirm_password: fields.confirm ?? fields.next,
  });
}

/** From a fresh visit: GET the sign-in page, then post the identifier and the password. */
export async function signInFresh(agent: Agent, state: string, identifier: string, password: string): Promise<Reply> {
  return postPassword(agent, await startPage(agent, state), state, identifier, password);
}

/** The `code` and `state` a successful sign-in redirected back to the app with, or null. */
export function redirectedWith(reply: Reply): { readonly code: string; readonly state: string } | null {
  if (reply.status !== 302 || !reply.location?.startsWith(REDIRECT)) {
    return null;
  }
  const url = new URL(reply.location);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  return code && state ? { code, state } : null;
}

/** What the host does with the code: redeem it, as the confidential client. */
export function exchangeCode(portal: PortalHarness, clientSecret: string, code: string): Promise<Reply> {
  return browserAt(portal).postJson("/auth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    client_secret: clientSecret,
  });
}

/** Two replies with the things that legitimately differ per request taken out. */
export function shapeOf(reply: Reply): { readonly status: number; readonly page: string } {
  return {
    status: reply.status,
    page: reply.text
      // Every value attribute: the CSRF token, the OAuth state, and the identifier typed back.
      .replace(/ value="[^"]*"/g, ' value="-"')
      .replace(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[a-z]+/g, "<address>"),
  };
}

export interface CredentialRow {
  readonly scryptN: number;
  readonly failedAttempts: number;
  readonly graceAttempts: number;
  readonly lockedUntil: Date | null;
  readonly mustChange: boolean;
  readonly passwordHash: Buffer;
  readonly lastSignInAt: Date | null;
}

/** The credential's own row, secrets included, read as the application role inside the tenant. */
export async function credentialRowIn(
  database: Parameters<typeof appClientFor>[0],
  tenantId: string,
  userId: string,
): Promise<CredentialRow> {
  const client = await appClientFor(database);
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query(
      `SELECT scrypt_n, failed_attempts, grace_attempts, locked_until, must_change, password_hash,
              last_sign_in_at
         FROM user_credentials WHERE user_id = $1`,
      [userId],
    );
    await client.query("COMMIT");
    const row = rows[0];
    return {
      scryptN: Number(row.scrypt_n),
      failedAttempts: Number(row.failed_attempts),
      graceAttempts: Number(row.grace_attempts),
      lockedUntil: row.locked_until,
      mustChange: row.must_change === true,
      passwordHash: row.password_hash,
      lastSignInAt: row.last_sign_in_at,
    };
  } finally {
    await client.end();
  }
}

/**
 * Flags a person's credential "choose a new password first" and changes nothing else: the hash, its cost
 * and the password's own date stay as they were. That is what lets a sign-in held inside its comparison
 * get past `recordSuccess`'s guard on the hash (a real reset changes the hash and is refused there) and
 * reach the end of the sign-in with a credential that now says `must_change`.
 */
export async function markMustChange(pilot: PasswordPilot, userId: string): Promise<void> {
  const client = await appClientFor(pilot.portal.store.database);
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [pilot.fixture.tenant.id]);
    const { rowCount } = await client.query("UPDATE user_credentials SET must_change = true WHERE user_id = $1", [
      userId,
    ]);
    await client.query("COMMIT");
    if (rowCount !== 1) {
      throw new Error(`expected to flag one credential, flagged ${rowCount}`);
    }
  } finally {
    await client.end();
  }
}

export function credentialRow(pilot: PasswordPilot, userId: string): Promise<CredentialRow> {
  return credentialRowIn(pilot.portal.store.database, pilot.fixture.tenant.id, userId);
}

export function credentialOf(pilot: PasswordPilot, userId: string): Promise<Credential | null> {
  return pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) => ops.credentials.findByUserId(userId));
}

export function auditActions(pilot: PasswordPilot, action: string) {
  return pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
    ops.audit.list({ tenantId: pilot.fixture.tenant.id, action }),
  );
}

/** Every audit row of the tenant, as one string, for "no password ever appears in here". */
export async function allAuditText(pilot: PasswordPilot): Promise<string> {
  const rows = await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
    ops.audit.list({ tenantId: pilot.fixture.tenant.id, limit: 1000 }),
  );
  return JSON.stringify(rows);
}
