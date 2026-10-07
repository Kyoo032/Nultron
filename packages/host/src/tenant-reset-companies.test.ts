/**
 * SR-163, review round: the hosted "Erase account" on a partner that holds more than one company.
 *
 * `TenantContext.tenantId` is the white-label partner and a company is an organisation inside it. The
 * erase (`tenant-reset.ts`) is written against the partner: `purgeTenantRows` deletes every
 * organisation of the tenant, every session and person, and the file and key steps are partner-wide too.
 * With one company per partner that is "my company"; with several (a white-label partner, where every SME is a company
 * under one partner) it let the owner of company B erase company A.
 *
 * The smallest safe change is a refusal before anything is touched: more than one organisation under
 * the partner answers `409 tenant_erase_shared_partner` and the operator does the erase. Scoping the
 * purge to one organisation is an owner decision and a bigger change, and is not made here.
 *
 * Real router, real sessions in `auth_sessions`, real database and a throwaway data dir. Every case
 * takes a partner of its own, so none sees another's rows.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-reset-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "5c8e1f3a7b2d4960a1e8c3b5d7f94e26b0a3c5e7d9f14826a8c0e2b4d6f81a35";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_STORAGE;
delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
delete process.env.AGENTFORGE_PORTAL_URL;
delete process.env.AGENTFORGE_PORTAL_CLIENT_ID;
delete process.env.AGENTFORGE_PORTAL_CLIENT_SECRET;

import { TENANT_ERASE_CONFIRM_WORD, type TenantContext } from "@agentforge/core";
import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createDrizzleSessionStore, type SessionStore } from "./auth/session-store";
import { dispatch } from "./router";
import { saveGateState, loadGateState } from "./gateway-gate";
import { mediaRelativePath } from "./media-root";
import { loadSettings, saveSettings } from "./settings-store";
import { resetTenant, TENANT_RESET_SHARED_PARTNER_CODE } from "./tenant-reset";
import { tenantDataDir } from "./tenant-paths";
import {
  forgetTenantJobBytes,
  putTenantObject,
  resetObjectStoreForTests,
  tenantStorageReport,
} from "./tenant-storage";
import type { HostJsonResult, HostResult } from "./types";

const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);

let store: SessionStore;
let seq = 0;

type Company = {
  readonly partner: string;
  readonly tenant: TenantContext;
  readonly cookie: string;
  readonly scratch: string;
};

function json(result: HostResult): HostJsonResult {
  if (result.type !== "json") {
    throw new Error(`expected a json result, got ${result.type}`);
  }
  return result;
}

function errorOf(result: HostResult): { code?: string; message?: string } {
  const payload = (json(result).body as { error?: { code?: string; message?: string } | string }).error;
  return typeof payload === "string" ? { code: payload } : (payload ?? {});
}

async function send(
  company: Company,
  method: string,
  path: string,
  body?: unknown,
  serverMode = true,
): Promise<HostResult> {
  return dispatch(
    {
      method,
      path,
      query: {},
      params: {},
      headers: { cookie: company.cookie },
      ...(body === undefined ? {} : { body }),
    },
    { serverMode, sessionStore: store, now: () => T0 },
  );
}

const erase = (company: Company, confirm: string = TENANT_ERASE_CONFIRM_WORD) =>
  send(company, "POST", "/api/v1/settings/reset", { scope: "tenant", confirm });

function freshPartner(): string {
  seq += 1;
  return `reset-partner-${seq}`;
}

const keyFor = (company: Company) => `sk-reset-${company.tenant.organizationId}-${"x".repeat(20)}`;

/**
 * One company under `partner`: its own organisation, one owner signed in on the real session store,
 * a Chat thread, a media object, a job-tree file, a gateway key and a stored verdict for that key.
 */
async function provision(partner: string, label: string): Promise<Company> {
  const { db, ensurePortalOwner, media } = await import("@agentforge/db");
  seq += 1;
  const identity = { tenantId: partner, orgId: `reset-org-${label}-${seq}`, userId: `reset-user-${label}-${seq}` };
  const tenant = await ensurePortalOwner(db, { ...identity, role: "owner" });
  const session = createSession({ ...identity, now: T0 });
  await store.create(session);
  const scratch = join(tenantDataDir(partner), "edit", `${identity.orgId}-scratch.bin`);
  const company: Company = { partner, tenant, cookie: `${SESSION_COOKIE_SECURE}=${session.id}`, scratch };

  const chat = await send(company, "GET", "/api/v1/chat");
  const agentId = ((json(chat).body as { agent?: { id?: string } }).agent?.id ?? "") as string;
  expect(agentId).not.toBe("");
  const created = await send(company, "POST", "/api/v1/threads", { agentId, title: "t" });
  expect(json(created).status).toBeLessThan(400);

  const mediaId = `${identity.orgId}-media`;
  const key = mediaRelativePath(partner, [identity.orgId], `${mediaId}.bin`);
  await putTenantObject(partner, key, new Uint8Array(256).fill(4), "application/octet-stream");
  await db.insert(media).values({
    id: mediaId,
    organizationId: identity.orgId,
    userId: identity.userId,
    kind: "image",
    mime: "application/octet-stream",
    sizeBytes: 256,
    storagePath: key,
    url: `/api/v1/media/${mediaId}/file`,
  });
  mkdirSync(join(tenantDataDir(partner), "edit"), { recursive: true });
  writeFileSync(scratch, Buffer.alloc(64, 7));
  forgetTenantJobBytes(partner);

  saveSettings({ openaiApiKey: keyFor(company) }, tenant);
  saveGateState(
    partner,
    { version: 1, fingerprint: "fp", status: "ok", checkedAt: new Date(T0).toISOString(), lastOkAt: null },
    identity.orgId,
  );
  return company;
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { db } = await import("@agentforge/db");
  return (db.$client.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number }).n;
}

/** Everything the erase would take from one company, as numbers and booleans a test can compare. */
async function holdings(company: Company) {
  const org = company.tenant.organizationId;
  return {
    organisation: await count("organizations", "id", org),
    desks: await count("workspaces", "organization_id", org),
    threads: await count("threads", "organization_id", org),
    media: await count("media", "organization_id", org),
    people: await count("organization_members", "organization_id", org),
    user: await count("user", "id", company.tenant.userId),
    sessions: await count("auth_sessions", "user_id", company.tenant.userId),
    scratchFile: existsSync(company.scratch),
    key: loadSettings(company.tenant).openaiApiKey ?? null,
    verdict: loadGateState(company.partner, org)?.status ?? null,
  };
}

async function partnerHoldings(partner: string) {
  return {
    organisations: await count("organizations", "tenant_id", partner),
    stateRows: await count("tenant_state", "tenant_id", partner),
    sessions: await count("auth_sessions", "tenant_id", partner),
    usedBytes: (await tenantStorageReport(partner)).usedBytes,
  };
}

async function audits(partner: string): Promise<number> {
  return count("tenant_reset_audit", "tenant_id", partner);
}

beforeAll(async () => {
  const { db } = await import("@agentforge/db");
  store = createDrizzleSessionStore(db);
}, 180_000);

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a partner with more than one company: the erase is refused, whoever asks", () => {
  it("refuses company B's owner with 409 and deletes nothing of either company", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    const before = { a: await holdings(a), b: await holdings(b), partner: await partnerHoldings(partner) };
    expect(before.a).toMatchObject({ organisation: 1, threads: 1, media: 1, sessions: 1, scratchFile: true });
    expect(before.partner.organisations).toBe(2);

    const result = await erase(b);

    expect(json(result).status).toBe(409);
    expect(errorOf(result).code).toBe(TENANT_RESET_SHARED_PARTNER_CODE);
    expect(errorOf(result).code).toBe("tenant_erase_shared_partner");
    // A plain sentence: it says why and who can do it. It must not be mistaken for the key gate.
    expect(errorOf(result).code).not.toBe("gateway_blocked");
    expect(errorOf(result).message).toMatch(/several companies/i);
    expect(errorOf(result).message).toMatch(/operator/i);

    // Rows, files, keys, verdicts, people and sessions of BOTH companies are exactly as they were.
    expect({ a: await holdings(a), b: await holdings(b), partner: await partnerHoldings(partner) }).toEqual(before);
    // Refused before the audit row is opened: nothing happened, so nothing is recorded.
    expect(await audits(partner)).toBe(0);
    // And the caller is still signed in, on a working session.
    expect(json(await send(b, "GET", "/api/v1/storage/usage")).status).toBe(200);
    expect(json(await send(a, "GET", "/api/v1/storage/usage")).status).toBe(200);
  });

  it("refuses company A's owner the same way (the refusal is the partner's, not B's)", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    const before = { a: await holdings(a), b: await holdings(b) };

    expect(errorOf(await erase(a)).code).toBe("tenant_erase_shared_partner");
    expect({ a: await holdings(a), b: await holdings(b) }).toEqual(before);
  });

  it("refuses the function itself, not only the route, before it opens an audit row", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    await provision(partner, "b");
    const before = await holdings(a);

    await expect(resetTenant(a.tenant, TENANT_ERASE_CONFIRM_WORD)).rejects.toMatchObject({
      code: "tenant_erase_shared_partner",
      status: 409,
    });
    expect(await holdings(a)).toEqual(before);
    expect(await audits(partner)).toBe(0);
  });

  it("counts an organisation that has no people or desks left too", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const { db } = await import("@agentforge/db");
    db.$client
      .prepare(
        "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(`empty-org-${partner}`, partner, "Empty", `empty-${partner}`, "generic", T0);
    const before = await holdings(a);

    expect(errorOf(await erase(a)).code).toBe("tenant_erase_shared_partner");
    expect(await holdings(a)).toEqual(before);
  });

  it("still answers 403 to a member before it says anything about companies", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    await provision(partner, "b");
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    const identity = { tenantId: partner, orgId: a.tenant.organizationId, userId: `member-of-${partner}` };
    await ensurePortalOwner(db, { ...identity, role: "member" });
    const session = createSession({ ...identity, now: T0 });
    await store.create(session);
    const member: Company = { ...a, cookie: `${SESSION_COOKIE_SECURE}=${session.id}` };

    const result = await erase(member);
    expect(json(result).status).toBe(403);
    expect(errorOf(result).code).toBe("tenant_reset_forbidden");
  });

  it("still asks for the confirmation word first, with the 400 it always sent", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    await provision(partner, "b");

    const result = await erase(a, "yes");
    expect(json(result).status).toBe(400);
    expect(errorOf(result).code).toBe("invalid_request");
  });
});

describe("a partner with one company: the erase is exactly what it was", () => {
  it("erases the company's rows, people, sessions, files, key and verdict", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    expect((await holdings(a)).key).toBe(keyFor(a));

    const result = await erase(a);

    expect(json(result).status).toBe(200);
    expect(json(result).body).toMatchObject({ ok: true, scope: "tenant", signedOut: true });
    expect(await holdings(a)).toEqual({
      organisation: 0,
      desks: 0,
      threads: 0,
      media: 0,
      people: 0,
      user: 0,
      sessions: 0,
      scratchFile: false,
      key: null,
      verdict: null,
    });
    expect(await audits(partner)).toBe(1);
    expect((await partnerHoldings(partner)).stateRows).toBe(0);
  });

  it("leaves a different partner's company alone, as it always did", async () => {
    const a = await provision(freshPartner(), "a");
    const other = await provision(freshPartner(), "other");
    const before = await holdings(other);

    expect(json(await erase(a)).status).toBe(200);
    expect(await holdings(other)).toEqual(before);
  });

  it("is idempotent at the function: a second pass over an already empty partner still completes", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    await resetTenant(a.tenant, TENANT_ERASE_CONFIRM_WORD);
    // The partner now holds no organisation at all, which is not "more than one".
    await expect(resetTenant(a.tenant, TENANT_ERASE_CONFIRM_WORD)).resolves.toMatchObject({ ok: true });
  });
});

describe("Personal: server mode off", () => {
  it("is refused with the code it always was, even if the tenant row holds two organisations", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    await provision(partner, "b");
    // Read while the hosted store is the one in force; the desk's file backend holds none of this.
    const before = await holdings(a);
    delete process.env.AGENTFORGE_SERVER;

    const result = await send(a, "POST", "/api/v1/settings/reset", { scope: "tenant", confirm: "DELETE" }, false);
    expect(json(result).status).toBe(403);
    expect(errorOf(result).code).toBe("tenant_reset_disabled");
    await expect(resetTenant(a.tenant, TENANT_ERASE_CONFIRM_WORD)).rejects.toMatchObject({
      code: "tenant_reset_disabled",
      status: 403,
    });
    process.env.AGENTFORGE_SERVER = "1";
    expect(await holdings(a)).toEqual(before);
  });
});
