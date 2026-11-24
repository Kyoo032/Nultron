import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  keyFingerprintOrNull,
  TEAM_BOT_CONFIG_KEY,
  type AgentRuntime,
  type PortalRole,
  type TenantContext,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest } from "./types";

/**
 * Security & metering regression tests for the team routes:
 * - Key 108: `POST /api/v1/team/release` enforces `requireOwned` (`canBuild` + creator or `canAdminister`)
 *   before tombstoning a `tb-` team bot.
 * - Key 112: `POST /api/v1/team/propose` enforces `requireGatewayAllowed` (plan entitlement + gateway gate,
 *   never swallowed into the deterministic fallback) and records one usage row to the tenant ledger.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-team-security-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "9d4b7e12a0c63f58e1b2d7a94c0368fe5a1d27b9c40e8f3615ad72be09c4f813";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const swap = vi.hoisted(() => ({ runtime: null as null | { execute: (input: unknown) => Promise<void> } }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (...args: Parameters<typeof actual.createRuntime>) =>
      (swap.runtime as AgentRuntime | null) ?? actual.createRuntime(...args),
  };
});

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const TENANT_ID = "team-sec-tenant";
const ORG_ID = "team-sec-org";

type Person = "owner" | "admin" | "builderA" | "builderB" | "member";

const people = new Map<Person, TenantContext>();
const sessions = new Map<Person, string>();

let dispatch: typeof import("./router").dispatch;
let store: ReturnType<typeof import("./auth/session-store").createMemorySessionStore>;
let secureCookie: string;

async function callAs(
  person: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sessionId = sessions.get(person);
  if (!sessionId) {
    throw new Error(`No session for ${person}`);
  }
  const req: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${secureCookie}=${sessionId}` },
    body,
  };
  const result = await dispatch(req, { serverMode: true, sessionStore: store, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

async function callLocal(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: {},
    body,
  };
  const result = await dispatch(req, { serverMode: false });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

function personTenant(person: Person): TenantContext {
  const tenant = people.get(person);
  if (!tenant) {
    throw new Error(`No tenant for ${person}`);
  }
  return tenant;
}

async function teamBotConfigFlag(organizationId: string, slug: string): Promise<unknown> {
  const { db, DrizzleAgentRepository } = await import("@agentforge/db");
  const repo = new DrizzleAgentRepository(db);
  const owner = personTenant("owner");
  const rows = await repo.listAgents(organizationId, owner.workspaceId);
  const found = rows.find((row) => row.slug === slug);
  if (!found?.currentVersionId) {
    return undefined;
  }
  const version = await repo.findVersionById(organizationId, found.currentVersionId);
  return version?.config?.[TEAM_BOT_CONFIG_KEY];
}

beforeAll(async () => {
  const dbm = await import("@agentforge/db");
  ({ dispatch } = await import("./router"));
  const { createSession, SESSION_COOKIE_SECURE } = await import("./auth/session");
  const { createMemorySessionStore } = await import("./auth/session-store");
  secureCookie = SESSION_COOKIE_SECURE;
  store = createMemorySessionStore();

  const spec: Array<[Person, PortalRole | null, "builder" | null]> = [
    ["owner", "owner", null],
    ["admin", "admin", null],
    ["builderA", "member", "builder"],
    ["builderB", "member", "builder"],
    ["member", "member", null],
  ];
  for (const [person, portalRole, override] of spec) {
    const userId = `usr-${person}`;
    const provisioned = await dbm.ensurePortalOwner(dbm.db, {
      tenantId: TENANT_ID,
      orgId: ORG_ID,
      userId,
      role: portalRole,
    });
    if (override) {
      dbm.sql
        .prepare("UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?")
        .run(override, ORG_ID, userId);
      const resolved = await dbm.resolvePortalTenant(dbm.db, {
        tenantId: TENANT_ID,
        orgId: ORG_ID,
        userId,
      });
      if (!resolved.ok) {
        throw new Error(`Could not resolve ${person}: ${resolved.code}`);
      }
      people.set(person, resolved.tenant);
    } else {
      people.set(person, provisioned);
    }
    const session = createSession({ tenantId: TENANT_ID, orgId: ORG_ID, userId, now: T0 });
    await store.create(session);
    sessions.set(person, session.id);
  }
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  swap.runtime = null;
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_RUNTIME;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Key 108: POST /api/v1/team/release enforces requireOwned", () => {
  it("blocks member and non-creator builder with 403 while allowing creator, admin, and owner", async () => {
    process.env.AGENTFORGE_SERVER = "1";

    // Owner hires a private team bot.
    const ownerHire = await callAs("owner", "POST", "/api/v1/team/hire", {
      bots: [{ name: "Owner Analyst", role: "Reads briefs", prompt: "You help the owner." }],
    });
    expect(ownerHire.status).toBe(200);
    const ownerSlug = (ownerHire.body.bots as Array<{ slug: string }>).find((b) => b.slug === "tb-owner-analyst")?.slug;
    expect(ownerSlug).toBe("tb-owner-analyst");
    expect(await teamBotConfigFlag(ORG_ID, "tb-owner-analyst")).toBe(true);

    // Member cannot release owner's bot -> 403 and config.teamBot stays true.
    const memberRelease = await callAs("member", "POST", "/api/v1/team/release", { bot: "tb-owner-analyst" });
    expect(memberRelease.status).toBe(403);
    expect(memberRelease.body).toMatchObject({ error: { code: "forbidden" } });
    expect(await teamBotConfigFlag(ORG_ID, "tb-owner-analyst")).toBe(true);

    // Non-creator builder cannot release owner's bot -> 403 and config.teamBot stays true.
    const builderRelease = await callAs("builderB", "POST", "/api/v1/team/release", { bot: "tb-owner-analyst" });
    expect(builderRelease.status).toBe(403);
    expect(builderRelease.body).toMatchObject({ error: { code: "forbidden" } });
    expect(await teamBotConfigFlag(ORG_ID, "tb-owner-analyst")).toBe(true);

    // Admin CAN release owner's bot -> 200 and config.teamBot flips to false.
    const adminRelease = await callAs("admin", "POST", "/api/v1/team/release", { bot: "tb-owner-analyst" });
    expect(adminRelease.status).toBe(200);
    expect(await teamBotConfigFlag(ORG_ID, "tb-owner-analyst")).toBe(false);

    // BuilderA creates two bots: builderB cannot release them, creator (builderA) can release one,
    // and owner can release the other.
    const builderHire = await callAs("builderA", "POST", "/api/v1/team/hire", {
      bots: [
        { name: "Builder Self", role: "Helper A", prompt: "Prompt A." },
        { name: "Builder Owned", role: "Helper B", prompt: "Prompt B." },
      ],
    });
    expect(builderHire.status).toBe(200);
    expect(await teamBotConfigFlag(ORG_ID, "tb-builder-self")).toBe(true);
    expect(await teamBotConfigFlag(ORG_ID, "tb-builder-owned")).toBe(true);

    const otherBuilderDenied = await callAs("builderB", "POST", "/api/v1/team/release", { bot: "tb-builder-self" });
    expect(otherBuilderDenied.status).toBe(403);
    expect(await teamBotConfigFlag(ORG_ID, "tb-builder-self")).toBe(true);

    const creatorRelease = await callAs("builderA", "POST", "/api/v1/team/release", { bot: "tb-builder-self" });
    expect(creatorRelease.status).toBe(200);
    expect(await teamBotConfigFlag(ORG_ID, "tb-builder-self")).toBe(false);

    const ownerReleaseOther = await callAs("owner", "POST", "/api/v1/team/release", { bot: "tb-builder-owned" });
    expect(ownerReleaseOther.status).toBe(200);
    expect(await teamBotConfigFlag(ORG_ID, "tb-builder-owned")).toBe(false);
  });

  it("keeps the local-owner desk path unchanged off server mode", async () => {
    delete process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_RUNTIME = "stub";

    const hire = await callLocal("POST", "/api/v1/team/hire", {
      bots: [{ name: "Local Helper", role: "Local role", prompt: "Local prompt." }],
    });
    expect(hire.status).toBe(200);

    const release = await callLocal("POST", "/api/v1/team/release", { bot: "tb-local-helper" });
    expect(release.status).toBe(200);
    expect((release.body.bots as Array<{ slug: string }>).some((b) => b.slug === "tb-local-helper")).toBe(false);
  });
});

describe("Key 112: POST /api/v1/team/propose enforces gateway gate and records usage", () => {
  async function seedVerifiedKey(tenant: TenantContext, key: string): Promise<void> {
    const { saveSettings } = await import("./settings-store");
    const { saveGateState } = await import("./gateway-gate");
    saveSettings({ openaiApiKey: key }, tenant);
    const nowIso = new Date().toISOString();
    saveGateState(
      tenant.tenantId,
      {
        version: 1,
        fingerprint: keyFingerprintOrNull(key),
        status: "ok",
        checkedAt: nowIso,
        lastOkAt: nowIso,
      },
      process.env.AGENTFORGE_SERVER === "1" ? tenant.organizationId : null,
    );
  }

  it("refuses a needs_key tenant in server mode with 403 gateway_blocked and zero gateway calls", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const calls: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        calls.push(input as ExecuteInput);
      },
    };

    const res = await callAs("owner", "POST", "/api/v1/team/propose", {
      brief: "Build a research and documents team for weekly reports",
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "gateway_blocked", status: "needs_key" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a plan-blocked tenant in server mode with 403 and zero gateway calls", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const owner = personTenant("owner");
    await seedVerifiedKey(owner, "sk-team-propose-verified-key-0001");

    const { savePlanRecord } = await import("./entitlement-store");
    savePlanRecord({
      tenantId: TENANT_ID,
      kind: "personal",
      status: "past_due",
      allowanceUsdMicros: 5_000_000,
      spentUsdMicros: 0,
      unpricedCount: 0,
      periodStart: T0 - 86_400_000,
      periodEnd: T0 + 29 * 86_400_000,
      seatCap: 5,
      marginMultipleMicros: 1_000_000,
      currency: "USD",
      updatedAt: T0,
    });

    const calls: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        calls.push(input as ExecuteInput);
      },
    };

    const res = await callAs("owner", "POST", "/api/v1/team/propose", {
      brief: "Need finance and market briefings",
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);

    // Restore active plan for subsequent tests.
    savePlanRecord({
      tenantId: TENANT_ID,
      kind: "personal",
      status: "active",
      allowanceUsdMicros: null,
      spentUsdMicros: 0,
      unpricedCount: 0,
      periodStart: T0 - 86_400_000,
      periodEnd: T0 + 29 * 86_400_000,
      seatCap: 5,
      marginMultipleMicros: 1_000_000,
      currency: "USD",
      updatedAt: T0 + 1,
    });
  });

  it("records one usage row to the tenant ledger for an allowed tenant and falls back cleanly on model failure", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const owner = personTenant("owner");
    await seedVerifiedKey(owner, "sk-team-propose-verified-key-0001");

    const { listTenantUsage } = await import("./tenant-usage");
    const beforeCount = listTenantUsage(owner).length;

    const calls: ExecuteInput[] = [];
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        calls.push(run);
        await run.onEvent({
          type: "assistant.delta",
          text: JSON.stringify({
            modes: ["research", "documents"],
            bots: [{ name: "Brief Editor", role: "Polishes briefs", prompt: "You polish weekly briefs." }],
          }),
        });
        await run.onEvent({
          type: "run.completed",
          runId: run.runId,
          usage: { model: run.version.model, inputTokens: 120, outputTokens: 85 },
        });
      },
    };

    const okRes = await callAs("owner", "POST", "/api/v1/team/propose", {
      brief: "Research competitors and draft weekly briefs",
    });
    expect(okRes.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(okRes.body).toMatchObject({
      brief: "Research competitors and draft weekly briefs",
      modes: expect.arrayContaining(["research", "documents"]),
      bots: [{ name: "Brief Editor", role: "Polishes briefs", prompt: "You polish weekly briefs." }],
    });
    expect(okRes.body.modes).toHaveLength(2);

    const afterRows = listTenantUsage(owner);
    expect(afterRows.length).toBe(beforeCount + 1);
    const newest = afterRows[0];
    expect(newest?.mode).toBe("chat");
    expect(newest?.inputTokens).toBe(120);
    expect(newest?.outputTokens).toBe(85);
    expect(newest?.quantity).toBe(205);
    expect(newest?.runId).toMatch(/^team-propose-/);

    // Model throws (timeout / transport error) -> still falls back to deterministic proposal.
    swap.runtime = {
      async execute() {
        throw new Error("simulated gateway timeout");
      },
    };
    const failRes = await callAs("owner", "POST", "/api/v1/team/propose", {
      brief: "Research tide tables and write a report",
    });
    expect(failRes.status).toBe(200);
    expect((failRes.body.modes as string[]).length).toBeGreaterThan(0);
    expect((failRes.body.bots as unknown[]).length).toBeGreaterThan(0);

    // Model replies with prose (unparseable JSON) -> falls back to deterministic proposal AND records usage.
    const beforeProse = listTenantUsage(owner).length;
    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        await run.onEvent({ type: "assistant.delta", text: "Sure! Here are some ideas without JSON." });
        await run.onEvent({
          type: "run.completed",
          runId: run.runId,
          usage: { model: run.version.model, inputTokens: 50, outputTokens: 20 },
        });
      },
    };
    const proseRes = await callAs("owner", "POST", "/api/v1/team/propose", {
      brief: "Help with legal contracts and finance",
    });
    expect(proseRes.status).toBe(200);
    expect((proseRes.body.modes as string[]).length).toBeGreaterThan(0);
    expect(listTenantUsage(owner).length).toBe(beforeProse + 1);
  });

  it("behaves as today in desk (non-server) mode with a verified key", async () => {
    delete process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_RUNTIME;
    const { getTenant } = await import("./tenant");
    const localTenant = await getTenant();
    await seedVerifiedKey(localTenant, "sk-local-desk-verified-key-0001");

    const { listTenantUsage } = await import("./tenant-usage");
    const before = listTenantUsage(localTenant).length;

    swap.runtime = {
      async execute(input) {
        const run = input as ExecuteInput;
        await run.onEvent({
          type: "assistant.delta",
          text: JSON.stringify({
            modes: ["finance"],
            bots: [{ name: "Desk CFO", role: "Tracks cash", prompt: "Track cash flow." }],
          }),
        });
        await run.onEvent({
          type: "run.completed",
          runId: run.runId,
          usage: { model: run.version.model, inputTokens: 60, outputTokens: 40 },
        });
      },
    };

    const res = await callLocal("POST", "/api/v1/team/propose", { brief: "Track company cash flow" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      modes: ["finance"],
      bots: [{ name: "Desk CFO" }],
    });
    expect(listTenantUsage(localTenant).length).toBe(before + 1);
  });
});
