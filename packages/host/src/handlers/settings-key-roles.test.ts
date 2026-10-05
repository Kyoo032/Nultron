/**
 * M4 — who may write the company's gateway key on the hosted service.
 *
 * Found in the 2026-10-01 abuse walk: any signed-in *member* could replace the company key
 * (`POST /api/v1/settings { openaiApiKey }`) or forget it (`POST /api/v1/settings/reset
 * { scope: "key" }`) — the first answered 200 as a member, and so did the second. The key is the
 * company's, shared by every person who signs in to it, so changing it needs `canAdminister`: an owner
 * or an admin. A member, and a builder (the host's own role), get `403 settings_key_forbidden`.
 *
 * Real handlers, real membership rows, throwaway data dir. The people are provisioned through
 * `ensurePortalOwner` — the same call a portal sign-in makes — so the role the handler reads is the
 * membership row `resolvePortalTenant` returns, not a stub. Hosted mode is injected (`isServerMode`)
 * rather than set in the environment, like `settings.test.ts`: flipping `AGENTFORGE_SERVER` in this
 * process would put the router's session gate in front of every call.
 *
 * The Personal half is pinned too: off server mode there is no role check at all, so the same member
 * session on a desk saves and forgets a key exactly as it always did.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MembershipRole, PortalRole, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-settings-key-roles-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
// Outside the stub runtime, the way a hosted tenant runs: a key write reaches the gateway check.
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const TENANT_ID = "tenant-key-roles";
const ORG_ID = "org-key-roles";
const KEY = "sk-key-roles-00000000000000";
const OTHER_KEY = "sk-key-roles-11111111111111";

const HOSTED = { isServerMode: () => true };
const DESK = { isServerMode: () => false };
type Deps = { isServerMode: () => boolean };

type Person = "owner" | "admin" | "member" | "builder";
type Answer = { status: number; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
const people = new Map<Person, TenantContext>();
let store: typeof import("../settings-store");
let handlers: typeof import("./settings");
let FORBIDDEN_CODE: string;

function stubFetch(status: number): void {
  globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
}

function as(person: Person, method: string, path: string, body?: unknown): HostRequest {
  const tenant = people.get(person);
  if (!tenant) {
    throw new Error(`${person} was not provisioned`);
  }
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

async function save(person: Person, body: Record<string, unknown>, deps: Deps = HOSTED): Promise<Answer> {
  return answer(await handlers.handlePostSettings(as(person, "POST", "/api/v1/settings", body), deps));
}

async function reset(person: Person, body: Record<string, unknown>, deps: Deps = HOSTED): Promise<Answer> {
  return answer(await handlers.handleResetApp(as(person, "POST", "/api/v1/settings/reset", body), deps));
}

function errorOf(response: Answer): { code?: string; message?: string } {
  return (response.body.error ?? {}) as { code?: string; message?: string };
}

/** The company's stored key, read straight from the store the handler writes. */
function companyKey(): string | undefined {
  const owner = people.get("owner");
  return owner ? store.loadSettings(owner).openaiApiKey : undefined;
}

/** Put the key in the company's store as the owner would have, for the cases that try to take it away. */
async function ownerHasSaved(key: string = KEY): Promise<void> {
  stubFetch(200);
  const response = await save("owner", { openaiApiKey: key });
  expect(response.status).toBe(200);
  expect(companyKey()).toBe(key);
}

beforeAll(async () => {
  const dbModule = await import("@agentforge/db");
  handlers = await import("./settings");
  store = await import("../settings-store");
  FORBIDDEN_CODE = handlers.SETTINGS_KEY_FORBIDDEN_CODE;

  const roles: Array<[Person, PortalRole | null]> = [
    ["owner", "owner"],
    ["admin", "admin"],
    ["member", "member"],
    ["builder", "member"],
  ];
  for (const [person, role] of roles) {
    people.set(
      person,
      await dbModule.ensurePortalOwner(dbModule.db, {
        tenantId: TENANT_ID,
        orgId: ORG_ID,
        userId: `usr-${person}`,
        role,
      }),
    );
  }
  // `builder` is the host's own role, not one of the portal's three: write the row the way a host
  // that grants it would, then read it back through the resolver the handler uses.
  dbModule.sql
    .prepare("UPDATE organization_members SET role = 'builder' WHERE organization_id = ? AND user_id = ?")
    .run(ORG_ID, "usr-builder");
  const resolved = await dbModule.resolvePortalTenant(dbModule.db, {
    tenantId: TENANT_ID,
    orgId: ORG_ID,
    userId: "usr-builder",
  });
  if (!resolved.ok) {
    throw new Error(`builder did not resolve: ${resolved.code}`);
  }
  people.set("builder", resolved.tenant);
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(async () => {
  globalThis.fetch = realFetch;
  stubFetch(200);
  // Start every case without a key and without anyone's language, whoever wrote them.
  if (people.has("owner")) {
    await reset("owner", { scope: "key" }, DESK);
  }
  for (const tenant of people.values()) {
    store.saveUserLocale(tenant, "en");
  }
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the people in the fixture are who they say they are", () => {
  it("resolve to the four roles the handlers will read", () => {
    const roles = (["owner", "admin", "member", "builder"] as const).map((person) => people.get(person)?.role);
    expect(roles).toEqual<MembershipRole[]>(["owner", "admin", "member", "builder"]);
    expect(new Set([...people.values()].map((tenant) => tenant.tenantId))).toEqual(new Set([TENANT_ID]));
  });
});

describe("saving a key, hosted", () => {
  it("refuses a member with settings_key_forbidden and stores nothing", async () => {
    stubFetch(200);
    const response = await save("member", { openaiApiKey: KEY });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(FORBIDDEN_CODE).toBe("settings_key_forbidden");
    expect(errorOf(response).message).toMatch(/owner or admin/i);
    expect(companyKey()).toBeUndefined();
  });

  it("refuses a builder too: the bar is canAdminister, not canBuild", async () => {
    stubFetch(200);
    const response = await save("builder", { openaiApiKey: KEY });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(companyKey()).toBeUndefined();
  });

  it("refuses a member who tries to REPLACE the key an owner saved, and the owner's key survives", async () => {
    await ownerHasSaved();
    const response = await save("member", { openaiApiKey: OTHER_KEY });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(companyKey()).toBe(KEY);
  });

  it.each(["googleApiKey", "anthropicApiKey", "volcengineApiKey"] as const)(
    "refuses a member on %s as well: every provider key field is the company's",
    async (field) => {
      stubFetch(200);
      const response = await save("member", { [field]: "sk-other-provider-0000000" });

      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
      const owner = people.get("owner") as TenantContext;
      expect(store.loadSettings(owner)[field]).toBeUndefined();
    },
  );

  it("refuses the whole request when a key rides along with a setting the member may change", async () => {
    // Fail closed: the language is the member's own, but it arrives in a request that also tries to
    // write the key, so nothing in the request is applied — not even the part that would have been fine.
    stubFetch(200);
    const response = await save("member", { locale: "id", openaiApiKey: KEY, editTurnCapUsd: 9 });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(companyKey()).toBeUndefined();
    expect(store.loadUserLocale(people.get("member") as TenantContext)).not.toBe("id");
    expect(store.loadSettings(people.get("owner") as TenantContext).editTurnCapUsd).not.toBe(9);
  });

  it("lets an admin save the key", async () => {
    stubFetch(200);
    const response = await save("admin", { openaiApiKey: KEY });

    expect(response.status).toBe(200);
    expect(response.body.hasOpenai).toBe(true);
    expect(companyKey()).toBe(KEY);
  });

  it("lets an owner save the key, and replace it", async () => {
    await ownerHasSaved();
    stubFetch(200);
    const replaced = await save("owner", { openaiApiKey: OTHER_KEY });

    expect(replaced.status).toBe(200);
    expect(companyKey()).toBe(OTHER_KEY);
  });
});

describe("what a member can still change", () => {
  it("saves their own language", async () => {
    const response = await save("member", { locale: "id" });

    expect(response.status).toBe(200);
    expect(response.body.savedLocale).toBe("id");
  });

  it("saves a setting that is not a key", async () => {
    const response = await save("member", { editTurnCapUsd: 4 });

    expect(response.status).toBe(200);
  });

  it("is not refused for the blank key the Settings page echoes on every save", async () => {
    // `settings-page.tsx` posts `openaiApiKey` from state. A blank is dropped by the host in server mode
    // (`keyFieldValue`), so it writes nothing and a member's ordinary save must not turn into a 403.
    await ownerHasSaved();
    for (const blank of ["", "   "]) {
      const response = await save("member", { openaiApiKey: blank, locale: "id", editTurnCapUsd: 3 });
      expect(response.status, JSON.stringify(blank)).toBe(200);
    }
    expect(companyKey()).toBe(KEY);
  });

  it("is not refused for a key field that is not a string: nothing is written either", async () => {
    await ownerHasSaved();
    const response = await save("member", { openaiApiKey: null, googleApiKey: 42, locale: "id" });

    expect(response.status).toBe(200);
    expect(companyKey()).toBe(KEY);
  });

  it("still sees the company's settings: the read is open", async () => {
    await ownerHasSaved();
    const response = answer(await handlers.handleGetSettings(as("member", "GET", "/api/v1/settings"), HOSTED));

    expect(response.status).toBe(200);
    expect(response.body.hasOpenai).toBe(true);
    // The key itself never travels: a fingerprint at most.
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });
});

describe("forgetting the key, hosted", () => {
  it("refuses a member and leaves the key where it was", async () => {
    await ownerHasSaved();
    const response = await reset("member", { scope: "key" });

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe(FORBIDDEN_CODE);
    expect(errorOf(response).message).toMatch(/owner or admin/i);
    expect(companyKey()).toBe(KEY);
  });

  it("refuses a builder", async () => {
    await ownerHasSaved();
    const response = await reset("builder", { scope: "key" });

    expect(response.status).toBe(403);
    expect(companyKey()).toBe(KEY);
  });

  it("lets an admin forget it", async () => {
    await ownerHasSaved();
    const response = await reset("admin", { scope: "key" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, scope: "key" });
    expect(companyKey()).toBeUndefined();
  });

  it("lets an owner forget it", async () => {
    await ownerHasSaved();
    const response = await reset("owner", { scope: "key" });

    expect(response.status).toBe(200);
    expect(companyKey()).toBeUndefined();
  });

  it("leaves scope all to the rule it already had", async () => {
    // Start over is off on the hosted service for everybody, so a member meets reset_disabled and never
    // the new code. (The company erase, scope tenant, reads the process environment for server mode and
    // is driven end to end in portal-roles.test.ts, where a member gets tenant_reset_forbidden.)
    const all = await reset("member", { scope: "all", confirm: "RESET" });
    expect(all.status).toBe(403);
    expect(errorOf(all).code).toBe("reset_disabled");
  });
});

describe("the Personal app is untouched: no role is read off server mode", () => {
  it("saves a key for a session whose role is member when the switch says desk", async () => {
    stubFetch(200);
    const response = await save("member", { openaiApiKey: KEY }, DESK);

    expect(response.status).toBe(200);
    expect(response.body.hasOpenai).toBe(true);
    expect(companyKey()).toBe(KEY);
  });

  it("forgets a key for that same member when the switch says desk", async () => {
    await ownerHasSaved();
    const response = await reset("member", { scope: "key" }, DESK);

    expect(response.status).toBe(200);
    expect(companyKey()).toBeUndefined();
  });

  it("clears a key with an empty string off server mode, as the desk owner always could", async () => {
    stubFetch(200);
    await save("member", { openaiApiKey: KEY }, DESK);
    const cleared = await save("member", { openaiApiKey: "" }, DESK);

    expect(cleared.status).toBe(200);
    expect(cleared.body.hasOpenai).toBe(false);
  });

  it("never asks who the caller is: the refusal is not in the source path the desk takes", async () => {
    // A guard on the guard. The same body, the same person, the only difference is the switch.
    stubFetch(200);
    const hosted = await save("member", { openaiApiKey: KEY }, HOSTED);
    const desk = await save("member", { openaiApiKey: KEY }, DESK);

    expect([hosted.status, desk.status]).toEqual([403, 200]);
  });
});

describe("no key field slips past the gate", () => {
  it("every provider key the settings POST forwards to the patch is one requestsKeyWrite counts", () => {
    // A drift guard. The settings handler forwards a key through `keyFieldValue(body.<field>, ...)`; the
    // role check counts the same fields. BYOK Phase B will add a field per provider, and a field added to
    // the first without the second would be a key a member can write. This fails the day that happens.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "settings.ts"), "utf8");
    const forwarded = [...source.matchAll(/keyFieldValue\(body\.(\w+),/g)].map((match) => match[1]).sort();

    expect(forwarded).toEqual(["anthropicApiKey", "googleApiKey", "openaiApiKey", "volcengineApiKey"]);
    for (const field of forwarded) {
      expect(handlers.requestsKeyWrite({ [field]: KEY }, true), field).toBe(true);
    }
  });
});

describe("requestsKeyWrite", () => {
  it("counts only a non-blank string in a provider key field, and only in server mode", () => {
    const { requestsKeyWrite } = handlers;
    expect(requestsKeyWrite({ openaiApiKey: KEY }, true)).toBe(true);
    expect(requestsKeyWrite({ googleApiKey: KEY }, true)).toBe(true);
    expect(requestsKeyWrite({ anthropicApiKey: KEY }, true)).toBe(true);
    expect(requestsKeyWrite({ volcengineApiKey: KEY }, true)).toBe(true);
    expect(requestsKeyWrite({ openaiApiKey: "" }, true)).toBe(false);
    expect(requestsKeyWrite({ openaiApiKey: "  " }, true)).toBe(false);
    expect(requestsKeyWrite({ openaiApiKey: null, googleApiKey: 5 }, true)).toBe(false);
    expect(requestsKeyWrite({ locale: "id", editTurnCapUsd: 1 }, true)).toBe(false);
    // Off server mode a blank IS a write (it clears the desk's key), but no role is read there, so the
    // predicate is only ever asked in server mode; it says false rather than guess.
    expect(requestsKeyWrite({ openaiApiKey: KEY }, false)).toBe(false);
  });
});
