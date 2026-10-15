import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalRole, TenantContext } from "@agentforge/core";
import { pinnedGatewayOrigin } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { GatewayAdminRecord } from "./admin-record";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-gateway-adapter-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

const TENANT_ID = "tenant-gateway-adapter";
const ORG_A = "org-gateway-adapter-a";
const ORG_B = "org-gateway-adapter-b";
const ORG_C = "org-gateway-adapter-c";
const TOKEN = "mgmt-tok-7Kq2Xa9LpR4tZ8wY";
const KEY_NEVER_STORED = "sk-SHOULD-NOT-LEAK-zzzz9999";
const SERVER = { isServerMode: () => true };
const PERSONAL = { isServerMode: () => false };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: unknown };

function gateway(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, message: "", data }), { status: 200 });
}

let db: typeof import("@agentforge/db");
let adapterModule: typeof import("./adapter");
let settings: typeof import("../settings-store");
const people = new Map<string, TenantContext>();

function tenantFor(name: string): TenantContext {
  const tenant = people.get(name);
  if (!tenant) {
    throw new Error(`${name} was not provisioned`);
  }
  return tenant;
}

function rows(): Array<{ organization_id: string; gateway_token_id: string; name: string }> {
  return db.sql
    .prepare("SELECT organization_id, gateway_token_id, name FROM gateway_managed_tokens ORDER BY gateway_token_id")
    .all() as Array<{ organization_id: string; gateway_token_id: string; name: string }>;
}

function seedRow(orgId: string, id: string, name: string): void {
  db.sql
    .prepare(
      "INSERT INTO gateway_managed_tokens (organization_id, gateway_token_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(orgId, id, name, 1);
}

function fields(overrides: Partial<import("./adapter").GatewayTokenFields> = {}) {
  return {
    name: "Team A",
    remainQuota: 500000,
    unlimitedQuota: false,
    expiredTime: -1,
    ...overrides,
  };
}

async function failure(run: () => Promise<unknown>): Promise<{ code?: string; status?: number; message: string }> {
  try {
    await run();
  } catch (error) {
    const err = error as { code?: string; status?: number; message?: string };
    return { code: err.code, status: err.status, message: String(err.message ?? error) };
  }
  throw new Error("expected the call to be refused");
}

beforeAll(async () => {
  db = await import("@agentforge/db");
  adapterModule = await import("./adapter");
  settings = await import("../settings-store");
  const roles: Array<[string, PortalRole, string]> = [
    ["ownerA", "owner", ORG_A],
    ["adminA", "admin", ORG_A],
    ["memberA", "member", ORG_A],
    ["ownerB", "owner", ORG_B],
    ["ownerC", "owner", ORG_C],
  ];
  for (const [name, role, orgId] of roles) {
    people.set(name, await db.ensurePortalOwner(db.db, { tenantId: TENANT_ID, orgId, userId: `usr-${name}`, role }));
  }
  const record: GatewayAdminRecord = { token: TOKEN, accountId: 9, checkedAt: 1, status: "ok" };
  settings.saveCompanyGatewayAdmin(tenantFor("ownerA"), record);
  settings.saveCompanyGatewayAdmin(tenantFor("ownerB"), { ...record, token: "mgmt-tok-B-2Hn5Vc8WqZ3sJ6pD" });
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  db.sql.prepare("DELETE FROM gateway_managed_tokens").run();
});

afterAll(() => {
  db.sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("creating a token", () => {
  it("posts to the pinned origin with the documented field names, and records only the id", async () => {
    const { fetch, calls } = gateway(() => ok({ id: 41, name: "Team A", key: KEY_NEVER_STORED }));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });

    const created = await adapter.createToken(fields({ modelLimits: "gpt-4o", allowIps: "" }));

    expect(created).toEqual({ id: "41", name: "Team A" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${pinnedGatewayOrigin()}/api/token/`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].redirect).toBe("manual");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers["New-Api-User"]).toBe("9");
    expect(calls[0].body).toEqual({
      name: "Team A",
      remain_quota: 500000,
      unlimited_quota: false,
      expired_time: -1,
      model_limits_enabled: true,
      model_limits: "gpt-4o",
      allow_ips: "",
    });
    expect(rows()).toEqual([{ organization_id: ORG_A, gateway_token_id: "41", name: "Team A" }]);
    expect(JSON.stringify(created)).not.toContain(KEY_NEVER_STORED);
    expect(JSON.stringify(rows())).not.toContain(KEY_NEVER_STORED);
  });

  it("lets an admin create, refuses a member, and refuses a company that has no token saved", async () => {
    const { fetch, calls } = gateway(() => ok({ id: 42 }));
    const adminAdapter = adapterModule.gatewayTokenAdapter(tenantFor("adminA"), { fetch, ...SERVER });
    expect((await adminAdapter.createToken(fields())).id).toBe("42");

    const memberAdapter = adapterModule.gatewayTokenAdapter(tenantFor("memberA"), { fetch, ...SERVER });
    expect((await failure(() => memberAdapter.createToken(fields()))).status).toBe(403);

    const unconfigured = adapterModule.gatewayTokenAdapter(tenantFor("ownerC"), { fetch, ...SERVER });
    expect((await failure(() => unconfigured.createToken(fields()))).code).toBe("gateway_admin_not_configured");

    expect(calls).toHaveLength(1);
  });

  it("records nothing when the gateway does not confirm an id", async () => {
    const { fetch } = gateway(() => ok({}));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    const refused = await failure(() => adapter.createToken(fields()));
    expect(refused.code).toBe("gateway_token_unconfirmed");
    expect(rows()).toEqual([]);
  });

  it("refuses bad fields before anything is sent", async () => {
    const { fetch, calls } = gateway(() => ok({ id: 50 }));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    const bad: Array<Partial<import("./adapter").GatewayTokenFields>> = [
      { remainQuota: 1.5 },
      { name: "" },
      { name: "x".repeat(101) },
      { expiredTime: 0 },
      { unlimitedQuota: "yes" as unknown as boolean },
      { modelLimits: 7 as unknown as string },
    ];
    for (const overrides of bad) {
      expect((await failure(() => adapter.createToken(fields(overrides)))).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(rows()).toEqual([]);
  });
});

describe("changing and deleting only what this platform created", () => {
  it("updates a token it created and renames the local row", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(() => ok({}));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });

    expect(await adapter.updateToken("41", fields({ name: "Team A renamed" }))).toEqual({ id: "41" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(`${pinnedGatewayOrigin()}/api/token/`);
    expect(calls[0].body).toMatchObject({ id: 41, name: "Team A renamed", remain_quota: 500000 });
    expect(rows()[0].name).toBe("Team A renamed");
  });

  it("refuses an id it did not create, before any call, and another company's id too", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(() => ok({}));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    const other = adapterModule.gatewayTokenAdapter(tenantFor("ownerB"), { fetch, ...SERVER });

    expect((await failure(() => adapter.updateToken("999", fields()))).status).toBe(404);
    expect((await failure(() => other.updateToken("41", fields()))).status).toBe(404);
    expect((await failure(() => other.deleteTokens(["41"]))).status).toBe(404);
    expect((await failure(() => other.tokenUsage("41"))).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(rows()).toEqual([{ organization_id: ORG_A, gateway_token_id: "41", name: "Team A" }]);
  });

  it("deletes in one batch after de-duplicating, and removes the local rows", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(() => ok(null));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });

    expect(await adapter.deleteTokens(["41", "41", 41])).toEqual({ deleted: ["41"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${pinnedGatewayOrigin()}/api/token/batch`);
    expect(calls[0].body).toEqual({ ids: [41] });
    expect(rows()).toEqual([]);
  });

  it("is all or nothing: one unmanaged id stops the whole batch", async () => {
    seedRow(ORG_A, "42", "Team B");
    const { fetch, calls } = gateway(() => ok(null));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });

    expect((await failure(() => adapter.deleteTokens(["42", "999"]))).code).toBe("gateway_token_not_managed");
    expect(calls).toHaveLength(0);
    expect(rows()).toEqual([{ organization_id: ORG_A, gateway_token_id: "42", name: "Team B" }]);
  });

  it("refuses an empty batch and an oversized one", async () => {
    const { fetch, calls } = gateway(() => ok(null));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    expect((await failure(() => adapter.deleteTokens([]))).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_value, index) => String(index + 1));
    expect((await failure(() => adapter.deleteTokens(tooMany))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("keeps the local rows when the gateway refuses the batch", async () => {
    seedRow(ORG_A, "43", "Team C");
    const { fetch } = gateway(() => new Response("{}", { status: 500 }));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    expect((await failure(() => adapter.deleteTokens(["43"]))).code).toBe("gateway_rejected");
    expect(rows()).toEqual([{ organization_id: ORG_A, gateway_token_id: "43", name: "Team C" }]);
  });
});

describe("usage and the gateway's answers", () => {
  it("asks for usage by token id", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(() => ok({ used_quota: 120 }));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    expect(await adapter.tokenUsage("41")).toEqual({ id: "41", usage: { used_quota: 120 } });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${pinnedGatewayOrigin()}/api/usage/token/?token_id=41`);
  });

  it("refuses a redirect and does not follow it", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(
      () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/" } }),
    );
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    expect((await failure(() => adapter.tokenUsage("41"))).code).toBe("gateway_redirect_refused");
    expect(calls).toHaveLength(1);
  });

  it("answers a timeout or a dropped connection as a clean refusal", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch } = gateway(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    expect((await failure(() => adapter.tokenUsage("41"))).code).toBe("gateway_unreachable");
  });

  it("answers 404 to every method off server mode and sends nothing", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch, calls } = gateway(() => ok({}));
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...PERSONAL });
    const attempts = [
      () => adapter.createToken(fields()),
      () => adapter.updateToken("41", fields()),
      () => adapter.deleteTokens(["41"]),
      () => adapter.tokenUsage("41"),
    ];
    for (const attempt of attempts) {
      expect((await failure(attempt)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("never puts the management token or a gateway key into an error", async () => {
    seedRow(ORG_A, "41", "Team A");
    const { fetch } = gateway(
      () => new Response(JSON.stringify({ success: false, key: KEY_NEVER_STORED }), { status: 500 }),
    );
    const adapter = adapterModule.gatewayTokenAdapter(tenantFor("ownerA"), { fetch, ...SERVER });
    const messages = [
      (await failure(() => adapter.tokenUsage("41"))).message,
      (await failure(() => adapter.deleteTokens(["41"]))).message,
      (await failure(() => adapter.updateToken("41", fields({ name: "" })))).message,
    ];
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(KEY_NEVER_STORED);
    }
  });
});
