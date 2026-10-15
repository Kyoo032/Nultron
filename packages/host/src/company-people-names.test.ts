import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-company-people-names-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createPortalClient } from "./auth/portal-client";
import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const TENANT = "company-people-names";
const ORG = "org-people-names";
const PORTAL = "https://api.tokotokenai.com";

const ALICE = {
  userId: "0f1c2a3b-0000-4000-8000-00000000000a",
  role: "owner",
  display_name: "Alice Ardiansyah",
  username: "alice.ardi",
} as const;
const BOB = {
  userId: "0f1c2a3b-0000-4000-8000-00000000000b",
  role: "member",
  display_name: "Bobby Santoso",
  username: "bobby.s77",
} as const;
const CARA = {
  userId: "0f1c2a3b-0000-4000-8000-00000000000c",
  role: "admin",
  display_name: "cara_k9",
  username: "cara_k9",
} as const;
const DAN = {
  userId: "0f1c2a3b-0000-4000-8000-00000000000d",
  role: "member",
  display_name: null,
  username: "dan_nonames",
} as const;
const UJANG = {
  userId: "0f1c2a3b-0000-4000-8000-00000000000e",
  role: "member",
  display_name: null,
  username: "ujang.legacy",
} as const;

const USERNAMES = [ALICE, BOB, CARA, DAN, UJANG].map((who) => who.username);

type Person = { readonly tenant: { readonly userId: string }; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let bob: Person;
let cara: Person;
let project: string;

type SignIn = {
  readonly userId: string;
  readonly role: string;
  readonly display_name: string | null;
  readonly username: string;
};

async function signIn(who: SignIn): Promise<Person> {
  const body = {
    access_token: `acc-${who.userId}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: `ref-${who.userId}`,
    refresh_expires_in: 2592000,
    session_id: `ses-${who.userId}`,
    device_id: `dev-${who.userId}`,
    org_id: ORG,
    user_id: who.userId,
    tenant_id: TENANT,
    role: who.role,
    display_name: who.display_name,
    username: who.username,
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const tokens = await createPortalClient({ baseUrl: PORTAL, fetchImpl }).refresh({
    refreshToken: "ref-in",
    deviceId: "dev-in",
  });
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, {
    tenantId: tokens.tenantId,
    orgId: tokens.orgId,
    userId: tokens.userId,
    role: tokens.role,
    name: tokens.name,
  });
  const session = createSession({
    tenantId: tokens.tenantId,
    orgId: tokens.orgId,
    userId: tokens.userId,
    now: Date.now(),
  });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(person: Person, method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query: {},
    params,
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...(body === undefined ? {} : { body }),
  };
  return dispatch(request, { serverMode: true, sessionStore }) as Promise<HostResult>;
}

function jsonOf(result: HostResult): unknown {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body;
}

function boardOf(result: HostResult): unknown {
  return (jsonOf(result) as { board: unknown }).board;
}

function namesOf(body: unknown, key: "items" | "members" | "people"): Array<{ userId: string; name: string | null }> {
  const rows = (body as Record<string, Array<{ userId: string; name: string | null }>>)[key];
  return rows.map(({ userId, name }) => ({ userId, name }));
}

function leaking(text: string): string[] {
  const lower = text.toLocaleLowerCase();
  return USERNAMES.filter((username) => lower.includes(username.toLocaleLowerCase()));
}

beforeAll(async () => {
  sessionStore = createMemorySessionStore();

  alice = await signIn(ALICE);
  bob = await signIn(BOB);
  cara = await signIn(CARA);
  await signIn(DAN);

  const { db, ensurePortalOwner } = await import("@agentforge/db");
  await ensurePortalOwner(db, {
    tenantId: TENANT,
    orgId: ORG,
    userId: UJANG.userId,
    role: "member",
    name: UJANG.username,
  });
  await signIn(UJANG);

  const created = await call(alice, "POST", "/api/v1/projects", {}, { name: "Names room" });
  expect(created.status).toBe(201);
  project = (jsonOf(created) as { project: { id: string } }).project.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("password mode: a colleague's username is never shown to another person (SR-181)", () => {
  it("the people picker lists names, and an unnamed colleague with no name at all, never a username", async () => {
    const body = jsonOf(await call(alice, "GET", "/api/v1/projects/:id/invitable", { id: project }));
    const items = namesOf(body, "items");

    expect(items.map((item) => item.userId).sort()).toEqual([BOB.userId, CARA.userId, DAN.userId, UJANG.userId].sort());
    expect(items.find((item) => item.userId === BOB.userId)?.name).toBe("Bobby Santoso");
    expect(items.find((item) => item.userId === CARA.userId)?.name).toBeNull();
    expect(items.find((item) => item.userId === DAN.userId)?.name).toBeNull();
    expect(items.find((item) => item.userId === UJANG.userId)?.name).toBeNull();
    expect(leaking(JSON.stringify(body))).toEqual([]);
  });

  it("the members list and the board's people list carry no username either", async () => {
    const invited = await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: BOB.userId });
    expect(invited.status).toBe(201);
    expect(
      await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: DAN.userId }),
    ).toMatchObject({
      status: 201,
    });

    const members = jsonOf(await call(alice, "GET", "/api/v1/projects/:id/members", { id: project }));
    expect(namesOf(members, "members")).toEqual(
      expect.arrayContaining([
        { userId: ALICE.userId, name: "Alice Ardiansyah" },
        { userId: BOB.userId, name: "Bobby Santoso" },
        { userId: DAN.userId, name: null },
      ]),
    );
    expect(leaking(JSON.stringify(members))).toEqual([]);

    const board = boardOf(await call(bob, "GET", "/api/v1/board"));
    expect(namesOf(board, "people")).toEqual(
      expect.arrayContaining([
        { userId: CARA.userId, name: null },
        { userId: DAN.userId, name: null },
        { userId: UJANG.userId, name: null },
      ]),
    );
    expect(leaking(JSON.stringify(board))).toEqual([]);
  });

  it("a display name equal to the username is treated as no name, and a row that stored the username is cleared at its next sign-in", async () => {
    expect(namesOf(boardOf(await call(cara, "GET", "/api/v1/board")), "people")).toEqual(
      expect.arrayContaining([{ userId: CARA.userId, name: null }]),
    );
    const { sql } = await import("@agentforge/db");
    const stored = sql.prepare("SELECT name FROM user WHERE id = ?").get(UJANG.userId) as { name: string } | undefined;
    expect(stored?.name).toBe(UJANG.userId);
  });
});
