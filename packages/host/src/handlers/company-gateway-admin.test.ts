import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MembershipRole, PortalRole, TenantContext } from "@agentforge/core";
import { pinnedGatewayOrigin, redactSecrets } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-company-gateway-admin-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const TENANT_ID = "tenant-company-gateway-admin";
const ORG_A = "org-company-gateway-admin-a";
const ORG_B = "org-company-gateway-admin-b";
const TOKEN = "mgmt-tok-7Kq2Xa9LpR4tZ8wY";
const OTHER_TOKEN = "mgmt-tok-B-2Hn5Vc8WqZ3sJ6pD";
const KEY = "sk-company-gateway-admin-00000000000";
const HOSTED = { isServerMode: () => true, now: () => 1_000 };
const DESK = { isServerMode: () => false };

type Person = "owner" | "admin" | "member" | "builder" | "ownerB";
type Deps = { isServerMode?: () => boolean; fetch?: typeof fetch; now?: () => number };
type Answer = { status: number; body: Record<string, unknown> };

const people = new Map<Person, TenantContext>();
const realFetch = globalThis.fetch;
let handlers: typeof import("./company-gateway-admin");
let settingsHandlers: typeof import("./settings");
let store: typeof import("../settings-store");
let sqlHandle: typeof import("@agentforge/db").sql;
let logged: string[] = [];

function tenantOf(person: Person): TenantContext {
  const tenant = people.get(person);
  if (!tenant) {
    throw new Error(`${person} was not provisioned`);
  }
  return tenant;
}

function as(person: Person, method: string, path: string, body?: unknown): HostRequest {
  const tenant = tenantOf(person);
  return {
    method,
    path,
    query: {},
    params: {},
    headers: {},
    body,
    session: {
      id: `session-${person}`,
      tenantId: tenant.tenantId,
      orgId: tenant.organizationId,
      userId: tenant.userId,
    },
  };
}

function answer(result: HostResult): Answer {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

function serialised(answerValue: Answer): string {
  return JSON.stringify(answerValue.body);
}

function fakeGateway(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return respond();
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function ok(): Response {
  return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
}

async function get(person: Person, deps: Deps = HOSTED): Promise<Answer> {
  return answer(await handlers.handleGetCompanyGatewayAdmin(as(person, "GET", "/api/v1/company/gateway-admin"), deps));
}

async function put(person: Person, body: unknown, deps: Deps = HOSTED): Promise<Answer> {
  return answer(
    await handlers.handlePutCompanyGatewayAdmin(as(person, "PUT", "/api/v1/company/gateway-admin", body), deps),
  );
}

async function remove(person: Person, deps: Deps = HOSTED): Promise<Answer> {
  return answer(
    await handlers.handleDeleteCompanyGatewayAdmin(as(person, "DELETE", "/api/v1/company/gateway-admin"), deps),
  );
}

function errorCode(response: Answer): string | undefined {
  return (response.body.error as { code?: string } | undefined)?.code;
}

function captureLogs(): void {
  logged = [];
  for (const level of ["debug", "info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
}

beforeAll(async () => {
  const dbModule = await import("@agentforge/db");
  sqlHandle = dbModule.sql;
  handlers = await import("./company-gateway-admin");
  settingsHandlers = await import("./settings");
  store = await import("../settings-store");

  const roles: Array<[Person, PortalRole, string]> = [
    ["owner", "owner", ORG_A],
    ["admin", "admin", ORG_A],
    ["member", "member", ORG_A],
    ["builder", "member", ORG_A],
    ["ownerB", "owner", ORG_B],
  ];
  for (const [person, role, orgId] of roles) {
    people.set(
      person,
      await dbModule.ensurePortalOwner(dbModule.db, { tenantId: TENANT_ID, orgId, userId: `usr-${person}`, role }),
    );
  }
  dbModule.sql
    .prepare("UPDATE organization_members SET role = 'builder' WHERE organization_id = ? AND user_id = ?")
    .run(ORG_A, "usr-builder");
  const resolved = await dbModule.resolvePortalTenant(dbModule.db, {
    tenantId: TENANT_ID,
    orgId: ORG_A,
    userId: "usr-builder",
  });
  if (!resolved.ok) {
    throw new Error(`builder did not resolve: ${resolved.code}`);
  }
  people.set("builder", resolved.tenant);
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  for (const tenant of people.values()) {
    store.clearCompanyGatewayAdmin(tenant);
  }
});

afterAll(() => {
  sqlHandle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the fixture is what it says", () => {
  it("the token is a value redaction leaves alone, so the leak checks below cannot pass by accident", () => {
    expect(redactSecrets(TOKEN)).toBe(TOKEN);
    expect(redactSecrets(OTHER_TOKEN)).toBe(OTHER_TOKEN);
  });

  it("resolves the four roles, and the builder is a host role the portal does not send", () => {
    const roles = (["owner", "admin", "member", "builder"] as const).map((person) => people.get(person)?.role);
    expect(roles).toEqual<MembershipRole[]>(["owner", "admin", "member", "builder"]);
    expect(people.get("ownerB")?.organizationId).toBe(ORG_B);
    expect(new Set([...people.values()].map((tenant) => tenant.tenantId))).toEqual(new Set([TENANT_ID]));
  });
});

describe("off server mode, the Personal app has no such route", () => {
  it("answers 404 to read, write and clear, and never calls the gateway", async () => {
    const gateway = fakeGateway(ok);
    const deps: Deps = { ...DESK, fetch: gateway.fetch };
    expect((await get("owner", deps)).status).toBe(404);
    expect((await put("owner", { token: TOKEN }, deps)).status).toBe(404);
    expect((await remove("owner", deps)).status).toBe(404);
    expect(gateway.calls).toHaveLength(0);
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))).toBeNull();
  });
});

describe("who may read and who may write, hosted", () => {
  it("lets an admin read the status and never change it, and refuses a member and a builder", async () => {
    expect((await get("admin")).status).toBe(200);
    expect((await get("member")).status).toBe(403);
    expect((await get("builder")).status).toBe(403);

    const gateway = fakeGateway(ok);
    for (const person of ["admin", "member", "builder"] as const) {
      const refused = await put(person, { token: TOKEN }, { ...HOSTED, fetch: gateway.fetch });
      expect(refused.status, person).toBe(403);
      expect(errorCode(refused), person).toBe("gateway_admin_forbidden");
      expect((await remove(person)).status, person).toBe(403);
    }
    expect(gateway.calls).toHaveLength(0);
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))).toBeNull();
  });
});

describe("the owner saves a token and the check answers", () => {
  it("saves it, runs one check on the pinned origin, and answers the four fields with no token", async () => {
    const gateway = fakeGateway(ok);
    const response = await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: true, accountIdSet: true, checkedAt: 1_000, status: "ok" });
    expect(gateway.calls).toEqual([`${pinnedGatewayOrigin()}/api/token/?p=1&page_size=1`]);
    expect(serialised(response)).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("reads the stored record back, through the GET, with no token in it", async () => {
    const gateway = fakeGateway(ok);
    await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });
    const read = await get("owner");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ configured: true, accountIdSet: true, checkedAt: 1_000, status: "ok" });
    expect(serialised(read)).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("omits the account id header when no account id is set", async () => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      return ok();
    }) as unknown as typeof fetch;
    const response = await put("owner", { token: TOKEN }, { ...HOSTED, fetch: fetchFn });
    expect(response.body).toMatchObject({ configured: true, accountIdSet: false, status: "ok" });
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["New-Api-User"]).toBeUndefined();
  });

  it("records each check outcome, and a refused or unreachable gateway is saved and reported, not rejected", async () => {
    const outcomes: Array<[string, () => Response | Promise<Response>, string]> = [
      ["a 401", () => new Response("{}", { status: 401 }), "invalid"],
      ["success false", () => new Response(JSON.stringify({ success: false }), { status: 200 }), "invalid"],
      [
        "a redirect",
        () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
        "unreachable",
      ],
      ["a 503", () => new Response("{}", { status: 503 }), "unreachable"],
    ];
    for (const [label, respond, expected] of outcomes) {
      const gateway = fakeGateway(respond);
      const response = await put("owner", { token: TOKEN }, { ...HOSTED, fetch: gateway.fetch });
      expect(response.status, label).toBe(200);
      expect(response.body.status, label).toBe(expected);
      expect(gateway.calls, label).toHaveLength(1);
      expect((await get("owner")).body.status, label).toBe(expected);
    }
  });

  it("answers unreachable when the gateway cannot be reached at all", async () => {
    const fetchFn = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const response = await put("owner", { token: TOKEN }, { ...HOSTED, fetch: fetchFn });
    expect(response.body.status).toBe("unreachable");
  });

  it("refuses a malformed token or account id before any call", async () => {
    const gateway = fakeGateway(ok);
    const deps = { ...HOSTED, fetch: gateway.fetch };
    expect((await put("owner", { token: "has a space" }, deps)).status).toBe(400);
    expect((await put("owner", { token: "line\nbreak" }, deps)).status).toBe(400);
    expect((await put("owner", { token: "" }, deps)).status).toBe(400);
    expect((await put("owner", { token: "x".repeat(513) }, deps)).status).toBe(400);
    expect((await put("owner", { token: TOKEN, accountId: 0 }, deps)).status).toBe(400);
    expect((await put("owner", { token: TOKEN, accountId: "abc" }, deps)).status).toBe(400);
    expect((await put("owner", { token: TOKEN, accountId: 1.5 }, deps)).status).toBe(400);
    expect(gateway.calls).toHaveLength(0);
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))).toBeNull();
  });

  it("clears it on DELETE, for the owner only", async () => {
    const gateway = fakeGateway(ok);
    await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });
    expect((await remove("owner")).body).toEqual({
      configured: false,
      accountIdSet: false,
      checkedAt: null,
      status: "unchecked",
    });
    expect((await get("owner")).body.configured).toBe(false);
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))).toBeNull();
  });
});

describe("the token survives every other save of the same envelope", () => {
  it("is still there after a member saves a language and the owner saves the company key", async () => {
    const gateway = fakeGateway(ok);
    await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });

    const localeSave = await settingsHandlers.handlePostSettings(
      as("member", "POST", "/api/v1/settings", { locale: "id" }),
      HOSTED,
    );
    expect(localeSave).toMatchObject({ type: "json", status: 200 });
    expect((await get("owner")).body).toMatchObject({ configured: true, accountIdSet: true, status: "ok" });

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const keySave = await settingsHandlers.handlePostSettings(
      as("owner", "POST", "/api/v1/settings", { openaiApiKey: KEY }),
      HOSTED,
    );
    expect(keySave).toMatchObject({ type: "json", status: 200 });
    expect((await get("owner")).body).toMatchObject({ configured: true, accountIdSet: true, status: "ok" });
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))?.token).toBe(TOKEN);
  });

  it("the settings answers, read and saved, never carry the token", async () => {
    const gateway = fakeGateway(ok);
    await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });

    const read = await settingsHandlers.handleGetSettings(as("owner", "GET", "/api/v1/settings"), HOSTED);
    expect(read).toMatchObject({ type: "json", status: 200 });
    expect(JSON.stringify(read), "GET /api/v1/settings carried the token").not.toContain(TOKEN);

    const memberRead = await settingsHandlers.handleGetSettings(as("member", "GET", "/api/v1/settings"), HOSTED);
    expect(JSON.stringify(memberRead), "a member's GET /api/v1/settings carried the token").not.toContain(TOKEN);

    const saved = await settingsHandlers.handlePostSettings(
      as("owner", "POST", "/api/v1/settings", { locale: "en" }),
      HOSTED,
    );
    expect(saved).toMatchObject({ type: "json", status: 200 });
    expect(JSON.stringify(saved), "POST /api/v1/settings carried the token").not.toContain(TOKEN);
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))?.token).toBe(TOKEN);
  });
});

describe("one partner, two companies", () => {
  it("shows another company none of this company's token, and lets it set and clear only its own", async () => {
    const gateway = fakeGateway(ok);
    await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch });

    const otherBefore = await get("ownerB");
    expect(otherBefore.body).toEqual({ configured: false, accountIdSet: false, checkedAt: null, status: "unchecked" });
    expect(serialised(otherBefore)).not.toContain(TOKEN);

    await put("ownerB", { token: OTHER_TOKEN }, { ...HOSTED, fetch: gateway.fetch });
    expect((await get("owner")).body).toMatchObject({ configured: true, accountIdSet: true });
    expect((await get("ownerB")).body).toMatchObject({ configured: true, accountIdSet: false });

    expect((await remove("ownerB")).body.configured).toBe(false);
    expect((await get("owner")).body).toMatchObject({ configured: true, accountIdSet: true });
    expect(store.loadCompanyGatewayAdmin(tenantOf("owner"))?.token).toBe(TOKEN);
  });
});

describe("nothing a caller sees carries the token", () => {
  it("is absent from every answer and every log line across a full save, read and clear", async () => {
    const gateway = fakeGateway(ok);
    const answers = [
      await put("owner", { token: TOKEN, accountId: 9 }, { ...HOSTED, fetch: gateway.fetch }),
      await get("owner"),
      await get("admin"),
      await get("member"),
      await put("member", { token: TOKEN }, { ...HOSTED, fetch: gateway.fetch }),
      await remove("admin"),
      await remove("owner"),
    ];
    for (const answerValue of answers) {
      expect(serialised(answerValue)).not.toContain(TOKEN);
    }
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
