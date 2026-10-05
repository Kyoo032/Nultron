/**
 * Phase 8 — the hosted "Erase account", driven through `dispatch` end to end.
 *
 * Written through the router rather than against `resetTenant` directly, because half of what this
 * has to prove is about the route: that `scope: "all"` is still refused on a server, that
 * `scope: "tenant"` is refused on a desk, and that the confirmation and the owner check happen
 * before anything is deleted. A unit test of the function would prove none of that.
 *
 * **Owner decision 2026-10-01 (SR-65): erasing the company account deletes every person in it and ends
 * every session.** So the sessions here live in the real `auth_sessions` table through the same store
 * the hosted server runs on (`createDrizzleSessionStore`), not the in-memory one: the erase deletes
 * them in SQL, in one transaction with the content, and a memory store would never see it.
 *
 * The shapes it tries to break it with, none of which the happy path names:
 *
 * - a second tenant's rows, objects and signed-in browsers, present throughout, asserted untouched;
 * - a member who is not the owner;
 * - the right scope with the wrong word — including the OLD word, which a stale client still sends —
 *   and the right word with the wrong scope;
 * - the browsers of the people who were erased, whose next request has to be a 401 and not a desk;
 * - a portal that is down, which must never turn a finished erase into a failed one.
 */
import { mkdtempSync, existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-tenant-reset-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "9a41c7e0b3d85f264819ca70de3b5f8c2741ea96b0d35c8f7a2e64193bd0af57";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_STORAGE;
delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
// No portal in this file: a sealed token that reaches the default portal client finds no URL and
// counts as a failed best-effort sign-out, which is exactly what a portal that is down looks like.
delete process.env.AGENTFORGE_PORTAL_URL;
delete process.env.AGENTFORGE_PORTAL_CLIENT_ID;
delete process.env.AGENTFORGE_PORTAL_CLIENT_SECRET;

import { LOCAL_TENANT_ID, RESET_CONFIRM_WORD, TENANT_ERASE_CONFIRM_WORD, type TenantContext } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { dispatch } from "./router";
import { createSession } from "./auth/session";
import { createFakePortalClient, PortalError } from "./auth/portal-client";
import { createSessionSecrets } from "./auth/session-secrets";
import { createDrizzleSessionStore } from "./auth/session-store";
import { mediaRelativePath } from "./media-root";
import { resetTenant, tenantPurgeRoots } from "./tenant-reset";
import { tenantDataDir, TENANTS_DIR } from "./tenant-paths";
import {
  forgetTenantJobBytes,
  putTenantObject,
  resetObjectStoreForTests,
  tenantObjectStore,
  tenantStorageReport,
} from "./tenant-storage";
import type { HostJsonResult, HostRequest, HostResult } from "./types";
import type { SessionStore } from "./auth/session-store";

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
const ALPHA = { tenantId: "reset-tenant-a", orgId: "reset-org-a", userId: "reset-user-a" };
const BETA = { tenantId: "reset-tenant-b", orgId: "reset-org-b", userId: "reset-user-b" };

/** A second person in alpha's company, signed in on a browser of their own. */
const COLLEAGUE = { tenantId: ALPHA.tenantId, orgId: ALPHA.orgId, userId: "reset-user-a-colleague" };

let store: SessionStore;
const cookies: Record<string, string> = {};
/** What each browser's sealed refresh token was sealed from, so a test can look for it afterwards. */
const refreshTokens: Record<string, string> = {};

function json(result: HostResult): HostJsonResult {
  if (result.type !== "json") {
    throw new Error(`expected a json result, got ${result.type}`);
  }
  return result;
}

function body(result: HostResult): Record<string, unknown> {
  return json(result).body as Record<string, unknown>;
}

function errorCode(result: HostResult): string | undefined {
  const payload = body(result).error as { code?: string } | string | undefined;
  return typeof payload === "string" ? payload : payload?.code;
}

async function send(as: string, over: Partial<HostRequest>, serverMode = true): Promise<HostResult> {
  return dispatch(
    {
      method: "GET",
      path: "/api/v1/storage/usage",
      query: {},
      params: {},
      headers: { cookie: cookies[as] },
      ...over,
    },
    { serverMode, sessionStore: store, now: () => T0 },
  );
}

function resetBody(scope: string, confirm?: string): Partial<HostRequest> {
  return {
    method: "POST",
    path: "/api/v1/settings/reset",
    body: confirm === undefined ? { scope } : { scope, confirm },
  };
}

type Principal = { tenantId: string; orgId: string; userId: string };

/**
 * One signed-in browser: the host's rows for the person, a session row in `auth_sessions`, and — as
 * sign-in leaves it — the portal refresh token sealed on that row under the deployment's wrap key.
 */
async function signIn(as: string, who: Principal, role: "owner" | "member" = "owner"): Promise<void> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  // The real provisioning path, with the role the portal would have sent (SR-65): a member is a
  // member because the portal said so, no longer because the test hand-wrote the row.
  await ensurePortalOwner(db, { ...who, role });
  const session = createSession({ ...who, now: T0 });
  refreshTokens[as] = `refresh-token-of-${as}`;
  const sealed = createSessionSecrets(() => getLocalVaultKey()).seal(session.id, {
    refreshToken: refreshTokens[as] as string,
    deviceId: `device-of-${as}`,
  });
  await store.create(session, sealed);
  cookies[as] = `__Host-agentforge_session=${session.id}`;
}

/** Everybody signed in afresh: every test starts from the same three live browsers. */
async function signInEveryone(): Promise<void> {
  const { db } = await import("@agentforge/db");
  db.$client.prepare("DELETE FROM auth_sessions").run();
  await signIn("alpha", ALPHA);
  await signIn("colleague", COLLEAGUE, "member");
  await signIn("beta", BETA);
}

async function sessionRows(tenantId: string): Promise<number> {
  return countRows("auth_sessions", "tenant_id", tenantId);
}

async function sealedRows(tenantId: string): Promise<number> {
  const { db } = await import("@agentforge/db");
  const row = db.$client
    .prepare("SELECT count(*) AS n FROM auth_sessions WHERE tenant_id = ? AND refresh_sealed IS NOT NULL")
    .get(tenantId) as { n: number };
  return row.n;
}

/** The audit row's `detail`, which is where a best-effort portal sign-out that fell short is said. */
async function lastAuditDetail(tenantId: string): Promise<string | null> {
  const { db } = await import("@agentforge/db");
  const row = db.$client
    .prepare("SELECT detail FROM tenant_reset_audit WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(tenantId) as { detail: string | null } | undefined;
  return row?.detail ?? null;
}

/** Rows and bytes for one tenant, so "gone" and "kept" both mean something afterwards. */
async function seed(as: "alpha" | "beta", who: typeof ALPHA): Promise<{ mediaId: string; scratch: string }> {
  const { db, media } = await import("@agentforge/db");
  // The default chat agent is provisioned lazily by the chat route, not by `ensurePortalOwner`, so
  // a thread cannot be created before something has asked for it. This is also the seed that gives
  // the purge an `agents` and an `agent_versions` row to take.
  const chat = await send(as, { method: "GET", path: "/api/v1/chat" });
  expect(json(chat).status).toBeLessThan(400);
  const agentId = ((body(chat).agent as { id?: string } | undefined)?.id ?? "") as string;
  expect(agentId).not.toBe("");
  const created = await send(as, { method: "POST", path: "/api/v1/threads", body: { agentId, title: "t" } });
  expect(json(created).status).toBeLessThan(400);

  const mediaId = `${who.tenantId}-media`;
  const key = mediaRelativePath(who.tenantId, [who.orgId], `${mediaId}.bin`);
  await putTenantObject(who.tenantId, key, new Uint8Array(512).fill(4), "application/octet-stream");
  await db.insert(media).values({
    id: mediaId,
    organizationId: who.orgId,
    userId: who.userId,
    kind: "image",
    mime: "application/octet-stream",
    sizeBytes: 512,
    storagePath: key,
    url: `/api/v1/media/${mediaId}/file`,
  });

  // A job tree on local disk: the bytes the object store does not hold.
  const scratch = join(tenantDataDir(who.tenantId), "edit", "scratch.bin");
  mkdirSync(join(tenantDataDir(who.tenantId), "edit"), { recursive: true });
  writeFileSync(scratch, Buffer.alloc(128, 7));
  forgetTenantJobBytes(who.tenantId);
  return { mediaId, scratch };
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { db } = await import("@agentforge/db");
  const row = db.$client.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
  return row.n;
}

async function audits(tenantId: string): Promise<Array<{ outcome: string; rows_deleted: number }>> {
  const { db } = await import("@agentforge/db");
  return db.$client
    .prepare("SELECT outcome, rows_deleted FROM tenant_reset_audit WHERE tenant_id = ? ORDER BY started_at")
    .all(tenantId) as Array<{ outcome: string; rows_deleted: number }>;
}

/** What `resolvePortalTenant` hands the handlers for alpha's owner, for calling `resetTenant` directly. */
const ALPHA_OWNER: TenantContext = {
  tenantId: ALPHA.tenantId,
  organizationId: ALPHA.orgId,
  workspaceId: "reset-desk-a",
  userId: ALPHA.userId,
  role: "owner",
};

describe("POST /api/v1/settings/reset with scope tenant", () => {
  beforeAll(async () => {
    const { db } = await import("@agentforge/db");
    // The store the hosted server runs on. The erase deletes `auth_sessions` rows in SQL, so a memory
    // store would never see it.
    store = createDrizzleSessionStore(db);
  });

  beforeEach(async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const { db } = await import("@agentforge/db");
    db.$client.prepare("DELETE FROM tenant_reset_audit").run();
    db.$client.prepare("DELETE FROM tenant_storage").run();
    db.$client.prepare("DELETE FROM media").run();
    rmSync(join(dataDir, "media"), { recursive: true, force: true });
    resetObjectStoreForTests();
    forgetTenantJobBytes();
    // Both companies exist again after a previous test erased one, each with its browsers signed in.
    await signInEveryone();
  });

  afterEach(() => {
    delete process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
  });

  it("erases the caller's rows, objects and local files", async () => {
    const alpha = await seed("alpha", ALPHA);
    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(1);
    expect(existsSync(alpha.scratch)).toBe(true);

    const result = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(200);
    expect(body(result).ok).toBe(true);
    expect(body(result).scope).toBe("tenant");
    // Nothing is staged and nothing restarts: by the time this answers, it has already happened.
    expect(body(result).relaunch).toBe(false);
    expect(body(result).resetPending).toBe(false);
    // The caller is one of the people it erased, so the answer says they are signed out. There is no
    // home desk to send them to any more.
    expect(body(result).signedOut).toBe(true);
    expect(body(result).workspaceId).toBeUndefined();

    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(0);
    expect(await countRows("threads", "organization_id", ALPHA.orgId)).toBe(0);
    expect(await countRows("tenant_state", "tenant_id", ALPHA.tenantId)).toBe(0);
    expect(await countRows("tenant_storage", "tenant_id", ALPHA.tenantId)).toBe(0);
    expect(existsSync(alpha.scratch)).toBe(false);
    const report = await tenantStorageReport(ALPHA.tenantId);
    expect(report.usedBytes).toBe(0);
  });

  it("leaves every other tenant's rows, bytes and signed-in browsers exactly as they were", async () => {
    await seed("alpha", ALPHA);
    const beta = await seed("beta", BETA);
    const betaBefore = await tenantStorageReport(BETA.tenantId);

    await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));

    expect(await countRows("media", "organization_id", BETA.orgId)).toBe(1);
    expect(await countRows("threads", "organization_id", BETA.orgId)).toBe(1);
    expect(existsSync(beta.scratch)).toBe(true);
    forgetTenantJobBytes(BETA.tenantId);
    expect((await tenantStorageReport(BETA.tenantId)).usedBytes).toBe(betaBefore.usedBytes);
    // Beta's browser, its session row and the refresh token sealed on it are all still there, and the
    // session still works, which is the whole point of the prefix guard.
    expect(await sessionRows(BETA.tenantId)).toBe(1);
    expect(await sealedRows(BETA.tenantId)).toBe(1);
    expect(await countRows("user", "id", BETA.userId)).toBe(1);
    expect(json(await send("beta", {})).status).toBe(200);
  });

  it("ends every session of the company and wipes every stored refresh token (SR-65)", async () => {
    // Two people signed in, each with a portal refresh token sealed on their own session row.
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
    expect(await sealedRows(ALPHA.tenantId)).toBe(2);

    const result = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(200);

    // Rows, not revocations: a revoked row would still name a user and a tenant that no longer exist.
    expect(await sessionRows(ALPHA.tenantId)).toBe(0);
    expect(await sealedRows(ALPHA.tenantId)).toBe(0);
    // And another company's sessions, tokens included, are exactly as they were.
    expect(await sessionRows(BETA.tenantId)).toBe(1);
    expect(await sealedRows(BETA.tenantId)).toBe(1);
  });

  it("signs out every erased browser: the next request from any of them is a 401", async () => {
    // Everybody can work before.
    expect(json(await send("alpha", {})).status).toBe(200);
    expect(json(await send("colleague", {})).status).toBe(200);

    expect(json(await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD))).status).toBe(200);

    for (const browser of ["alpha", "colleague"]) {
      const after = await send(browser, { method: "GET", path: "/api/v1/threads" });
      expect(json(after).status, browser).toBe(401);
      expect(errorCode(after), browser).toBe("session_required");
    }
    // The caller cannot press the button a second time either: their session is gone with the rest.
    const again = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(again).status).toBe(401);
    // Another company's browser is untouched.
    expect(json(await send("beta", {})).status).toBe(200);
  });

  it("deletes every person in the company, the caller included, and does not put the account back", async () => {
    expect(await countRows("user", "id", ALPHA.userId)).toBe(1);
    expect(await countRows("user", "id", COLLEAGUE.userId)).toBe(1);

    await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));

    expect(await countRows("user", "id", ALPHA.userId)).toBe(0);
    expect(await countRows("user", "id", COLLEAGUE.userId)).toBe(0);
    expect(await countRows("organization_members", "organization_id", ALPHA.orgId)).toBe(0);
    // No re-provisioning: the old design put the org back so the caller could carry on. The company is
    // gone; the tenant row stays because the contract, the plan and the invoices hang off it.
    expect(await countRows("organizations", "tenant_id", ALPHA.tenantId)).toBe(0);
    expect(await countRows("workspaces", "organization_id", ALPHA.orgId)).toBe(0);
    expect(await countRows("tenants", "id", ALPHA.tenantId)).toBe(1);
    // Beta's people are not touched.
    expect(await countRows("organization_members", "organization_id", BETA.orgId)).toBe(1);
  });

  it("does not let an old cookie come back to life when somebody signs in again through the portal", async () => {
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    // The portal still vouches for this person, so a later sign-in writes the rows again...
    await ensurePortalOwner(db, { ...ALPHA, role: "owner" });
    // ...but the browser that was signed in before the erase stays signed out: its row is gone.
    const stale = await send("alpha", { method: "GET", path: "/api/v1/threads" });
    expect(json(stale).status).toBe(401);
    expect(errorCode(stale)).toBe("session_required");
  });

  it("keeps the plan, the seats, the usage ledger and the billing events", async () => {
    const { db } = await import("@agentforge/db");
    const now = Date.now();
    db.$client
      .prepare("INSERT OR REPLACE INTO tenant_plan (tenant_id, period_start, period_end, updated_at) VALUES (?, ?, ?, ?)")
      .run(ALPHA.tenantId, now, now + 1000, now);
    db.$client
      .prepare(
        "INSERT OR REPLACE INTO tenant_usage (id, tenant_id, organization_id, mode, model, unit, quantity, at) VALUES (?, ?, ?, 'chat', 'm', 'token', 1, ?)",
      )
      .run("keep-usage", ALPHA.tenantId, ALPHA.orgId, now);
    db.$client
      .prepare(
        "INSERT OR REPLACE INTO billing_events (event_id, tenant_id, kind, occurred_at, received_at) VALUES (?, ?, 'paid', ?, ?)",
      )
      .run("keep-event", ALPHA.tenantId, now, now);

    await seed("alpha", ALPHA);
    await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));

    expect(await countRows("tenants", "id", ALPHA.tenantId)).toBe(1);
    expect(await countRows("tenant_plan", "tenant_id", ALPHA.tenantId)).toBe(1);
    expect(await countRows("tenant_usage", "tenant_id", ALPHA.tenantId)).toBe(1);
    expect(await countRows("billing_events", "tenant_id", ALPHA.tenantId)).toBe(1);
  });

  it("writes one completed audit row, and keeps it after the purge", async () => {
    await seed("alpha", ALPHA);
    await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    const rows = await audits(ALPHA.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("completed");
    expect(rows[0]?.rows_deleted).toBeGreaterThan(0);
  });

  it("is safe to run twice at the function: the second pass takes nothing and still completes", async () => {
    await seed("alpha", ALPHA);
    const first = await resetTenant(ALPHA_OWNER, TENANT_ERASE_CONFIRM_WORD);
    expect(first.objectsDeleted).toBe(1);
    // A storage backend can refuse half way, and "run it again" is the documented answer. After a
    // completed erase there is no browser left to press the button, so this is the function's own
    // idempotence, not the route's.
    const second = await resetTenant(ALPHA_OWNER, TENANT_ERASE_CONFIRM_WORD);
    expect(second.objectsDeleted).toBe(0);
    expect(second.rowsDeleted).toBe(0);
    const rows = await audits(ALPHA.tenantId);
    expect(rows.map((row) => row.outcome)).toEqual(["completed", "completed"]);
  });

  it.each([
    ["a wrong word", "yes"],
    // The word the desk's Start over uses. A client that predates this decision still sends it, and
    // erasing a company must not be possible with the lighter word.
    ["the old word", RESET_CONFIRM_WORD],
    ["the right word in the wrong case", "delete"],
    ["the right word with company text around it", "DELETE everything"],
    ["an empty word", ""],
  ])("refuses %s, and deletes nothing", async (_label, confirm) => {
    await seed("alpha", ALPHA);
    const result = await send("alpha", resetBody("tenant", confirm));
    expect(json(result).status).toBe(400);
    expect(errorCode(result)).toBe("invalid_request");
    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(1);
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
    expect(await sealedRows(ALPHA.tenantId)).toBe(2);
    expect(await countRows("user", "id", COLLEAGUE.userId)).toBe(1);
    // Refused before the audit row is opened: nothing happened, so nothing is recorded.
    expect(await audits(ALPHA.tenantId)).toHaveLength(0);
    // And the browser is still signed in.
    expect(json(await send("alpha", {})).status).toBe(200);
  });

  it("refuses a missing confirmation the same way", async () => {
    await seed("alpha", ALPHA);
    const result = await send("alpha", resetBody("tenant"));
    expect(json(result).status).toBe(400);
    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(1);
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
  });

  it("refuses a member who is not the owner, and deletes nothing", async () => {
    await seed("alpha", ALPHA);
    // The colleague's browser, with the right word: the role comes from the membership row and not
    // from anything the request carried.
    const result = await send("colleague", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe("tenant_reset_forbidden");
    // The refusal is not `gateway_blocked`: that code sends the renderer to the paste-your-key
    // screen, which has nothing to do with being refused an erase.
    expect(errorCode(result)).not.toBe("gateway_blocked");
    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(1);
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
    expect(await sealedRows(ALPHA.tenantId)).toBe(2);
    expect(await audits(ALPHA.tenantId)).toHaveLength(0);
  });

  it("refuses an administrator too: erasing the company is the owner's act alone", async () => {
    const { db } = await import("@agentforge/db");
    db.$client
      .prepare("UPDATE organization_members SET role = 'admin' WHERE organization_id = ? AND user_id = ?")
      .run(COLLEAGUE.orgId, COLLEAGUE.userId);
    const result = await send("colleague", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe("tenant_reset_forbidden");
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
  });

  it("still refuses scope all on a server, with the code it has always used", async () => {
    await seed("alpha", ALPHA);
    const result = await send("alpha", resetBody("all", RESET_CONFIRM_WORD));
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe("reset_disabled");
    expect(await countRows("media", "organization_id", ALPHA.orgId)).toBe(1);
    expect(await sessionRows(ALPHA.tenantId)).toBe(2);
  });

  it("names the three scopes it accepts when it is handed a fourth", async () => {
    const result = await send("alpha", resetBody("everything", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(400);
    const message = (body(result).error as { message?: string }).message ?? "";
    expect(message).toContain("tenant");
    expect(message).toContain("all");
  });
});

/**
 * The portal half. The portal has no "remove a company" call, so what the host can do is sign each
 * signed-in person out of the portal with the refresh token it holds for them — before the erase
 * deletes it — and that is best effort: it can never fail an erase that has already happened.
 */
describe("the erase and the portal", () => {
  beforeEach(async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const { db } = await import("@agentforge/db");
    db.$client.prepare("DELETE FROM tenant_reset_audit").run();
    resetObjectStoreForTests();
    forgetTenantJobBytes();
    await signInEveryone();
  });

  afterEach(() => {
    delete process.env.AGENTFORGE_SERVER;
  });

  it("signs every signed-in person out of the portal with the token it held for them, before deleting it", async () => {
    const portal = createFakePortalClient();
    const outcome = await resetTenant(ALPHA_OWNER, TENANT_ERASE_CONFIRM_WORD, { portal });

    const refreshed = portal.calls.filter((call) => call.kind === "refresh");
    expect(refreshed.map((call) => (call.kind === "refresh" ? call.refreshToken : "")).sort()).toEqual(
      [refreshTokens.alpha, refreshTokens.colleague].sort(),
    );
    // The device id sealed beside each token travels with it, as the gate sends it.
    expect(refreshed.map((call) => (call.kind === "refresh" ? call.deviceId : null)).sort()).toEqual([
      "device-of-alpha",
      "device-of-colleague",
    ]);
    // Everywhere, not just this browser: the portal's own sessions for that person go too.
    expect(portal.calls.filter((call) => call.kind === "logout")).toEqual([
      { kind: "logout", allDevices: true },
      { kind: "logout", allDevices: true },
    ]);
    expect(outcome.portalSignOut).toEqual({ people: 2, signedOut: 2, failed: 0, unreachable: 0, unfinished: 0 });
    expect(await lastAuditDetail(ALPHA.tenantId)).toBeNull();
    // And beta's token was never presented.
    expect(refreshed.some((call) => call.kind === "refresh" && call.refreshToken === refreshTokens.beta)).toBe(false);
  });

  it("is a completed erase, with the shortfall on the audit row, when the portal cannot be reached", async () => {
    const portal = createFakePortalClient({ failWith: new PortalError("portal_unavailable", 503) });
    const outcome = await resetTenant(ALPHA_OWNER, TENANT_ERASE_CONFIRM_WORD, { portal });

    expect(outcome.ok).toBe(true);
    expect(outcome.portalSignOut).toMatchObject({ people: 2, failed: 2, signedOut: 0 });
    // The host's side is finished whatever the portal said.
    expect(await sessionRows(ALPHA.tenantId)).toBe(0);
    expect(await sealedRows(ALPHA.tenantId)).toBe(0);
    expect(await countRows("user", "id", COLLEAGUE.userId)).toBe(0);
    const rows = await audits(ALPHA.tenantId);
    expect(rows.map((row) => row.outcome)).toEqual(["completed"]);
    expect(await lastAuditDetail(ALPHA.tenantId)).toBe("portal_signout_incomplete");
  });

  it("completes through the route with no portal configured, and says so on the audit row", async () => {
    // No AGENTFORGE_PORTAL_URL in this file, so the default client cannot be built: the same outcome as
    // a portal that is down. The browsers are signed out and the row says the portal was not reached.
    const result = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(200);
    expect(await lastAuditDetail(ALPHA.tenantId)).toBe("portal_signout_incomplete");
    expect(await sessionRows(ALPHA.tenantId)).toBe(0);
  });

  it("counts a person who held no sealed token as one the portal still has", async () => {
    const { db } = await import("@agentforge/db");
    db.$client
      .prepare("UPDATE auth_sessions SET refresh_sealed = NULL WHERE user_id = ?")
      .run(COLLEAGUE.userId);
    const portal = createFakePortalClient();
    const outcome = await resetTenant(ALPHA_OWNER, TENANT_ERASE_CONFIRM_WORD, { portal });
    // The colleague has no token here, so the portal keeps their sessions: the gap the portal's API
    // leaves, recorded rather than hidden. Only the owner could be signed out.
    expect(portal.calls.filter((call) => call.kind === "refresh")).toHaveLength(1);
    expect(outcome.portalSignOut).toMatchObject({ people: 1, signedOut: 1 });
    // The host side is complete for both regardless.
    expect(await sessionRows(ALPHA.tenantId)).toBe(0);
    expect(await countRows("user", "id", COLLEAGUE.userId)).toBe(0);
  });
});

describe("scope tenant off the hosted server", () => {
  beforeEach(() => {
    delete process.env.AGENTFORGE_SERVER;
  });

  it("is refused on a desk, where Start over is the one that works", async () => {
    const result = await dispatch(
      { method: "POST", path: "/api/v1/settings/reset", query: {}, params: {}, headers: {}, body: { scope: "tenant", confirm: TENANT_ERASE_CONFIRM_WORD } },
      { serverMode: false },
    );
    expect(json(result).status).toBe(403);
    expect(errorCode(result)).toBe("tenant_reset_disabled");
  });
});

describe("the local tenant can never be purged as a tenant", () => {
  it("refuses a whole-prefix delete for local-tenant, in the store itself", async () => {
    // Lane D gives the local tenant the bare root, so "everything under its prefix" is every other
    // tenant's objects. The guard is in the store rather than at the route, which is what makes it
    // hold for a mis-resolved id as well as for a bad request.
    await expect(tenantObjectStore().removePrefix(LOCAL_TENANT_ID)).rejects.toMatchObject({
      code: "storage_purge_refused",
    });
  });

  it("scopes every purge root under the data directory", () => {
    for (const root of tenantPurgeRoots(ALPHA.tenantId)) {
      expect(root.startsWith(dataDir)).toBe(true);
      // And each one is inside the tenant's own subtree, never a shared root.
      expect(root).toContain(ALPHA.tenantId);
    }
  });
});

/**
 * The route, against a data directory somebody has planted a symlink in.
 *
 * `removePrefix`'s own symlink shapes are proved in `tenant-storage.test.ts`; this is the other
 * half of the same finding — step 4 of the reset, which deletes the five local roots — and it is
 * proved through `dispatch` because the answer matters as much as the filesystem. Before the fix
 * the route answered **200** with a `completed` audit row while the linked-to tree was gone, which
 * is the worst possible pairing: the owner is told their account was erased cleanly and the thing
 * that was actually erased belongs to somebody else.
 *
 * The rows, the people and the sessions go in the transaction that precedes the disk step, so a
 * refusal here has already signed the company out; what the owner sees is the 500 and a `failed`
 * audit row, and the retry is to sign in again and press the button again.
 */
describe("the reset and symlinks", () => {
  beforeEach(async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const { db } = await import("@agentforge/db");
    db.$client.prepare("DELETE FROM tenant_reset_audit").run();
    resetObjectStoreForTests();
    forgetTenantJobBytes();
    await signInEveryone();
  });

  afterEach(() => {
    delete process.env.AGENTFORGE_SERVER;
    rmSync(join(dataDir, TENANTS_DIR, ALPHA.tenantId), { recursive: true, force: true });
  });

  it("refuses when the tenant's data directory is a link to another tree, and keeps that tree", async () => {
    // The media root is the realistic target: it is inside the data directory, so a guard that only
    // asked "does this still resolve under the data directory?" said yes and deleted it.
    const decoy = join(dataDir, "media", "org");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "everyones.bin"), Buffer.alloc(64, 1));

    const link = join(dataDir, TENANTS_DIR, ALPHA.tenantId);
    mkdirSync(join(dataDir, TENANTS_DIR), { recursive: true });
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(dataDir, "media"), link, "dir");

    const result = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(500);
    expect(errorCode(result)).toBe("tenant_reset_refused");
    expect(existsSync(join(decoy, "everyones.bin"))).toBe(true);

    // And the audit row says `failed`, so the owner is not told a refused reset succeeded.
    const rows = await audits(ALPHA.tenantId);
    expect(rows.at(-1)?.outcome).toBe("failed");
  });

  it("refuses when the tenant's data directory is a link to another tenant's", async () => {
    const betaRoot = join(dataDir, TENANTS_DIR, BETA.tenantId, "edit");
    mkdirSync(betaRoot, { recursive: true });
    writeFileSync(join(betaRoot, "beta.bin"), Buffer.alloc(32, 2));

    const link = join(dataDir, TENANTS_DIR, ALPHA.tenantId);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(dataDir, TENANTS_DIR, BETA.tenantId), link, "dir");

    const result = await send("alpha", resetBody("tenant", TENANT_ERASE_CONFIRM_WORD));
    expect(json(result).status).toBe(500);
    expect(errorCode(result)).toBe("tenant_reset_refused");
    expect(existsSync(join(betaRoot, "beta.bin"))).toBe(true);
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
