/**
 * SR-65 (second hole) — who is an owner on the hosted server, driven end to end.
 *
 * `ensurePortalOwner` used to write an `owner` membership for every person who signed in to an org
 * with no row for them, because the portal sent no role. So "owner" meant "signed in", and any
 * colleague could erase the company (the hosted Erase account is owner-only). The portal now sends the
 * role beside `tenant_id` in every token body (`owner` | `admin` | `member`); the host writes exactly
 * that, has no default of its own, and re-applies it at every refresh.
 *
 * Nothing here is mocked below the portal's wire: a scripted portal answers the REAL portal client's
 * `fetch` (so the role is parsed by `toTokens`, not stubbed past it), the sign-in goes through the real
 * `createAuthRoutes`, the session lives in the real `auth_sessions` table, the role is written by the real
 * `ensurePortalOwner` / `syncPortalRole`, and the erase is the real route through `dispatch`. Every
 * refusal asserted here is checked against rows that are still there afterwards.
 *
 * The 10-minute portal re-check is the clock: a request after `PORTAL_CHECK_INTERVAL_MS` is the one
 * that refreshes, so "applied on the next refresh" is "applied by the first gated request after ten
 * minutes of the last check".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-portal-roles-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "4c1d9f0a7be2358d6a41c9e07f3b52d8a6e04c71b9d3f5a82e6071c4d9b3a5f0";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_STORAGE;
delete process.env.AGENTFORGE_PORTAL_URL;
delete process.env.AGENTFORGE_PORTAL_CLIENT_ID;
delete process.env.AGENTFORGE_PORTAL_CLIENT_SECRET;

import { LOCAL_OWNER_ID, TENANT_ERASE_CONFIRM_WORD, type EnvLike } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { createPortalClient } from "./auth/portal-client";
import { createPortalSessionCheck } from "./auth/portal-check";
import { createAuthRoutes } from "./auth/routes";
import { PORTAL_CHECK_INTERVAL_MS, SESSION_COOKIE_SECURE } from "./auth/session";
import { createSessionSecrets } from "./auth/session-secrets";
import { createDrizzleSessionStore, createMemoryTokenVault, type SessionStore } from "./auth/session-store";
import { loginStateCookieName } from "./auth/login-state";
import { TENANT_RESET_FORBIDDEN_CODE } from "./tenant-reset";
import { dispatch } from "./router";
import type { HostRequest, HostResult, HostJsonResult } from "./types";

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const STATE = "st_roles_test";
const PORTAL_ENV: EnvLike = {
  AGENTFORGE_PORTAL_URL: "https://portal.example.test",
  AGENTFORGE_PORTAL_CLIENT_ID: "cli_roles",
  AGENTFORGE_PORTAL_CLIENT_SECRET: "sec_roles",
  AGENTFORGE_PUBLIC_URL: "https://app.example.test",
};

/** What the scripted portal says each person's role is. `undefined` means the body carries no `role`. */
const portalRole = new Map<string, unknown>();
let refreshes = 0;
let clock = { now: T0 };
let store: SessionStore;
let routes: ReturnType<typeof createAuthRoutes>;
let check: ReturnType<typeof createPortalSessionCheck>;

/** A portal that answers the real client's `fetch`: `/auth/token` for both grants, role from `portalRole`. */
const portalFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/auth/token")) {
    return new Response(null, { status: 204 });
  }
  const request = JSON.parse(String(init?.body)) as Record<string, string>;
  const [, userId, tenantId, orgId] =
    request.grant_type === "authorization_code"
      ? (request.code?.split("|") ?? [])
      : (request.refresh_token?.replace(/^refresh-\d+\|/, "refresh|").split("|") ?? []);
  const body: Record<string, unknown> = {
    access_token: "acc",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: `refresh-${++refreshes}|${userId}|${tenantId}|${orgId}`,
    refresh_expires_in: 2592000,
    session_id: "ses",
    device_id: "dev",
    user_id: userId,
    org_id: orgId,
    tenant_id: tenantId,
  };
  const role = portalRole.get(userId as string);
  if (role !== undefined) {
    body.role = role;
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let counter = 0;
type Company = { tenantId: string; orgId: string };

/** A company nobody has signed in to: every case starts from its own, so none leaks into another. */
function freshCompany(): Company {
  counter += 1;
  return { tenantId: `roles-tenant-${counter}`, orgId: `roles-org-${counter}` };
}

function json(result: HostResult): HostJsonResult {
  if (result.type !== "json") {
    throw new Error(`expected a json result, got ${result.type}`);
  }
  return result;
}

function errorCode(result: HostResult): string | undefined {
  const payload = (json(result).body as { error?: { code?: string } | string }).error;
  return typeof payload === "string" ? payload : payload?.code;
}

/** One person signs in through the real route, as the portal's `role` says, and gets a cookie back. */
async function signIn(company: Company, userId: string, role: unknown): Promise<string> {
  portalRole.set(userId, role);
  const request: HostRequest = {
    method: "POST",
    path: "/api/v1/auth/login",
    query: {},
    params: {},
    headers: { cookie: `${loginStateCookieName({ secure: true })}=${STATE}` },
    body: { code: `code|${userId}|${company.tenantId}|${company.orgId}`, state: STATE },
  };
  const result = json(await routes.handleLogin(request));
  expect(result.status).toBe(200);
  const cookie = result.cookies?.find((entry) => entry.name === SESSION_COOKIE_SECURE);
  expect(cookie?.value).toBeTruthy();
  return `${SESSION_COOKIE_SECURE}=${cookie?.value}`;
}

async function send(cookie: string, over: Partial<HostRequest>): Promise<HostResult> {
  return dispatch(
    { method: "GET", path: "/api/v1/storage/usage", query: {}, params: {}, headers: { cookie }, ...over },
    { serverMode: true, sessionStore: store, portalCheck: check, now: () => clock.now },
  );
}

/** The Erase account request with the right word, which a non-owner must be refused before it matters. */
function erase(cookie: string, confirm: string = TENANT_ERASE_CONFIRM_WORD): Promise<HostResult> {
  return send(cookie, {
    method: "POST",
    path: "/api/v1/settings/reset",
    body: { scope: "tenant", confirm },
  });
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { db } = await import("@agentforge/db");
  const row = db.$client.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
  return row.n;
}

async function roleOf(company: Company, userId: string): Promise<string | undefined> {
  const { db } = await import("@agentforge/db");
  const row = db.$client
    .prepare("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?")
    .get(company.orgId, userId) as { role: string } | undefined;
  return row?.role;
}

/** The first gated request after the portal's last word is ten minutes old: it is the one that refreshes. */
async function afterTheCheckIsDue(cookie: string): Promise<void> {
  clock = { now: clock.now + PORTAL_CHECK_INTERVAL_MS };
  expect(json(await send(cookie, {})).status).toBe(200);
}

/** The company is still whole: its org, its desk and its people were not touched by a refused erase. */
async function expectCompanyIntact(company: Company): Promise<void> {
  expect(await count("organizations", "id", company.orgId)).toBe(1);
  expect(await count("workspaces", "organization_id", company.orgId)).toBeGreaterThan(0);
  expect(await count("auth_sessions", "tenant_id", company.tenantId)).toBeGreaterThan(0);
}

beforeAll(async () => {
  const { db } = await import("@agentforge/db");
  store = createDrizzleSessionStore(db);
  const vault = createMemoryTokenVault();
  const secrets = createSessionSecrets(() => getLocalVaultKey());
  const portal = createPortalClient({ baseUrl: "https://portal.example.test", fetchImpl: portalFetch });
  const hostRole = async (identity: { tenantId: string; orgId: string; userId: string }, role: unknown) => {
    const { syncPortalRole } = await import("@agentforge/db");
    await syncPortalRole(db, identity, role as Parameters<typeof syncPortalRole>[2]);
  };
  check = createPortalSessionCheck({ vault, portal, secrets, applyRole: (identity, role) => hostRole(identity, role) });
  routes = createAuthRoutes({
    store,
    vault,
    portal,
    portalCheck: check,
    secrets,
    serverMode: true,
    env: PORTAL_ENV,
    now: () => clock.now,
    provision: async (identity) => {
      const { ensurePortalOwner } = await import("@agentforge/db");
      return ensurePortalOwner(db, identity);
    },
    claimSeat: async () => ({ ok: true }),
    // The real reader `hostAuthRoutes` wires: the membership row, through the real resolver.
    readRole: async (session) => {
      const { resolvePortalTenant } = await import("@agentforge/db");
      const resolution = await resolvePortalTenant(db, {
        tenantId: session.tenantId,
        orgId: session.orgId,
        userId: session.userId,
      });
      return resolution.ok ? resolution.tenant.role : null;
    },
  });
});

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
  clock = { now: T0 };
  portalRole.clear();
});

afterAll(async () => {
  delete process.env.AGENTFORGE_SERVER;
  // The SQLite file lives in dataDir; close it so Windows releases the handle before cleanup.
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("who can erase the company, when the portal says who is who", () => {
  it("an owner is an owner: the erase passes the role check and meets the confirmation", async () => {
    const company = freshCompany();
    const ownerCookie = await signIn(company, "usr-owner", "owner");

    expect(await roleOf(company, "usr-owner")).toBe("owner");
    // A wrong word gets past the owner check and stops at the confirmation: a 400, and nothing deleted.
    const result = await erase(ownerCookie, "not the word");
    expect(json(result).status).toBe(400);
    expect(errorCode(result)).toBe("invalid_request");
    await expectCompanyIntact(company);
  });

  it("a member who signs in after the owner is a member, and the erase is a 403", async () => {
    const company = freshCompany();
    await signIn(company, "usr-owner", "owner");
    const memberCookie = await signIn(company, "usr-member", "member");

    expect(await roleOf(company, "usr-member")).toBe("member");
    // The right word, the right scope, a real session: refused anyway, and nothing is deleted.
    const result = await erase(memberCookie);
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
    expect(await count("auth_sessions", "tenant_id", company.tenantId)).toBe(2);
  });

  it("an admin is an admin, and an admin cannot erase either", async () => {
    const company = freshCompany();
    await signIn(company, "usr-owner", "owner");
    const adminCookie = await signIn(company, "usr-admin", "admin");

    expect(await roleOf(company, "usr-admin")).toBe("admin");
    const result = await erase(adminCookie);
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
  });

  it("a member who is the FIRST to sign in to a brand-new org is still only a member", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-first", "member");

    expect(await roleOf(company, "usr-first")).toBe("member");
    expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
  });

  it("a body with no role gets no owner or admin rights", async () => {
    const company = freshCompany();
    // `undefined` is "the body has no `role` field" — a token body from before the claim existed.
    const cookie = await signIn(company, "usr-norole", undefined);

    expect(await roleOf(company, "usr-norole")).toBe("member");
    expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
  });

  it.each(["superuser", "Owner", "OWNER", " owner", "builder", "", "owner,admin", 1, true, null, ["owner"]])(
    "an unknown role (%j) is rejected: no rights, never owner",
    async (role) => {
      const company = freshCompany();
      const cookie = await signIn(company, "usr-weird", role);

      expect(await roleOf(company, "usr-weird")).toBe("member");
      expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);
      await expectCompanyIntact(company);
    },
  );
});

describe("a role the portal changes reaches the host on the next refresh", () => {
  it("a promotion: a member the portal made an owner can erase once the check has run", async () => {
    const company = freshCompany();
    await signIn(company, "usr-owner", "owner");
    const cookie = await signIn(company, "usr-rising", "member");
    expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);

    portalRole.set("usr-rising", "owner");
    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-rising")).toBe("owner");
    // Past the owner check now: a wrong confirmation is a 400, not a 403.
    expect(errorCode(await erase(cookie, "not the word"))).toBe("invalid_request");
    await expectCompanyIntact(company);
  });

  it("a demotion: an owner the portal made a member is refused once the check has run", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-falling", "owner");
    expect(errorCode(await erase(cookie, "not the word"))).toBe("invalid_request");

    portalRole.set("usr-falling", "member");
    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-falling")).toBe("member");
    expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
  });

  it("the role stays what the host last read until the portal is asked again (the window is the 10 minutes)", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-window", "owner");
    portalRole.set("usr-window", "member");

    clock = { now: clock.now + PORTAL_CHECK_INTERVAL_MS - 1 };
    expect(json(await send(cookie, {})).status).toBe(200);
    expect(await roleOf(company, "usr-window")).toBe("owner");

    clock = { now: clock.now + 1 };
    expect(json(await send(cookie, {})).status).toBe(200);
    expect(await roleOf(company, "usr-window")).toBe("member");
  });

  it("an unknown role at a refresh takes the rights away rather than keeping the old ones", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-garbled", "owner");

    portalRole.set("usr-garbled", "superuser");
    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-garbled")).toBe("member");
    expect(errorCode(await erase(cookie))).toBe(TENANT_RESET_FORBIDDEN_CODE);
  });

  it("a refresh that carries no role at all takes the rights away too", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-silent", "admin");

    portalRole.set("usr-silent", undefined);
    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-silent")).toBe("member");
  });

  it("applies a refresh's role to the person whose session refreshed, and to nobody else", async () => {
    const company = freshCompany();
    const ownerCookie = await signIn(company, "usr-owner", "owner");
    await signIn(company, "usr-bystander", "admin");

    portalRole.set("usr-owner", "owner");
    portalRole.set("usr-bystander", "member");
    await afterTheCheckIsDue(ownerCookie);

    expect(await roleOf(company, "usr-owner")).toBe("owner");
    // The bystander has not made a request, so the portal has not been asked about them.
    expect(await roleOf(company, "usr-bystander")).toBe("admin");
  });
});

describe("the role the renderer is told, so it can hide what the host would refuse", () => {
  async function reportedRole(cookie: string): Promise<unknown> {
    const result = json(
      await routes.handleSession({
        method: "GET",
        path: "/api/v1/auth/session",
        query: {},
        params: {},
        headers: { cookie },
      }),
    );
    return (result.body as { role?: unknown }).role;
  }

  it.each(["owner", "admin", "member"] as const)("GET /auth/session reports %s for that person", async (role) => {
    const company = freshCompany();
    if (role !== "owner") {
      await signIn(company, "usr-owner", "owner");
    }
    const cookie = await signIn(company, `usr-${role}`, role);

    expect(await reportedRole(cookie)).toBe(role);
  });

  it("reports the row, so a role the portal changed shows up after the refresh and not before", async () => {
    const company = freshCompany();
    const cookie = await signIn(company, "usr-changing", "owner");
    portalRole.set("usr-changing", "member");
    expect(await reportedRole(cookie)).toBe("owner");

    await afterTheCheckIsDue(cookie);

    expect(await reportedRole(cookie)).toBe("member");
  });

  it("reports no role to anyone without a session", async () => {
    const result = json(
      await routes.handleSession({
        method: "GET",
        path: "/api/v1/auth/session",
        query: {},
        params: {},
        headers: {},
      }),
    );
    expect(result.body).toEqual({ signedIn: false });
  });
});

describe("a company that signed in before the portal sent roles", () => {
  /**
   * The shape every pre-fix deployment holds: the colleague's row says owner, because signing in wrote
   * one, and their session is live. Written the way the old code wrote it.
   */
  async function legacyOwner(company: Company, userId: string): Promise<string> {
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    await ensurePortalOwner(db, { ...company, userId, role: "owner" });
    const { createSession } = await import("./auth/session");
    const session = createSession({ ...company, userId, now: clock.now });
    const secrets = createSessionSecrets(() => getLocalVaultKey());
    await store.create(session, secrets.seal(session.id, { refreshToken: `refresh-0|${userId}|${company.tenantId}|${company.orgId}`, deviceId: "dev" }));
    return `${SESSION_COOKIE_SECURE}=${session.id}`;
  }

  it("is downgraded to what the portal says on the next refresh, after a restart's cold vault", async () => {
    const company = freshCompany();
    await signIn(company, "usr-realowner", "owner");
    const cookie = await legacyOwner(company, "usr-colleague");
    portalRole.set("usr-colleague", "member");
    expect(await roleOf(company, "usr-colleague")).toBe("owner");

    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-colleague")).toBe("member");
    const result = await erase(cookie);
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe(TENANT_RESET_FORBIDDEN_CODE);
    await expectCompanyIntact(company);
  });

  it("keeps the real owner an owner, because the portal still says so", async () => {
    const company = freshCompany();
    const cookie = await legacyOwner(company, "usr-realowner");
    portalRole.set("usr-realowner", "owner");

    await afterTheCheckIsDue(cookie);

    expect(await roleOf(company, "usr-realowner")).toBe("owner");
  });

  it("is also downgraded by the next SIGN-IN, whichever comes first", async () => {
    const company = freshCompany();
    await legacyOwner(company, "usr-colleague");
    expect(await roleOf(company, "usr-colleague")).toBe("owner");

    await signIn(company, "usr-colleague", "member");

    expect(await roleOf(company, "usr-colleague")).toBe("member");
  });
});

describe("Personal is unaffected: no portal, one local owner", () => {
  it("resolves the local owner as an owner with no session and no role claim anywhere", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const { getTenant } = await import("./tenant");

    const tenant = await getTenant();

    expect(tenant.userId).toBe(LOCAL_OWNER_ID);
    expect(tenant.role).toBe("owner");
  });

  it("still refuses the hosted erase on a desk, exactly as before", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const result = await dispatch(
      {
        method: "POST",
        path: "/api/v1/settings/reset",
        query: {},
        params: {},
        headers: {},
        body: { scope: "tenant", confirm: TENANT_ERASE_CONFIRM_WORD },
      },
      { serverMode: false },
    );

    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe("tenant_reset_disabled");
  });
});
