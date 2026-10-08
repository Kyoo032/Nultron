/**
 * SR-163, review round: a hosted company reads its own usage, not the partner's.
 *
 * Every `tenant_usage` row carries an `organization_id`, but the readers filtered by `tenant_id` alone, and
 * on the server `tenantId` is the white-label partner every company of a deployment sits under. So company
 * A's Usage page (`GET /api/v1/usage`) and the `usage` field of every `GET /api/v1/settings` listed company
 * B's models, token counts and cost. (`runs.usage`, the other half of that page, was always read by
 * organisation.)
 *
 * Real router, real sessions, real database and a throwaway data dir. Ledger rows are written through the
 * repository the app uses; the gateway is a stand-in that serves a price list and answers everything else
 * with a 500, so the pages list token counts per model, which is all this needs.
 *
 * The desk is pinned too: with server mode off the readers are partner-wide, exactly as they were.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext, UsageEvent } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-usage-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "3e7a9c1b5d2f4806b4a8d0c2e6f19375a1c7e3b9d5f20846c8a0e2b4d6f18a53";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;

import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostResult } from "./types";

const { dispatch } = await import("./router");
const { usageStore, createUsageStore, listTenantUsage, tenantUsageTotals } = await import("./tenant-usage");
const { loadLocalAccountUsage } = await import("./account-usage");

const T0 = Date.now();

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let seq = 0;

type Company = { readonly tenant: TenantContext; readonly session: ReturnType<typeof createSession> };

async function provision(partner: string, label: string): Promise<Company> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  seq += 1;
  const identity = { tenantId: partner, orgId: `usage-org-${label}-${seq}`, userId: `usage-user-${label}-${seq}` };
  const tenant = await ensurePortalOwner(db, { ...identity, role: "owner" });
  const session = createSession({ ...identity, now: T0 });
  await sessionStore.create(session);
  return { tenant, session };
}

const freshPartner = (): string => {
  seq += 1;
  return `usage-partner-${seq}`;
};

async function get<T = Record<string, unknown>>(company: Company, path: string): Promise<T> {
  const result: HostResult = await dispatch(
    {
      method: "GET",
      path,
      query: Object.fromEntries(new URL(`http://x${path}`).searchParams),
      params: {},
      headers: { cookie: `${SESSION_COOKIE_SECURE}=${company.session.id}` },
    },
    { serverMode: true, sessionStore, now: () => T0 },
  );
  if (result.type !== "json") {
    throw new Error(`expected json from ${path}, got ${result.type}`);
  }
  return ((result as HostJsonResult).body ?? {}) as T;
}

function event(model: string, inputTokens: number, outputTokens: number, costUsdMicros = 1_000): UsageEvent {
  return {
    mode: "documents",
    model,
    unit: "tokens",
    quantity: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    costUsdMicros,
  };
}

type DeskUsage = { desk: { byModel: Array<{ model: string; inputTokens: number; outputTokens: number }> } };

const modelsOf = (usage: DeskUsage): string[] => usage.desk.byModel.map((row) => row.model).sort();

beforeAll(async () => {
  sessionStore = createMemorySessionStore();
  // Everything is a 500 except the price list, which `GET /api/v1/settings` needs before it will list any
  // model (a failed price fetch empties that page's `byModel`, which is not what these cases are about).
  vi.stubGlobal("fetch", async (url: unknown) => {
    if (String(url).endsWith("/api/pricing")) {
      return new Response(
        JSON.stringify({ data: ["settings-model-a", "settings-model-b"].map((model_name) => ({ model_name })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 500 });
  });
  await import("@agentforge/db");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("two companies under one partner: each sees only its own usage", () => {
  it("GET /api/v1/usage lists the caller's models and token counts, never the other company's", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    usageStore().record(a.tenant, event("model-of-a", 100, 40));
    usageStore().record(b.tenant, event("model-of-b", 7_000, 3_000, 9_999_000));

    const seenByA = await get<DeskUsage>(a, "/api/v1/usage");
    const seenByB = await get<DeskUsage>(b, "/api/v1/usage");

    expect(modelsOf(seenByA)).toEqual(["model-of-a"]);
    expect(modelsOf(seenByB)).toEqual(["model-of-b"]);
    expect(seenByA.desk.byModel[0]).toMatchObject({ inputTokens: 100, outputTokens: 40 });
    expect(seenByB.desk.byModel[0]).toMatchObject({ inputTokens: 7_000, outputTokens: 3_000 });
  });

  it("the usage field of GET /api/v1/settings is the caller's too", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    usageStore().record(a.tenant, event("settings-model-a", 11, 4));
    usageStore().record(b.tenant, event("settings-model-b", 22, 8));

    const seenByA = await get<{ usage: DeskUsage }>(a, "/api/v1/settings");
    const seenByB = await get<{ usage: DeskUsage }>(b, "/api/v1/settings");

    expect(modelsOf(seenByA.usage)).toEqual(["settings-model-a"]);
    expect(modelsOf(seenByB.usage)).toEqual(["settings-model-b"]);
  });

  it("a company with no usage sees none of the partner's", async () => {
    const partner = freshPartner();
    const busy = await provision(partner, "busy");
    const quiet = await provision(partner, "quiet");
    usageStore().record(busy.tenant, event("busy-model", 500, 500));

    const seen = await get<DeskUsage>(quiet, "/api/v1/usage");

    expect(seen.desk.byModel).toEqual([]);
  });

  it("the repository's list and totals are the company's: rows, tokens and cost", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    usageStore().record(a.tenant, event("model-of-a", 100, 40, 2_500));
    usageStore().record(b.tenant, event("model-of-b", 1, 1, 9_999_999));

    expect(listTenantUsage(a.tenant).map((row) => row.model)).toEqual(["model-of-a"]);
    expect(listTenantUsage(b.tenant).map((row) => row.model)).toEqual(["model-of-b"]);
    expect(tenantUsageTotals(a.tenant).costUsdMicros).toBe(2_500);
    expect(tenantUsageTotals(b.tenant).costUsdMicros).toBe(9_999_999);
  });

  it("does not show a partner-wide legacy desk-usage.json to any company", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const root = join(dataDir, "tenants", partner);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "desk-usage.json"),
      `${JSON.stringify({ entries: [{ model: "legacy-model", inputTokens: 5, outputTokens: 5, at: new Date().toISOString() }] })}\n`,
    );

    expect((await loadLocalAccountUsage({}, a.tenant)).desk.unknownCount).toBe(0);
    expect(modelsOf(await get<DeskUsage>(a, "/api/v1/usage"))).toEqual([]);
  });
});

describe("two partners with one company each: the topology every earlier test used", () => {
  it("keeps each partner's usage on its own page", async () => {
    const a = await provision(freshPartner(), "a");
    const b = await provision(freshPartner(), "b");
    usageStore().record(a.tenant, event("solo-a", 10, 10));
    usageStore().record(b.tenant, event("solo-b", 20, 20));

    expect(modelsOf(await get<DeskUsage>(a, "/api/v1/usage"))).toEqual(["solo-a"]);
    expect(modelsOf(await get<DeskUsage>(b, "/api/v1/usage"))).toEqual(["solo-b"]);
  });
});

describe("Personal: server mode off, the readers are exactly what they were", () => {
  const LOCAL = "local-tenant";
  const desk = (organizationId: string): TenantContext => ({
    tenantId: LOCAL,
    organizationId,
    workspaceId: "home",
    userId: "local-owner",
    role: "owner",
  });

  beforeEach(() => {
    delete process.env.AGENTFORGE_SERVER;
  });

  it("reads by tenant alone: two organisations of the same tenant share one ledger view", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    const store = createUsageStore(db);
    store.record(desk("org-one"), event("m1", 10, 10, 1_000));
    store.record(desk("org-two"), event("m2", 20, 20, 2_000));

    expect(
      store
        .list(desk("org-one"))
        .map((row) => row.model)
        .sort(),
    ).toEqual(["m1", "m2"]);
    expect(store.totals(desk("org-one")).costUsdMicros).toBe(3_000);
    db.close();
  });

  it("still reads the legacy desk-usage.json, which a desktop that generated before the ledger relies on", async () => {
    writeFileSync(
      join(dataDir, "desk-usage.json"),
      `${JSON.stringify({ entries: [{ model: "legacy-a", inputTokens: 5, outputTokens: 5 }, { model: "legacy-b", inputTokens: 1, outputTokens: 1 }] })}\n`,
    );
    try {
      expect((await loadLocalAccountUsage({}, desk("no-such-org"))).desk.unknownCount).toBe(2);
    } finally {
      rmSync(join(dataDir, "desk-usage.json"), { force: true });
    }
  });
});

describe("the hosted store, built directly", () => {
  it("filters by organisation only when told it is the hosted server", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    const partner: Pick<TenantContext, "tenantId" | "workspaceId" | "userId" | "role"> = {
      tenantId: "local-tenant",
      workspaceId: "w",
      userId: "u",
      role: "owner",
    };
    const a: TenantContext = { ...partner, organizationId: "org-a" };
    const b: TenantContext = { ...partner, organizationId: "org-b" };

    const hosted = createUsageStore(db, { isServerMode: () => true });
    const desk = createUsageStore(db, { isServerMode: () => false });
    hosted.record(a, event("m-a", 1, 1, 100));
    hosted.record(b, event("m-b", 1, 1, 200));

    expect(hosted.list(a).map((row) => row.model)).toEqual(["m-a"]);
    expect(hosted.totals(b).costUsdMicros).toBe(200);
    expect(desk.list(a)).toHaveLength(2);
    expect(desk.totals(a).costUsdMicros).toBe(300);
    db.close();
  });
});
