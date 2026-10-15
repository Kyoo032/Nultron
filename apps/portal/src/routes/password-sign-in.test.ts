/**
 * The password sign-in (`PORTAL_SIGNIN_MODE=password`), driven against a real server on an ephemeral
 * port and a real Postgres: what a browser does, and what the host does with the code it gets back.
 *
 * Every value typed here is fake. People are made by the operator's own `createAccount`, so the
 * initial password is the generated one and the row is what the CLI would have written.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webSessionCookieFor } from "../flows/web-session";
import {
  PASSWORD_GRACE_ATTEMPTS,
  PASSWORD_LOCK_MS,
  PASSWORD_MAX_FAILED_ATTEMPTS,
} from "../store/postgres/credentials";
import { openPostgresStore } from "../store/postgres";
import { asAppRole, fixedClock } from "../testing/pg";
import {
  allAuditText,
  auditActions,
  authorizeUrl,
  browserAt,
  countingHasher,
  credentialRow,
  exchangeCode,
  gatedHasher,
  makePerson,
  markMustChange,
  postChange,
  postPassword,
  redirectedWith,
  shapeOf,
  signInFresh,
  startPage,
  startPasswordPilot,
  type CountingHasher,
  type GatedHasher,
  type PasswordPilot,
} from "../testing/password-kit";
import { createAgent, hiddenValue, type Reply } from "../testing/server";
import { createAccount, disableAccount, enableAccount } from "../accounts";
import { createPasswordHasher } from "../password";

const WRONG = "wrong-fake-password-0";
const CHOSEN = "chosen-fake-password-1";
const REFUSED_SENTENCE = "That username or password is not right.";

let pilot: PasswordPilot;
let counting: CountingHasher;

/** Everything a browser was shown, and everything anybody typed, for the "never echoed" check at the end. */
const shown: Reply[] = [];
const typed: string[] = [WRONG, CHOSEN];

function seen(reply: Reply): Reply {
  shown.push(reply);
  return reply;
}

async function signIn(identifier: string, password: string, state = "state-x"): Promise<Reply> {
  typed.push(password);
  return seen(await signInFresh(browserAt(pilot.portal), state, identifier, password));
}

beforeAll(async () => {
  // A gate of 64, not the shipped eight: this suite fires bursts of twelve and twenty-four at once to
  // count what the lock allows, and a ninth in flight would be answered `503` before it reached it.
  // The gate itself is driven, at its shipped size, in "when too many sign-ins are deriving".
  counting = countingHasher(createPasswordHasher({ maxInFlight: 64 }));
  pilot = await startPasswordPilot({ passwords: counting });
}, 180_000);

afterAll(async () => {
  await pilot?.portal.close();
});

function delta(before: { hash: number; verify: number; dummy: number }) {
  return {
    hash: counting.calls.hash - before.hash,
    verify: counting.calls.verify - before.verify,
    dummy: counting.calls.dummy - before.dummy,
  };
}

describe("GET /authorize in password mode", () => {
  it("asks for a username and a password, and never for an e-mail address or a code", async () => {
    const agent = browserAt(pilot.portal);
    const reply = seen(await startPage(agent, "state-form"));

    expect(reply.status).toBe(200);
    expect(reply.text).toContain('name="identifier"');
    expect(reply.text).toContain('autocomplete="username"');
    expect(reply.text).toMatch(/<input id="password" name="password" type="password" autocomplete="current-password"/);
    expect(reply.text).not.toContain('name="email"');
    expect(reply.text).not.toContain('name="code"');
    expect(reply.text).toContain("Never share your password with anyone.");
    expect(reply.text).not.toContain("sign-in code");
    // The form posts to the password step, and the page carries the client's origin in form-action
    // exactly as the code form does, or the redirect back to the app would be blocked by the browser.
    expect(reply.text).toContain('action="/authorize/password"');
    expect(reply.headers.get("content-security-policy")).toContain("form-action 'self' https://localhost:3443;");
    expect(agent.cookies.has(pilot.portal.runtime.cookies.csrf)).toBe(true);
  });

  it("is in Indonesian when the browser asks for it, footer included", async () => {
    const reply = await browserAt(pilot.portal).get(
      "/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: "agentforge-web",
          redirect_uri: "https://localhost:3443/auth/callback",
          state: "state-id",
        }).toString(),
      { headers: { "accept-language": "id-ID,id;q=0.9" } },
    );
    expect(reply.text).toContain("Nama pengguna atau e-mail");
    expect(reply.text).toContain("Kata sandi");
    expect(reply.text).toContain("Jangan pernah membagikan kata sandi Anda kepada siapa pun.");
    expect(reply.text).not.toContain("kode masuk");
  });
});

describe("a sign-in that succeeds", () => {
  it("makes the person choose a password, then redirects back with a code the host can redeem, and sends no mail", async () => {
    const person = await makePerson(pilot);
    typed.push(person.password);
    const agent = browserAt(pilot.portal);

    // The generated password proves who they are, and buys no session: it is a change page.
    const first = seen(await signInFresh(agent, "state-ok", person.username, person.password));
    expect(first.status).toBe(200);
    expect(first.location).toBeNull();
    expect(first.text).toContain('name="current_password"');
    expect(first.text).toContain('name="new_password"');
    expect(first.text).toContain('name="confirm_password"');
    expect(first.text).toContain('action="/authorize/password/change"');
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(false);
    expect(redirectedWith(first)).toBeNull();

    const next = "a-fresh-fake-password-9";
    typed.push(next);
    const done = seen(
      await postChange(agent, first, "state-ok", { identifier: person.username, current: person.password, next }),
    );
    const redirected = redirectedWith(done);
    expect(redirected).not.toBeNull();
    expect(redirected?.state).toBe("state-ok");
    // The same session the code sign-in issues: the portal's own cookie, and a code to redeem.
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(true);

    const exchanged = await exchangeCode(pilot.portal, pilot.fixture.clientSecret, redirected?.code ?? "");
    expect(exchanged.status).toBe(200);
    const tokens = exchanged.json<Record<string, unknown>>();
    expect(tokens.user_id).toBe(person.userId);
    expect(tokens.tenant_id).toBe(pilot.fixture.tenant.id);
    expect(tokens.role).toBe("member");
    expect(tokens.username).toBe(person.username);
    expect(tokens.display_name).toBeNull();
    expect(typeof tokens.access_token).toBe("string");

    // From then on the chosen password goes straight through, by username or by the address on record.
    const again = await signIn(person.username, next, "state-2");
    expect(redirectedWith(again)?.state).toBe("state-2");
    const byAddress = await signIn(person.email.toUpperCase(), next, "state-3");
    expect(redirectedWith(byAddress)?.state).toBe("state-3");
    // And the generated one is spent.
    expect((await signIn(person.username, person.password)).status).toBe(400);

    expect(pilot.portal.mailer.sent).toHaveLength(0);
  });

  it("gives a person who chose their own password the role the operator made them", async () => {
    const admin = await makePerson(pilot, { role: "admin", chosen: CHOSEN, displayName: "Rina Wulandari" });
    const reply = await signIn(admin.username, CHOSEN, "state-role");
    const redirected = redirectedWith(reply);
    const exchanged = await exchangeCode(pilot.portal, pilot.fixture.clientSecret, redirected?.code ?? "");
    expect(exchanged.json<{ role: string; display_name: string; username: string }>()).toMatchObject({
      role: "admin",
      display_name: "Rina Wulandari",
      username: admin.username,
    });
  });
});

describe("a sign-in that fails", () => {
  it("gives the same answer for a wrong password as for a username that does not exist", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const wrong = await signIn(person.username, WRONG);
    const ghost = await signIn("ghost.user", WRONG);

    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain(REFUSED_SENTENCE);
    expect(shapeOf(wrong)).toEqual(shapeOf(ghost));
    expect(wrong.location).toBeNull();
    expect(ghost.location).toBeNull();
  });

  it("does the same hashing work whichever way it fails, and a comparable time", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });

    let before = { ...counting.calls };
    await signIn(person.username, WRONG);
    expect(delta(before)).toEqual({ hash: 0, verify: 1, dummy: 0 });

    before = { ...counting.calls };
    await signIn("ghost.user", WRONG);
    // Nothing to compare against, so the cost of a comparison is paid on nothing.
    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 1 });

    // The measurement behind "comparable": the median of several of each. The assertion is a ratio,
    // so a loaded machine slows both sides alike; the floor is relative to one real derivation.
    const hasher = createPasswordHasher();
    const probe = performance.now();
    await hasher.verifyDummy(WRONG);
    const oneDerivation = performance.now() - probe;

    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const timeOf = async (identifier: string): Promise<number> => {
      const start = performance.now();
      await signInFresh(browserAt(pilot.portal), "state-time", identifier, WRONG);
      return performance.now() - start;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      known.push(await timeOf(person.username));
      unknown.push(await timeOf(`ghost.user.${round}`));
    }
    const knownMedian = median(known);
    const unknownMedian = median(unknown);
    expect(unknownMedian).toBeGreaterThan(oneDerivation * 0.4);
    expect(knownMedian).toBeGreaterThan(oneDerivation * 0.4);
    expect(Math.max(knownMedian, unknownMedian) / Math.min(knownMedian, unknownMedian)).toBeLessThan(3);
  }, 60_000);

  it("refuses an over-long password without a second kind of answer, and without counting it", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const before = { ...counting.calls };
    const reply = await signIn(person.username, "x".repeat(300));
    expect(reply.status).toBe(400);
    expect(reply.text).toContain(REFUSED_SENTENCE);
    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 1 });
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(0);
  });

  it("asks for both fields when one is missing, without touching any account", async () => {
    const agent = browserAt(pilot.portal);
    const page = await startPage(agent, "state-missing");
    const before = { ...counting.calls };
    const reply = seen(await postPassword(agent, page, "state-missing", "someone", ""));
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("Enter your username and your password.");
    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 0 });
  });
});

/** One browser at a fixed address: the same source every time, which `signIn` (a new address each call) is not. */
async function signInAt(ip: string, identifier: string, password: string, state = "state-x"): Promise<Reply> {
  typed.push(password);
  return seen(await signInFresh(browserAt(pilot.portal, ip), state, identifier, password));
}

describe("the lockout", () => {
  it("locks an account after five counted failures, whatever the password is after that", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const before = { ...counting.calls };
    // One address does all of it: a source that has failed against the account is locked out of it.
    const attacker = "198.51.100.99";

    for (let attempt = 1; attempt <= PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect((await signInAt(attacker, person.username, WRONG)).status).toBe(400);
    }
    const locked = await credentialRow(pilot, person.userId);
    expect(locked.failedAttempts).toBe(PASSWORD_MAX_FAILED_ATTEMPTS);
    const remaining = (locked.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(PASSWORD_LOCK_MS - 60_000);
    expect(remaining).toBeLessThanOrEqual(PASSWORD_LOCK_MS);

    // The right password, now: the same sentence as a wrong one, and nothing was compared for it.
    const verifiesBefore = counting.calls.verify;
    const dummiesBefore = counting.calls.dummy;
    const sixth = await signInAt(attacker, person.username, CHOSEN);
    const wrongShape = await signInAt(attacker, person.username, WRONG);
    expect(sixth.status).toBe(400);
    expect(sixth.location).toBeNull();
    expect(shapeOf(sixth)).toEqual(shapeOf(wrongShape));
    expect(counting.calls.verify).toBe(verifiesBefore);
    expect(counting.calls.dummy).toBe(dummiesBefore + 2);
    expect(counting.calls.verify - before.verify).toBe(PASSWORD_MAX_FAILED_ATTEMPTS);

    // One row per failure and one for the lock; the refusals while locked write none.
    const failed = (await auditActions(pilot, "password.failed")).filter((row) => row.targetId === person.userId);
    const locks = (await auditActions(pilot, "password.locked")).filter((row) => row.targetId === person.userId);
    expect(failed).toHaveLength(PASSWORD_MAX_FAILED_ATTEMPTS);
    expect(locks).toHaveLength(1);
    expect(locks[0].reasonCode).toBe("too_many_failures");
  }, 60_000);

  it("is counted in the database, so a fresh connection (a restart) finds it locked", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signIn(person.username, WRONG);
    }
    const fresh = openPostgresStore({
      databaseUrl: asAppRole(pilot.portal.store.database.url),
      maxConnections: 1,
    });
    try {
      const reserved = await fresh.tx(pilot.fixture.tenant.id, (ops) =>
        ops.credentials.reserveAttempt({
          userId: person.userId,
          now: new Date(),
          maxAttempts: PASSWORD_MAX_FAILED_ATTEMPTS,
          lockMs: PASSWORD_LOCK_MS,
        }),
      );
      expect(reserved.kind).toBe("locked");
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("gives a burst of parallel guesses from one address exactly as many comparisons as the counter allows", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const before = { ...counting.calls };

    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        signInFresh(
          browserAt(pilot.portal, "198.51.100.98"),
          `state-burst-${index}`,
          person.username,
          `${WRONG}-${index}`,
        ),
      ),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(400);
      expect(reply.text).toContain(REFUSED_SENTENCE);
    }
    // Twelve guesses fired at once; five were compared, the other seven met the lock.
    expect(counting.calls.verify - before.verify).toBe(PASSWORD_MAX_FAILED_ATTEMPTS);
    expect(counting.calls.dummy - before.dummy).toBe(12 - PASSWORD_MAX_FAILED_ATTEMPTS);
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(PASSWORD_MAX_FAILED_ATTEMPTS);
  }, 60_000);

  it("clears the count when the right password is given", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    await signIn(person.username, WRONG);
    await signIn(person.username, WRONG);
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(2);
    expect(redirectedWith(await signIn(person.username, CHOSEN))).not.toBeNull();
    const row = await credentialRow(pilot, person.userId);
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.lastSignInAt).not.toBeNull();
  }, 60_000);
});

describe("the lockout expires", () => {
  it("lets the person in fifteen minutes later, and starts the count again", async () => {
    const clock = fixedClock();
    const clocked = await startPasswordPilot({ clock, slug: "clocked" });
    try {
      const person = await makePerson(clocked, { chosen: CHOSEN });
      // The address that does the failing is the one that stays locked out until the lock is over.
      const attacker = "198.51.100.97";
      for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
        await signInFresh(browserAt(clocked.portal, attacker), "state-lock", person.username, WRONG);
      }
      const during = await signInFresh(browserAt(clocked.portal, attacker), "state-lock", person.username, CHOSEN);
      expect(during.status).toBe(400);

      clock.advance(PASSWORD_LOCK_MS - 1000);
      const stillLocked = await signInFresh(
        browserAt(clocked.portal, attacker),
        "state-lock",
        person.username,
        CHOSEN,
      );
      expect(stillLocked.status).toBe(400);

      clock.advance(2000);
      const after = await signInFresh(browserAt(clocked.portal, attacker), "state-lock", person.username, CHOSEN);
      expect(redirectedWith(after)).not.toBeNull();
      const cleared = await credentialRow(clocked, person.userId);
      expect(cleared.failedAttempts).toBe(0);
      expect(cleared.lockedUntil).toBeNull();

      // A second person: lock, wait it out, fail once. The window is fresh, not the old five plus one.
      const other = await makePerson(clocked, { chosen: CHOSEN });
      for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
        await signInFresh(browserAt(clocked.portal, attacker), "state-lock", other.username, WRONG);
      }
      clock.advance(PASSWORD_LOCK_MS + 1000);
      await signInFresh(browserAt(clocked.portal, attacker), "state-lock", other.username, WRONG);
      const fresh = await credentialRow(clocked, other.userId);
      expect(fresh.failedAttempts).toBe(1);
      expect(fresh.lockedUntil).toBeNull();
    } finally {
      await clocked.portal.close();
    }
  }, 120_000);
});

describe("the forced change", () => {
  it("refuses a bad new password without spending an attempt, and says what is wrong", async () => {
    const person = await makePerson(pilot, { username: "forced.change.person" });
    typed.push(person.password);
    const agent = browserAt(pilot.portal);
    const page = seen(await signInFresh(agent, "state-forced", person.username, person.password));
    const before = { ...counting.calls };

    const newline = `a fresh fake${String.fromCharCode(10)}password`;
    const cases: Array<[string, string, string]> = [
      ["short-1", "short-1", "Use at least 12 characters."],
      ["a".repeat(201), "a".repeat(201), "Use at most 200 characters."],
      ["a fresh fake password", "a different fake password", "The two new passwords are not the same."],
      [newline, newline, "no line breaks"],
    ];
    for (const [next, confirm, expected] of cases) {
      typed.push(next);
      const reply = seen(
        await postChange(agent, page, "state-forced", {
          identifier: person.username,
          current: person.password,
          next,
          confirm,
        }),
      );
      expect(reply.status, expected).toBe(400);
      expect(reply.text, expected).toContain(expected);
      expect(reply.text).toContain('name="current_password"');
      expect(redirectedWith(reply)).toBeNull();
    }
    // None of those reached the lockout or the hash: they need no account.
    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 0 });
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(0);
  });

  it("refuses the username, the address and the password being replaced, after the current one proved", async () => {
    const person = await makePerson(pilot, { username: "long.fake.username" });
    typed.push(person.password);
    const agent = browserAt(pilot.portal);
    const page = seen(await signInFresh(agent, "state-forced-2", person.username, person.password));

    const cases: Array<[string, string]> = [
      [person.username, "not your username"],
      [person.email, "not your e-mail"],
      [person.password, "different from the current one"],
    ];
    for (const [next, expected] of cases) {
      const before = { ...counting.calls };
      const reply = seen(
        await postChange(agent, page, "state-forced-2", {
          identifier: person.username,
          current: person.password,
          next,
        }),
      );
      expect(reply.status, expected).toBe(400);
      expect(reply.text, expected).toContain(expected);
      // These DO verify the current password, which is what makes it safe to say what is wrong.
      expect(delta(before).verify).toBe(1);
    }
  }, 60_000);

  it("treats a wrong current password as a failed sign-in: the one sentence, and it counts", async () => {
    const person = await makePerson(pilot);
    typed.push(person.password);
    const agent = browserAt(pilot.portal);
    const page = seen(await signInFresh(agent, "state-forced-3", person.username, person.password));
    const reply = seen(
      await postChange(agent, page, "state-forced-3", {
        identifier: person.username,
        current: WRONG,
        next: "a-fresh-fake-password-7",
      }),
    );
    expect(reply.status).toBe(400);
    expect(reply.text).toContain(REFUSED_SENTENCE);
    expect(reply.text).toContain('name="current_password"');
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(1);
    // And it did not change anything: the generated password still opens the change page.
    expect((await signIn(person.username, person.password)).text).toContain('name="current_password"');
  }, 60_000);

  it("ends every browser session the person held, and records the change", async () => {
    const person = await makePerson(pilot);
    typed.push(person.password);
    const versionBefore = await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
      ops.webSessions.version(person.userId),
    );
    const agent = browserAt(pilot.portal);
    const page = seen(await signInFresh(agent, "state-forced-4", person.username, person.password));
    const next = "a-fresh-fake-password-5";
    typed.push(next);
    const done = await postChange(agent, page, "state-forced-4", {
      identifier: person.username,
      current: person.password,
      next,
    });
    expect(redirectedWith(done)).not.toBeNull();

    const versionAfter = await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
      ops.webSessions.version(person.userId),
    );
    expect(versionAfter).toBe(versionBefore + 1);
    const row = await credentialRow(pilot, person.userId);
    expect(row.mustChange).toBe(false);
    const changed = (await auditActions(pilot, "password.changed")).filter((entry) => entry.targetId === person.userId);
    expect(changed).toHaveLength(1);
    expect(changed[0].reasonCode).toBe("forced");
  }, 60_000);
});

describe("a disabled person", () => {
  it("is refused with the correct password and the same sentence, and is let back in when enabled", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    // Signed in on one browser before they are disabled.
    const old = browserAt(pilot.portal);
    const first = await signInFresh(old, "state-dis", person.username, CHOSEN);
    expect(redirectedWith(first)).not.toBeNull();
    expect(
      (
        await old.get(
          `/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: "agentforge-web",
            redirect_uri: "https://localhost:3443/auth/callback",
            state: "state-dis-2",
          }).toString()}`,
        )
      ).status,
    ).toBe(302);

    const deps = {
      store: pilot.portal.store.store,
      passwords: pilot.hasher,
      clock: pilot.portal.store.store.clock,
    };
    const disabled = await disableAccount(deps, {
      tenantSlug: pilot.fixture.tenant.slug,
      person: { by: "username", username: person.username },
    });
    expect(disabled.ok).toBe(true);

    const before = { ...counting.calls };
    const refused = await signIn(person.username, CHOSEN);
    const ghost = await signIn("ghost.user", CHOSEN);
    expect(refused.status).toBe(400);
    expect(shapeOf(refused)).toEqual(shapeOf(ghost));
    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 2 });
    const withheld = (await auditActions(pilot, "password.withheld")).filter((row) => row.targetId === person.userId);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].reasonCode).toBe("user_disabled");

    // The browser that was signed in is no longer: the form comes back instead of a code.
    const stale = await old.get(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "agentforge-web",
        redirect_uri: "https://localhost:3443/auth/callback",
        state: "state-dis-3",
      }).toString()}`,
    );
    expect(stale.status).toBe(200);
    expect(stale.text).toContain('name="identifier"');

    const enabled = await enableAccount(deps, {
      tenantSlug: pilot.fixture.tenant.slug,
      person: { by: "username", username: person.username },
    });
    expect(enabled.ok).toBe(true);
    expect(redirectedWith(await signIn(person.username, CHOSEN))).not.toBeNull();
  }, 60_000);
});

describe("cross-site submission", () => {
  it("refuses a post with no CSRF cookie, a wrong token or none, and touches no account", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const before = { ...counting.calls };
    const fields = {
      response_type: "code",
      client_id: "agentforge-web",
      redirect_uri: "https://localhost:3443/auth/callback",
      state: "state-csrf",
      identifier: person.username,
      password: CHOSEN,
    };

    // A page on another site: no cookie from this portal, and a token it made up.
    const foreign = seen(
      await createAgent(pilot.portal.origin).postForm("/authorize/password", { ...fields, csrf_token: "forged" }),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.location).toBeNull();

    // A browser that has the cookie, with a token that is not the cookie's.
    const agent = browserAt(pilot.portal);
    await startPage(agent, "state-csrf");
    const wrongToken = seen(await agent.postForm("/authorize/password", { ...fields, csrf_token: "not-the-cookie" }));
    expect(wrongToken.status).toBe(403);
    const noToken = seen(await agent.postForm("/authorize/password", fields));
    expect(noToken.status).toBe(403);

    // The same for the change post.
    const change = seen(
      await agent.postForm("/authorize/password/change", {
        ...fields,
        csrf_token: "not-the-cookie",
        current_password: CHOSEN,
        new_password: "a-fresh-fake-password-3",
        confirm_password: "a-fresh-fake-password-3",
      }),
    );
    expect(change.status).toBe(403);

    expect(delta(before)).toEqual({ hash: 0, verify: 0, dummy: 0 });
    expect((await credentialRow(pilot, person.userId)).failedAttempts).toBe(0);
  });

  it("re-validates the client and its redirect on the post, not only on the page", async () => {
    const agent = browserAt(pilot.portal);
    const page = await startPage(agent, "state-redirect");
    const reply = await agent.postForm("/authorize/password", {
      csrf_token: hiddenValue(page.text, "csrf_token") as string,
      response_type: "code",
      client_id: "agentforge-web",
      redirect_uri: "https://evil.test/collect",
      state: "state-redirect",
      identifier: "someone",
      password: WRONG,
    });
    expect(reply.status).toBe(400);
    expect(reply.location).toBeNull();
    expect(reply.headers.get("content-security-policy")).not.toContain("evil.test");
  });
});

describe("the e-mailed-code routes", () => {
  const paths = [
    "/authorize/email",
    "/authorize/invite",
    "/authorize/invite/resend",
    "/authorize/verify",
    "/activate/email",
    "/activate/invite",
    "/activate/invite/resend",
    "/activate/verify",
  ];

  it("do not exist, for any method, with or without a valid CSRF token", async () => {
    const agent = browserAt(pilot.portal);
    const page = await startPage(agent, "state-gone");
    const token = hiddenValue(page.text, "csrf_token") as string;
    for (const path of paths) {
      const get = await agent.get(path);
      expect(get.status, `GET ${path}`).toBe(404);
      expect(get.json()).toEqual({ error: "not_found" });
      const post = await agent.postForm(path, {
        csrf_token: token,
        response_type: "code",
        client_id: "agentforge-web",
        redirect_uri: "https://localhost:3443/auth/callback",
        state: "state-gone",
        email: "owner@pilot.test",
        code: "000000",
        invite_code: "AAAAA-AAAAA-AAAAA-AAAAA",
      });
      expect(post.status, `POST ${path}`).toBe(404);
      expect(post.json()).toEqual({ error: "not_found" });
    }
    expect(pilot.portal.mailer.sent).toHaveLength(0);
  });

  it("leave only the discovery route, which says the one word the host reads", async () => {
    const reply = await createAgent(pilot.portal.origin).get("/auth/signin-mode");
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ mode: "password" });
  });
});

describe("the device-code approval page", () => {
  async function startDevice(installId: string) {
    return (
      await createAgent(pilot.portal.origin).postJson("/auth/device/code", {
        install_id: installId,
        tenant_hint: pilot.fixture.tenant.slug,
        platform: "win32",
        app_version: "0.16.0",
        label: "Windows device",
      })
    ).json<{ device_code: string; user_code: string }>();
  }

  it("takes a password sign-in, then Approve, then hands the device its session", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const installId = "install-password-0001";
    const started = await startDevice(installId);

    const agent = browserAt(pilot.portal);
    const page = seen(await agent.get(`/activate?code=${started.user_code}`));
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="identifier"');
    expect(page.text).toContain('action="/activate/password"');
    expect(hiddenValue(page.text, "user_code")).toBe(started.user_code);

    const approveScreen = seen(
      await agent.postForm("/activate/password", {
        csrf_token: hiddenValue(page.text, "csrf_token") as string,
        user_code: started.user_code,
        identifier: person.username,
        password: CHOSEN,
      }),
    );
    expect(approveScreen.status).toBe(200);
    expect(approveScreen.text).toContain("Approve this device?");
    expect(approveScreen.text).toContain(started.user_code);
    expect(approveScreen.text).toContain(person.email);
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(true);

    const approved = seen(
      await agent.postForm("/auth/device/approve", {
        csrf_token: hiddenValue(approveScreen.text, "csrf_token") as string,
        user_code: started.user_code,
        decision: "approve",
      }),
    );
    expect(approved.text).toContain("Device approved");

    const tokens = await createAgent(pilot.portal.origin).postJson("/auth/device/token", {
      device_code: started.device_code,
      install_id: installId,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.json<Record<string, unknown>>().user_id).toBe(person.userId);
    expect(pilot.portal.mailer.sent).toHaveLength(0);
  }, 60_000);

  it("takes the forced change too, then goes on to Approve", async () => {
    const person = await makePerson(pilot);
    typed.push(person.password);
    const started = await startDevice("install-password-0002");
    const agent = browserAt(pilot.portal);
    const page = seen(await agent.get(`/activate?code=${started.user_code}`));
    const change = seen(
      await agent.postForm("/activate/password", {
        csrf_token: hiddenValue(page.text, "csrf_token") as string,
        user_code: started.user_code,
        identifier: person.username,
        password: person.password,
      }),
    );
    expect(change.text).toContain('action="/activate/password/change"');
    expect(hiddenValue(change.text, "user_code")).toBe(started.user_code);
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(false);

    const next = "a-fresh-fake-password-4";
    typed.push(next);
    const approveScreen = seen(
      await agent.postForm("/activate/password/change", {
        csrf_token: hiddenValue(change.text, "csrf_token") as string,
        user_code: started.user_code,
        identifier: person.username,
        current_password: person.password,
        new_password: next,
        confirm_password: next,
      }),
    );
    expect(approveScreen.text).toContain("Approve this device?");
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(true);
  }, 60_000);

  it("resolves the tenant from the username when there is no device code yet, then asks for the code", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const agent = browserAt(pilot.portal);
    const page = seen(await agent.get("/activate"));
    expect(page.text).toContain('name="identifier"');

    const signedIn = seen(
      await agent.postForm("/activate/password", {
        csrf_token: hiddenValue(page.text, "csrf_token") as string,
        user_code: "",
        identifier: person.username,
        password: CHOSEN,
      }),
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.text).toContain('name="user_code"');
    expect(signedIn.text).toContain(person.email);
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(true);
  }, 60_000);

  it("refuses a wrong password with the one sentence, and keeps the device code on the form", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const started = await startDevice("install-password-0003");
    const agent = browserAt(pilot.portal);
    const page = await agent.get(`/activate?code=${started.user_code}`);
    const refused = seen(
      await agent.postForm("/activate/password", {
        csrf_token: hiddenValue(page.text, "csrf_token") as string,
        user_code: started.user_code,
        identifier: person.username,
        password: WRONG,
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(REFUSED_SENTENCE);
    expect(hiddenValue(refused.text, "user_code")).toBe(started.user_code);
    expect(agent.cookies.has(pilot.portal.runtime.cookies.session)).toBe(false);
  }, 60_000);
});

describe("the portal's own seat gate", () => {
  it("turns away a person who has the right password and no seat, and redirects with the reason", async () => {
    const tight = await startPasswordPilot({ slug: "seatless", seatCap: 3 });
    try {
      const holder = await makePerson(tight, { chosen: CHOSEN });
      const waiting = await makePerson(tight, { chosen: CHOSEN });

      // The first person signs in and the host redeems the code: that is what takes the seat.
      const first = await signInFresh(browserAt(tight.portal), "state-seat-1", holder.username, CHOSEN);
      const redeemed = await exchangeCode(tight.portal, tight.fixture.clientSecret, redirectedWith(first)?.code ?? "");
      expect(redeemed.status).toBe(200);

      // The cap comes down to the one seat that is in use.
      await tight.portal.store.store.tx(tight.fixture.tenant.id, (ops) => ops.orgs.setSeatCap(tight.fixture.org.id, 1));

      const turned = await signInFresh(browserAt(tight.portal), "state-seat-2", waiting.username, CHOSEN);
      expect(turned.status).toBe(302);
      expect(turned.location).toContain("error=seat_cap_reached");
      expect(turned.location).not.toContain("code=");
      // The password was right, so the person is told the real reason, in the app, where an admin acts.
    } finally {
      await tight.portal.close();
    }
  }, 60_000);
});

describe("the password on disk", () => {
  it("is re-hashed under the current parameters at the next success, and still works", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    // Older parameters: the cheapest the schema allows, written the way a past release would have.
    const cheaper = createPasswordHasher({ params: { n: 2 ** 14, r: 8, p: 1, keyLength: 32 } });
    const old = await cheaper.hash(CHOSEN);
    await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
      ops.credentials.setPassword({
        userId: person.userId,
        secret: old,
        mustChange: false,
        now: pilot.portal.store.store.clock.now(),
      }),
    );
    const before = await credentialRow(pilot, person.userId);
    expect(before.scryptN).toBe(2 ** 14);

    expect(redirectedWith(await signIn(person.username, CHOSEN))).not.toBeNull();
    const after = await credentialRow(pilot, person.userId);
    expect(after.scryptN).toBe(2 ** 15);
    expect(after.passwordHash.equals(before.passwordHash)).toBe(false);
    // Under the new hash the same password still opens the door, and it is not re-hashed again.
    const hashes = counting.calls.hash;
    expect(redirectedWith(await signIn(person.username, CHOSEN))).not.toBeNull();
    expect(counting.calls.hash).toBe(hashes);
  }, 60_000);
});

describe("the budgets in front of the sign-in", () => {
  it("limits one identifier to ten posts and one address to twenty, and hashes nothing past them", async () => {
    const limitedHasher = countingHasher();
    const limited = await startPasswordPilot({
      passwordStepLimits: "production",
      passwords: limitedHasher,
      slug: "limited",
    });
    try {
      // One browser address, one identifier: the tenth is answered, the eleventh is not.
      const agent = browserAt(limited.portal, "198.51.100.10");
      const page = await startPage(agent, "state-limit");
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const reply = await postPassword(agent, page, "state-limit", "same.identifier", WRONG);
        expect(reply.status, `attempt ${attempt}`).toBe(400);
      }
      const hashed = limitedHasher.calls.dummy + limitedHasher.calls.verify;
      const eleventh = await postPassword(agent, page, "state-limit", "same.identifier", WRONG);
      expect(eleventh.status).toBe(429);
      expect(eleventh.text).toContain("Too many attempts.");
      expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(eleventh.text).toContain('name="identifier"');
      expect(limitedHasher.calls.dummy + limitedHasher.calls.verify).toBe(hashed);

      // A different identifier from the same address still has the address's remaining budget:
      // ten spent above, so ten more are answered before the twenty-first is refused.
      let answered = 0;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const reply = await postPassword(agent, page, "state-limit", `other.identifier.${attempt}`, WRONG);
        if (reply.status === 400) {
          answered += 1;
        } else {
          expect(reply.status).toBe(429);
        }
      }
      // 10 answered + 1 refused above = 11 counted for the address; 9 more fit under 20.
      expect(answered).toBe(9);
    } finally {
      await limited.portal.close();
    }
  }, 120_000);
});

describe("a lock is not a way to keep a named person out", () => {
  it("lets the person in from their own address while the address that locked the account stays out", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const attacker = "198.51.100.7";
    const victim = "203.0.113.9";
    for (let attempt = 0; attempt < PASSWORD_MAX_FAILED_ATTEMPTS; attempt += 1) {
      await signInAt(attacker, person.username, WRONG);
    }
    expect((await credentialRow(pilot, person.userId)).lockedUntil).not.toBeNull();

    // The attacker's address: refused, with the one sentence, even if it were to type the right password.
    const compared = counting.calls.verify;
    const refused = await signInAt(attacker, person.username, CHOSEN);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain(REFUSED_SENTENCE);
    expect(refused.location).toBeNull();
    expect(counting.calls.verify).toBe(compared);

    // The person, from theirs, with the right password: in, and the host can redeem what they are given.
    const reply = await signInAt(victim, person.username, CHOSEN, "state-victim");
    const redirected = redirectedWith(reply);
    expect(redirected?.state).toBe("state-victim");
    const exchanged = await exchangeCode(pilot.portal, pilot.fixture.clientSecret, redirected?.code ?? "");
    expect(exchanged.status).toBe(200);
    expect(exchanged.json<{ user_id: string }>().user_id).toBe(person.userId);

    const row = await credentialRow(pilot, person.userId);
    expect([row.failedAttempts, row.graceAttempts, row.lockedUntil]).toEqual([0, 0, null]);
  }, 90_000);

  it("compares at most five plus three passwords however many addresses ask at once", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const before = { ...counting.calls };
    const replies = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        signInFresh(
          browserAt(pilot.portal, `192.0.2.${index + 10}`),
          `state-many-${index}`,
          person.username,
          `${WRONG}-${index}`,
        ),
      ),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(400);
      expect(reply.text).toContain(REFUSED_SENTENCE);
    }
    const bound = PASSWORD_MAX_FAILED_ATTEMPTS + PASSWORD_GRACE_ATTEMPTS;
    expect(counting.calls.verify - before.verify).toBe(bound);
    expect(counting.calls.dummy - before.dummy).toBe(24 - bound);
    const row = await credentialRow(pilot, person.userId);
    expect([row.failedAttempts, row.graceAttempts]).toEqual([PASSWORD_MAX_FAILED_ATTEMPTS, PASSWORD_GRACE_ATTEMPTS]);
  }, 90_000);
});

describe("the sources and budgets in front of the sign-in", () => {
  it("counts an IPv6 /56 as one source, whichever /64 of it an address is in, and two IPv4 neighbours as two", async () => {
    const hasher = countingHasher();
    const limited = await startPasswordPilot({
      passwordStepLimits: "production",
      passwords: hasher,
      slug: "sources",
    });
    try {
      // Twenty-one different addresses, each in a /64 of its own and all inside one /56, each asking once
      // about somebody else: the twenty-first is refused before it costs a derivation. Keyed on the whole
      // address (or on the /64) none of them ever would be.
      const answered: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        const agent = browserAt(limited.portal, `2001:db8:aaaa:${index.toString(16)}:${index.toString(16)}::${index.toString(16)}`);
        const page = await startPage(agent, "state-v6");
        const hashedBefore = hasher.calls.dummy + hasher.calls.verify;
        const reply = await postPassword(agent, page, "state-v6", `ghost.six.${index}`, WRONG);
        answered.push(reply.status);
        if (index === 21) {
          expect(reply.text).toContain("Too many attempts.");
          expect(hasher.calls.dummy + hasher.calls.verify).toBe(hashedBefore);
        }
      }
      expect(answered.slice(0, 20).every((status) => status === 400)).toBe(true);
      expect(answered[20]).toBe(429);

      // A /64 nobody in the loop used, inside the same /56, is the same source and is refused too.
      const inside = browserAt(limited.portal, "2001:db8:aaaa:ff::1");
      const insidePage = await startPage(inside, "state-v6c");
      const insideReply = await postPassword(inside, insidePage, "state-v6c", "ghost.inside", WRONG);
      expect(insideReply.status).toBe(429);

      // Another /56 is another source, and is not affected.
      const elsewhere = browserAt(limited.portal, "2001:db8:aaaa:100::1");
      const elsewherePage = await startPage(elsewhere, "state-v6b");
      expect((await postPassword(elsewhere, elsewherePage, "state-v6b", "ghost.elsewhere", WRONG)).status).toBe(400);

      // IPv4 is unchanged: each address is its own source, with the whole budget of its own.
      const first = browserAt(limited.portal, "198.51.100.20");
      const firstPage = await startPage(first, "state-v4");
      const statuses: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        statuses.push((await postPassword(first, firstPage, "state-v4", `ghost.four.${index}`, WRONG)).status);
      }
      expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
      expect(statuses[20]).toBe(429);
      const neighbour = browserAt(limited.portal, "198.51.100.21");
      const neighbourPage = await startPage(neighbour, "state-v4b");
      expect((await postPassword(neighbour, neighbourPage, "state-v4b", "ghost.neighbour", WRONG)).status).toBe(400);
    } finally {
      await limited.portal.close();
    }
  }, 180_000);

  it("does not let one address spend a named person's budget: they still get in from their own", async () => {
    const limited = await startPasswordPilot({ passwordStepLimits: "production", slug: "budgets" });
    try {
      const person = await makePerson(limited, { chosen: CHOSEN });
      const attacker = browserAt(limited.portal, "198.51.100.30");
      const page = await startPage(attacker, "state-spend");
      const statuses: number[] = [];
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        statuses.push((await postPassword(attacker, page, "state-spend", person.username, WRONG)).status);
      }
      // Ten are answered; the attacker's own budget for that name is spent.
      expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);

      const victim = browserAt(limited.portal, "203.0.113.31");
      const reply = await signInFresh(victim, "state-own", person.username, CHOSEN);
      expect(reply.status).toBe(302);
      expect(redirectedWith(reply)?.state).toBe("state-own");
    } finally {
      await limited.portal.close();
    }
  }, 180_000);
});

describe("when too many sign-ins are deriving", () => {
  it("answers 503 with a sentence that says nothing about any account, and counts nothing against anybody", async () => {
    const gated = gatedHasher(createPasswordHasher());
    const busy = await startPasswordPilot({ passwords: gated, slug: "busy" });
    let open: () => void = () => undefined;
    try {
      const person = await makePerson(busy, { chosen: CHOSEN });
      open = gated.hold();

      // Eight sign-ins for people who do not exist, each held in its derivation: the gate is full.
      const held = Array.from({ length: 8 }, (_, index) =>
        signInFresh(browserAt(busy.portal), `state-held-${index}`, `ghost.held.${index}`, WRONG),
      );
      await gated.whenInside(8);

      // The ninth is for a real person with the right password. It is told to wait: before anything was
      // looked up, so it cannot say whether anybody exists.
      const refused = await signInFresh(browserAt(busy.portal), "state-ninth", person.username, CHOSEN);
      const ghost = await signInFresh(browserAt(busy.portal), "state-ninth", "ghost.ninth", CHOSEN);
      for (const reply of [refused, ghost]) {
        expect(reply.status).toBe(503);
        expect(reply.text).toContain("Sign-in is busy right now");
        expect(reply.text).not.toContain(REFUSED_SENTENCE);
        expect(reply.headers.get("retry-after")).toBe("2");
        expect(reply.text).toContain('name="identifier"');
        expect(reply.location).toBeNull();
      }
      expect(shapeOf(refused)).toEqual(shapeOf(ghost));

      // It was not a failed attempt: the account has no count, no lock and no audit row for it.
      const row = await credentialRow(busy, person.userId);
      expect([row.failedAttempts, row.graceAttempts, row.lockedUntil, row.lastSignInAt]).toEqual([0, 0, null, null]);
      const rows = await busy.portal.store.store.tx(busy.fixture.tenant.id, (ops) =>
        ops.audit.list({ tenantId: busy.fixture.tenant.id, limit: 1000 }),
      );
      expect(rows.filter((entry) => entry.targetId === person.userId && entry.action.startsWith("password."))).toHaveLength(0);

      // The eight finish as ordinary refusals, and the person gets in the moment there is room.
      open();
      for (const reply of await Promise.all(held)) {
        expect(reply.status).toBe(400);
      }
      const again = await signInFresh(browserAt(busy.portal), "state-after", person.username, CHOSEN);
      expect(redirectedWith(again)?.state).toBe("state-after");
    } finally {
      // A failed assertion above must not leave eight requests held for ever and the server unable to close.
      open();
      await busy.portal.close();
    }
  }, 180_000);
});

describe("a cookie is not a way past the forced change", () => {
  async function liveCookie(runtimePilot: PasswordPilot, person: { userId: string }, orgId: string) {
    const setCookie = await runtimePilot.portal.store.store.tx(runtimePilot.fixture.tenant.id, (ops) =>
      webSessionCookieFor(runtimePilot.portal.runtime, ops, {
        tenantId: runtimePilot.fixture.tenant.id,
        userId: person.userId,
        orgId,
        installId: "web-client-agentforge-web",
      }),
    );
    const [pair] = setCookie.split(";");
    const separator = pair.indexOf("=");
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
  }

  const authorizeAgain = (agent: ReturnType<typeof browserAt>, state: string) =>
    agent.get(authorizeUrl(state));

  it("shows the form, not a redirect with a code, to a live cookie whose credential must still be changed", async () => {
    const person = await makePerson(pilot, { chosen: CHOSEN });
    const agent = browserAt(pilot.portal);
    expect(redirectedWith(await signInFresh(agent, "state-first", person.username, CHOSEN))).not.toBeNull();
    // The cookie resumes while the credential is settled.
    expect((await authorizeAgain(agent, "state-resume")).status).toBe(302);

    // The credential is flagged again WITHOUT the sessions being ended (a path that left the cookie alive).
    const issued = await pilot.hasher.hash("an-operator-issued-fake-password");
    await pilot.portal.store.store.tx(pilot.fixture.tenant.id, (ops) =>
      ops.credentials.setPassword({ userId: person.userId, secret: issued, mustChange: true, now: new Date() }),
    );
    const reply = await authorizeAgain(agent, "state-held");
    expect(reply.status).toBe(200);
    expect(reply.location).toBeNull();
    expect(reply.text).toContain('name="identifier"');
    expect(reply.text).not.toContain("code=");

    // The device-code page treats the same cookie the same way: no Approve for it, the sign-in form.
    const activate = await agent.get("/activate");
    expect(activate.status).toBe(200);
    expect(activate.text).toContain('name="identifier"');
    expect(activate.text).not.toContain(person.email);
  }, 90_000);

  it("ends a session that predates a password when the operator attaches one, so the cookie no longer resumes", async () => {
    const attach = await startPasswordPilot({ slug: "attach" });
    try {
      // The owner `seed` made has no credential and has been signed in before (another mode, another day).
      const agent = browserAt(attach.portal);
      const cookie = await liveCookie(attach, { userId: attach.fixture.user.id }, attach.fixture.org.id);
      agent.cookies.set(cookie.name, cookie.value);
      expect((await authorizeAgain(agent, "state-old")).status).toBe(302);

      const attached = await createAccount(
        { store: attach.portal.store.store, passwords: attach.hasher, clock: attach.portal.store.store.clock },
        {
          tenantSlug: attach.fixture.tenant.slug,
          orgSlug: null,
          username: "the.owner",
          email: attach.fixture.user.email,
          role: null,
          displayName: null,
        },
      );
      expect(attached.ok).toBe(true);

      const reply = await authorizeAgain(agent, "state-new");
      expect(reply.status).toBe(200);
      expect(reply.location).toBeNull();
      expect(reply.text).toContain('name="identifier"');
    } finally {
      await attach.portal.close();
    }
  }, 120_000);
});

describe("a person who is flagged to change their password after the password was checked", () => {
  // A sign-in is held inside its password comparison, the credential is flagged while it is held, and the
  // sign-in is let go. The flag lands after the sign-in read the credential and before it ends: the window
  // an operator's `reset-password` lands in, which ends the person's sessions at that moment, so a sign-in
  // that is already past the password check would otherwise issue a fresh one behind it. The hash is not
  // touched, because a real reset changes it and `recordSuccess` already refuses that one (SR-165, L2).
  let gated: GatedHasher;
  let held: PasswordPilot;

  beforeAll(async () => {
    gated = gatedHasher(createPasswordHasher());
    held = await startPasswordPilot({ passwords: gated, slug: "flagged" });
  }, 180_000);

  afterAll(async () => {
    await held?.portal.close();
  });

  /** Holds the sign-in `start` begins inside its comparison, does `flag` meanwhile, then lets it go. */
  async function letGoAfter(start: () => Promise<Reply>, flag: (() => Promise<void>) | null): Promise<Reply> {
    const open = gated.hold();
    const pending = start();
    try {
      await gated.whenInside(1);
      await flag?.();
    } finally {
      open();
    }
    return seen(await pending);
  }

  const codesIssuedTo = async (userId: string) =>
    (await auditActions(held, "auth_code.issued")).filter((row) => row.actorUserId === userId);

  async function startDeviceFor(installId: string) {
    const started = await createAgent(held.portal.origin).postJson("/auth/device/code", {
      install_id: installId,
      tenant_hint: held.fixture.tenant.slug,
      platform: "win32",
      app_version: "0.16.0",
      label: "Windows device",
    });
    return started.json<{ user_code: string }>();
  }

  async function activateSignIn(agent: ReturnType<typeof browserAt>, userCode: string, identifier: string) {
    const page = await agent.get(`/activate?code=${userCode}`);
    return () =>
      agent.postForm("/activate/password", {
        csrf_token: hiddenValue(page.text, "csrf_token") as string,
        user_code: userCode,
        identifier,
        password: CHOSEN,
      });
  }

  describe("on /authorize", () => {
    it("is shown the change form and is issued no code and no cookie", async () => {
      const person = await makePerson(held, { chosen: CHOSEN });
      const agent = browserAt(held.portal);
      const reply = await letGoAfter(
        () => signInFresh(agent, "state-flagged", person.username, CHOSEN),
        () => markMustChange(held, person.userId),
      );

      expect(reply.status).toBe(200);
      expect(reply.location).toBeNull();
      expect(redirectedWith(reply)).toBeNull();
      expect(reply.text).toContain('action="/authorize/password/change"');
      expect(reply.text).toContain('name="current_password"');
      expect(reply.text).not.toContain("code=");
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(false);
      expect(await codesIssuedTo(person.userId)).toHaveLength(0);

      // And the form works: the change is made, and only then is there a session.
      const next = "a-fresh-fake-password-5";
      typed.push(next);
      const done = seen(
        await postChange(agent, reply, "state-flagged", { identifier: person.username, current: CHOSEN, next }),
      );
      expect(redirectedWith(done)?.state).toBe("state-flagged");
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(true);
      expect(await codesIssuedTo(person.userId)).toHaveLength(1);
    }, 90_000);

    it("is signed in as usual when nothing flagged them while the sign-in was held", async () => {
      const person = await makePerson(held, { chosen: CHOSEN });
      const agent = browserAt(held.portal);
      const reply = await letGoAfter(() => signInFresh(agent, "state-plain", person.username, CHOSEN), null);

      expect(redirectedWith(reply)?.state).toBe("state-plain");
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(true);
      expect(await codesIssuedTo(person.userId)).toHaveLength(1);
    }, 90_000);
  });

  describe("on /activate", () => {
    it("is shown the change form and is issued no cookie, and no Approve", async () => {
      const person = await makePerson(held, { chosen: CHOSEN });
      const started = await startDeviceFor("install-flagged-0001");
      const agent = browserAt(held.portal);
      const post = await activateSignIn(agent, started.user_code, person.username);
      const reply = await letGoAfter(post, () => markMustChange(held, person.userId));

      expect(reply.status).toBe(200);
      expect(reply.text).toContain('action="/activate/password/change"');
      expect(reply.text).toContain('name="current_password"');
      expect(hiddenValue(reply.text, "user_code")).toBe(started.user_code);
      expect(reply.text).not.toContain("Approve this device?");
      expect(reply.text).not.toContain(person.email);
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(false);

      // And the form works: the change is made, and only then is there a session and an Approve.
      const next = "a-fresh-fake-password-6";
      typed.push(next);
      const approve = seen(
        await agent.postForm("/activate/password/change", {
          csrf_token: hiddenValue(reply.text, "csrf_token") as string,
          user_code: started.user_code,
          identifier: person.username,
          current_password: CHOSEN,
          new_password: next,
          confirm_password: next,
        }),
      );
      expect(approve.text).toContain("Approve this device?");
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(true);
    }, 90_000);

    it("is signed in as usual when nothing flagged them while the sign-in was held", async () => {
      const person = await makePerson(held, { chosen: CHOSEN });
      const started = await startDeviceFor("install-flagged-0002");
      const agent = browserAt(held.portal);
      const post = await activateSignIn(agent, started.user_code, person.username);
      const reply = await letGoAfter(post, null);

      expect(reply.status).toBe(200);
      expect(reply.text).toContain("Approve this device?");
      expect(reply.text).toContain(person.email);
      expect(agent.cookies.has(held.portal.runtime.cookies.session)).toBe(true);
    }, 90_000);
  });
});

describe("secrets", () => {
  it("never echoes a typed or generated password in a page, a redirect, an audit row or a log line", async () => {
    // Run last: `typed` and `shown` hold everything the suite sent and received.
    expect(typed.length).toBeGreaterThan(5);
    expect(shown.length).toBeGreaterThan(20);
    const audit = await allAuditText(pilot);
    const logs = pilot.portal.logLines.join("\n");
    for (const password of new Set(typed)) {
      if (password.length < 12) {
        continue;
      }
      for (const reply of shown) {
        expect(reply.text, `page echoed ${password.length} characters`).not.toContain(password);
        expect(reply.location ?? "").not.toContain(encodeURIComponent(password));
      }
      expect(audit).not.toContain(password);
      expect(logs).not.toContain(password);
    }
    // No hash material either: the scrypt output is bytea and never leaves the store.
    expect(audit).not.toMatch(/scrypt/i);
    expect(logs).not.toMatch(/scrypt/i);
  });
});
