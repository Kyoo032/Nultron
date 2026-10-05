/**
 * L9 — a hosted person who has never chosen a language is greeted in the one their browser asks for.
 *
 * The portal's sign-in already speaks Indonesian when `Accept-Language` says so, and the app's welcome
 * did not: the host collapsed "never chosen" into English (`loadUserLocale`'s fall-through). On the
 * hosted server only, a person with no stored choice now gets
 *
 *     stored choice ?? localeFromAcceptLanguage(header) ?? the previous fall-through (English)
 *
 * for BOTH what the Settings answer says the app renders in (`locale` / `savedLocale`) and what a
 * model run writes in (`localeForRun()` inside every handler), so the UI and the model agree. Nothing
 * is persisted: it is a default, recomputed per request, and an explicit choice always beats it.
 *
 * The other product is held here too. Off server mode the header is never read: the locale is the one
 * frozen at boot and the Restart control still means what it meant.
 *
 * Real router, real sessions, real sealed settings store, throwaway data dir. The only stand-in is one
 * route that reports the locale a handler would write in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-hosted-locale-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "9d2e6b04c7a1f3858e0b2d64a9c1f7e35b80d4a62c9e1f7b3d05a8c6e4f20b19";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

/** `GET /api/v1/tools` stands in for any job route: it records the locale a handler would write in. */
/** The last locale a handler wrote in, per signed-in person (`userId` is "-" off server mode). */
const seen = vi.hoisted(() => ({ byUser: new Map<string, string>() }));

vi.mock("./handlers/misc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./handlers/misc")>();
  const { localeForRun } = await import("./run-context");
  return {
    ...actual,
    handleGetTools: async (request: HostRequest) => {
      seen.byUser.set(request.session?.userId ?? "-", localeForRun());
      return { type: "json", status: 200, body: { tools: [] } };
    },
  };
});

const { dispatch } = await import("./router");
const store = await import("./settings-store");
const bootLocale = await import("./locale-boot");

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const ORG = "locale-org";
const TENANT = "locale-tenant";
const PEOPLE = {
  fresh: { tenantId: TENANT, orgId: ORG, userId: "locale-fresh" },
  other: { tenantId: TENANT, orgId: ORG, userId: "locale-other" },
  choseEn: { tenantId: TENANT, orgId: ORG, userId: "locale-chose-en" },
  choseId: { tenantId: TENANT, orgId: ORG, userId: "locale-chose-id" },
} as const;
type Person = keyof typeof PEOPLE;

const ID_BROWSER = "id-ID,id;q=0.9,en;q=0.8";
const EN_BROWSER = "en-US,en;q=0.9";

let sessions: Record<Person, ReturnType<typeof createSession>>;
let sessionStore: ReturnType<typeof createMemorySessionStore>;

type Answer = { status: number; body: { locale?: string; savedLocale?: string } };

function hostedRequest(person: Person, path: string, acceptLanguage?: string, extra: Partial<HostRequest> = {}): HostRequest {
  return {
    method: "GET",
    path,
    query: {},
    params: {},
    headers: {
      cookie: `${SESSION_COOKIE_SECURE}=${sessions[person].id}`,
      ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage }),
    },
    ...extra,
  };
}

async function run(request: HostRequest, serverMode = true): Promise<Answer> {
  const result: HostResult = await dispatch(request, { serverMode, sessionStore, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: ((result as HostJsonResult).body ?? {}) as Answer["body"] };
}

const settingsFor = (person: Person, acceptLanguage?: string) =>
  run(hostedRequest(person, "/api/v1/settings", acceptLanguage));

/** The locale a handler wrote in for this person's request: what `localeForRun()` answered inside it. */
async function runLocaleFor(person: Person, acceptLanguage?: string): Promise<string | undefined> {
  const userId = PEOPLE[person].userId;
  seen.byUser.delete(userId);
  const answer = await run(hostedRequest(person, "/api/v1/tools", acceptLanguage));
  expect(answer.status).toBe(200);
  return seen.byUser.get(userId);
}

beforeAll(async () => {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  for (const identity of Object.values(PEOPLE)) {
    await ensurePortalOwner(db, { ...identity, role: "owner" });
  }
  sessionStore = createMemorySessionStore();
  sessions = {} as typeof sessions;
  for (const [person, identity] of Object.entries(PEOPLE) as Array<[Person, (typeof PEOPLE)[Person]]>) {
    sessions[person] = createSession({ ...identity, now: T0 });
    await sessionStore.create(sessions[person]);
  }
  // Two people choose, through the real route and the real store, before any case runs.
  process.env.AGENTFORGE_SERVER = "1";
  expect((await run(hostedRequest("choseEn", "/api/v1/settings", undefined, { method: "POST", body: { locale: "en" } }))).status).toBe(200);
  expect((await run(hostedRequest("choseId", "/api/v1/settings", undefined, { method: "POST", body: { locale: "id" } }))).status).toBe(200);
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
  seen.byUser.clear();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  bootLocale.resetBootLocaleForTests();
});

afterAll(async () => {
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("hosted: a person who never chose a language", () => {
  it("gets the browser's language from GET /api/v1/settings", async () => {
    const answer = await settingsFor("fresh", ID_BROWSER);
    expect(answer.status).toBe(200);
    // `savedLocale` agrees, so the Settings select shows what the person is reading and no Restart
    // prompt appears for a difference that is only the browser's.
    expect(answer.body).toMatchObject({ locale: "id", savedLocale: "id" });
  });

  it("gets the same language in a model run, so the UI and the model agree", async () => {
    expect(await runLocaleFor("fresh", ID_BROWSER)).toBe("id");
    expect((await settingsFor("fresh", ID_BROWSER)).body.locale).toBe("id");
  });

  it("follows q-values, not the order the tags are listed in", async () => {
    expect((await settingsFor("fresh", "en;q=0.5,id;q=0.9")).body.locale).toBe("id");
    expect(await runLocaleFor("fresh", "en;q=0.5,id;q=0.9")).toBe("id");
    expect((await settingsFor("fresh", "id;q=0.2,en;q=0.9")).body.locale).toBe("en");
    expect(await runLocaleFor("fresh", "id;q=0.2,en;q=0.9")).toBe("en");
  });

  it("gets English from an English browser", async () => {
    expect((await settingsFor("fresh", EN_BROWSER)).body).toMatchObject({ locale: "en", savedLocale: "en" });
    expect(await runLocaleFor("fresh", EN_BROWSER)).toBe("en");
  });

  it("gets English when there is no header, an unserved language, or garbage", async () => {
    for (const header of [undefined, "", "fr-FR,fr;q=0.9", "*", ";;;", "id;q=0", "<script>alert(1)</script>"]) {
      expect((await settingsFor("fresh", header)).body, JSON.stringify(header)).toMatchObject({
        locale: "en",
        savedLocale: "en",
      });
      expect(await runLocaleFor("fresh", header), JSON.stringify(header)).toBe("en");
    }
  });

  it("persists nothing: the browser's language is a default, read again on every request", async () => {
    const scope = { tenantId: TENANT, workspaceId: "ignored", userId: PEOPLE.fresh.userId };
    await settingsFor("fresh", ID_BROWSER);
    await runLocaleFor("fresh", ID_BROWSER);
    store.resetSettingsCacheForTests();

    expect(store.loadUserLocaleChoice(scope)).toBeNull();
    expect(store.loadUserLocale(scope)).toBe("en");
    // A later request from a different browser is not held to the first one's language.
    expect((await settingsFor("fresh", EN_BROWSER)).body.locale).toBe("en");
    expect((await settingsFor("fresh")).body.locale).toBe("en");
  });

  it("also answers the negotiated language when it saves some other setting", async () => {
    const answer = await run(
      hostedRequest("fresh", "/api/v1/settings", ID_BROWSER, { method: "POST", body: { editTurnCapUsd: 3 } }),
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ locale: "id", savedLocale: "id" });
    expect(store.loadUserLocaleChoice({ tenantId: TENANT, workspaceId: "x", userId: PEOPLE.fresh.userId })).toBeNull();
  });

  it("keeps two people on one tenant apart when their browsers differ", async () => {
    const [a, b] = await Promise.all([
      settingsFor("fresh", ID_BROWSER),
      settingsFor("other", EN_BROWSER),
    ]);
    expect(a.body.locale).toBe("id");
    expect(b.body.locale).toBe("en");
    const [runA, runB] = await Promise.all([runLocaleFor("fresh", ID_BROWSER), runLocaleFor("other", EN_BROWSER)]);
    expect([runA, runB]).toEqual(["id", "en"]);
  });
});

describe("hosted: an explicit choice always wins", () => {
  it("keeps an explicit English when the browser asks for Indonesian", async () => {
    expect((await settingsFor("choseEn", ID_BROWSER)).body).toMatchObject({ locale: "en", savedLocale: "en" });
    expect(await runLocaleFor("choseEn", ID_BROWSER)).toBe("en");
  });

  it("keeps an explicit Indonesian when the browser asks for English", async () => {
    expect((await settingsFor("choseId", EN_BROWSER)).body).toMatchObject({ locale: "id", savedLocale: "id" });
    expect(await runLocaleFor("choseId", EN_BROWSER)).toBe("id");
  });

  it("keeps it across a cold read of the sealed file", async () => {
    store.resetSettingsCacheForTests();
    expect((await settingsFor("choseEn", ID_BROWSER)).body.locale).toBe("en");
  });

  it("makes the person's own save stick over the browser from then on", async () => {
    const saved = await run(
      hostedRequest("other", "/api/v1/settings", ID_BROWSER, { method: "POST", body: { locale: "en" } }),
    );
    expect(saved.body).toMatchObject({ locale: "en", savedLocale: "en" });
    expect((await settingsFor("other", ID_BROWSER)).body.locale).toBe("en");
    expect(await runLocaleFor("other", ID_BROWSER)).toBe("en");
  });
});

describe("hosted: the choice reader", () => {
  const scope = (userId: string) => ({ tenantId: TENANT, workspaceId: "any-desk", userId });

  it("is the stored choice, and null for a person who never made one", () => {
    expect(store.loadUserLocaleChoice(scope(PEOPLE.choseId.userId))).toBe("id");
    expect(store.loadUserLocaleChoice(scope(PEOPLE.choseEn.userId))).toBe("en");
    expect(store.loadUserLocaleChoice(scope("locale-nobody"))).toBeNull();
  });

  it("reads no one's choice for a caller with no user id", () => {
    expect(store.loadUserLocaleChoice({ tenantId: TENANT, workspaceId: "any-desk", userId: "  " })).toBeNull();
    // A scope built without the field at all (the type says it is required; a stray caller may not).
    const noUser = { tenantId: TENANT, workspaceId: "any-desk" } as unknown as Parameters<
      typeof store.loadUserLocaleChoice
    >[0];
    expect(store.loadUserLocaleChoice(noUser)).toBeNull();
  });

  it("does not take the tenant-wide fall-through for a choice: that is not the person's own", () => {
    // `loadUserLocale` falls through to the tenant's own stored locale (a desk owner who set a language
    // before per-person locales must keep it). The choice reader must not: a tenant-level default would
    // otherwise read as every member's explicit choice and beat their browser.
    delete process.env.AGENTFORGE_SERVER;
    const wide = { tenantId: "locale-tenant-wide", workspaceId: "desk" };
    store.saveUserLocale({ ...wide, userId: "locale-setter" }, "id");
    const member = { ...wide, userId: "locale-member" };

    expect(store.loadUserLocale(member)).toBe("id");
    expect(store.loadUserLocaleChoice(member)).toBeNull();
    expect(store.loadUserLocaleChoice({ ...wide, userId: "locale-setter" })).toBe("id");
  });

  it("keeps the tenant-wide language for a person whose browser says nothing it serves, and lets a served one win", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const { sessionLocale } = bootLocale;
    const member = { tenantId: "locale-tenant-wide", userId: "locale-member" };

    // No header, or none it serves: exactly what the request got before this change.
    expect(sessionLocale(member)).toBe("id");
    expect(sessionLocale(member, "")).toBe("id");
    expect(sessionLocale(member, "fr-FR,fr;q=0.9")).toBe("id");
    // A header it serves is the person's browser speaking, which outranks a tenant-wide default.
    expect(sessionLocale(member, "en-US")).toBe("en");
    // The person's own choice outranks both.
    expect(sessionLocale({ tenantId: "locale-tenant-wide", userId: "locale-setter" }, "en-US")).toBe("id");
  });
});

describe("Personal: the header is never read", () => {
  it("is not forwarded into a locale: the desk's payload is the same with and without it", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const plain = await run({ method: "GET", path: "/api/v1/settings", query: {}, params: {}, headers: {} }, false);
    bootLocale.resetBootLocaleForTests();
    const asked = await run(
      { method: "GET", path: "/api/v1/settings", query: {}, params: {}, headers: { "accept-language": ID_BROWSER } },
      false,
    );

    expect(plain.status).toBe(200);
    expect(asked.status).toBe(200);
    expect({ locale: asked.body.locale, savedLocale: asked.body.savedLocale }).toEqual({
      locale: plain.body.locale,
      savedLocale: plain.body.savedLocale,
    });
    expect(plain.body.locale).toBe("en");
  });

  it("keeps the boot locale for a model run, whatever the browser asks", async () => {
    delete process.env.AGENTFORGE_SERVER;
    seen.byUser.clear();
    const answer = await run(
      { method: "GET", path: "/api/v1/tools", query: {}, params: {}, headers: { "accept-language": ID_BROWSER } },
      false,
    );
    expect(answer.status).toBe(200);
    expect([...seen.byUser.entries()]).toEqual([["-", "en"]]);
  });

  it("keeps the freeze: a saved language needs Restart, and the header changes neither half", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const headers = { "accept-language": ID_BROWSER };
    bootLocale.resetBootLocaleForTests();
    // The owner reads the desk once (that freezes English), then chooses Indonesian.
    await run({ method: "GET", path: "/api/v1/settings", query: {}, params: {}, headers }, false);
    const saved = await run(
      { method: "POST", path: "/api/v1/settings", query: {}, params: {}, headers, body: { locale: "id" } },
      false,
    );
    expect(saved.body).toMatchObject({ locale: "en", savedLocale: "id" });

    const applied = await run({ method: "POST", path: "/api/v1/settings/apply-locale", query: {}, params: {}, headers }, false);
    expect(applied.body).toMatchObject({ locale: "id", savedLocale: "id" });

    // Back to English so the desk's owner file is as this case found it.
    await run({ method: "POST", path: "/api/v1/settings", query: {}, params: {}, headers: {}, body: { locale: "en" } }, false);
    await run({ method: "POST", path: "/api/v1/settings/apply-locale", query: {}, params: {}, headers: {} }, false);
  });

  it("has no per-person pair on the anonymous ping: the install's own, as before", async () => {
    const ping = await run({ method: "GET", path: "/api/v1/ping", query: {}, params: {}, headers: { "accept-language": ID_BROWSER } }, false);
    expect(ping.body.locale).toBe("en");
  });
});
