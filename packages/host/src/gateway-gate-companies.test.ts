/**
 * SR-163: the hosted gateway gate is decided per company, not once per partner.
 *
 * The 2026-10-07 load rig saw it: after a second company saved a gateway key that differed from the
 * first company's, the first company's next Chat turn answered `403 gateway_blocked`. The cause was one
 * level up from where the code looked. `TenantContext.tenantId` is the white-label partner (a brand,
 * Nultron Enterprise), and every company of a deployment is an organisation inside that one partner. The
 * keys are per desk, and a desk belongs to one organisation, so two companies never shared a key; but the
 * verdict (`gateway_gate`) was one `tenant_state` row per partner. Company B's check overwrote
 * company A's verdict, A's key no longer matched the verdict on file, and the hosted gate treats "no
 * verdict for this key" as closed.
 *
 * Real router, real sessions, real database and a throwaway data dir. The gateway is a stand-in `fetch`
 * that answers by the bearer it is shown, so "company B's key is rejected" is something the test says and
 * not something it hopes for. The runtime is the one stand-in that records what a run was handed.
 *
 * Two partners with one company each is the other topology (the one every earlier test used), and it is
 * pinned here too, so the fix cannot trade one for the other.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-gate-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "9a4c2e7b1d5f4308a6e1c9b3d7f20458e1a6c3b9d0f42715e8a3c6b1d9f04e72";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;

import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await input.onEvent({ type: "assistant.delta", text: "hello" });
        await input.onEvent({ type: "run.completed", runId: input.runId });
      },
    }),
  };
});

const { dispatch } = await import("./router");
const gateModule = await import("./gateway-gate");
const settingsStore = await import("./settings-store");

const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);

/** What the stand-in gateway says to each bearer. A key it has never heard of is a 401. */
const gatewayAnswers = new Map<string, number>();
/** The model ids the stand-in gateway lists to each bearer it answers 200 (none unless a case says). */
const gatewayModels = new Map<string, string[]>();
/** Every `GET /models` the stand-in gateway was asked, in order, with the bearer that came with it. */
const gatewayAsked: Array<{ bearer: string }> = [];

function bearerOf(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (!headers) {
    return "";
  }
  const raw =
    headers instanceof Headers
      ? headers.get("authorization")
      : Array.isArray(headers)
        ? (headers.find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? null)
        : ((headers as Record<string, string>).Authorization ??
          (headers as Record<string, string>).authorization ??
          null);
  // A rejected key is also tried under the other providers' header names (dialect detection in the model
  // probe: `x-api-key` for Anthropic, `x-goog-api-key` for Gemini). It is still that company's key.
  const other = headers instanceof Headers || Array.isArray(headers) ? null : otherProviderKeyOf(headers);
  return String(raw ?? other ?? "").replace(/^Bearer\s+/i, "");
}

function otherProviderKeyOf(headers: object): string | null {
  const record = headers as Record<string, string>;
  return record["x-api-key"] ?? record["x-goog-api-key"] ?? null;
}

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let seq = 0;

type Company = {
  readonly tenant: TenantContext;
  readonly session: ReturnType<typeof createSession>;
  readonly threadId: string;
  /** The desk this view of the company is on. Absent means the company's first desk (`tenant.workspaceId`). */
  readonly deskId?: string;
};

function hostedRequest(company: Company, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${company.session.id}` },
    ...(company.deskId ? { workspaceId: company.deskId } : {}),
    ...over,
  };
}

async function json<T = Record<string, unknown>>(
  company: Company,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result: HostResult = await dispatch(hostedRequest(company, method, path, body === undefined ? {} : { body }), {
    serverMode: true,
    sessionStore,
    now: () => T0,
  });
  if (result.type !== "json") {
    throw new Error(`expected json from ${path}, got ${result.type}`);
  }
  return ((result as HostJsonResult).body ?? {}) as T;
}

type GateBody = {
  status: string;
  allowed: boolean;
  grace: boolean;
  checkedAt: string | null;
  lastOkAt: string | null;
  message?: string;
};

async function settingsGate(company: Company): Promise<GateBody> {
  return (await json<{ gateway: GateBody }>(company, "GET", "/api/v1/settings")).gateway;
}

async function saveKey(company: Company, key: string): Promise<GateBody> {
  return (await json<{ gateway: GateBody }>(company, "POST", "/api/v1/settings", { openaiApiKey: key })).gateway;
}

/** One Chat turn. `blocked` is the flat `403 gateway_blocked` body; otherwise the run reached the runtime. */
async function chatTurn(
  company: Company,
): Promise<{ ran: true } | { ran: false; status: number; error: unknown; gateStatus: unknown }> {
  executed.length = 0;
  const result = await dispatch(
    hostedRequest(company, "POST", `/api/v1/threads/${company.threadId}/runs/text`, {
      params: { threadId: company.threadId },
      body: { content: "hello" },
    }),
    { serverMode: true, sessionStore, now: () => T0 },
  );
  if (result.type === "stream") {
    for await (const _frame of result.events) {
      // Drain: a run reaches the runtime only as its frames are read.
    }
    return { ran: executed.length === 1 } as { ran: true };
  }
  const body = ((result as HostJsonResult).body ?? {}) as { error?: unknown; status?: unknown };
  return { ran: false, status: (result as HostJsonResult).status, error: body.error, gateStatus: body.status };
}

/** A company: its own organisation, one owner, one Chat thread. `partner` is the white-label tenant id. */
async function provision(partner: string, label: string): Promise<Company> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  seq += 1;
  const identity = { tenantId: partner, orgId: `gate-org-${label}-${seq}`, userId: `gate-user-${label}-${seq}` };
  const tenant = await ensurePortalOwner(db, { ...identity, role: "owner" });
  const session = createSession({ ...identity, now: T0 });
  await sessionStore.create(session);
  const company = { tenant, session, threadId: "" } satisfies Company;
  const chat = await json<{ agent: { id: string } }>(company, "GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>(company, "POST", "/api/v1/threads", {
    agentId: chat.agent.id,
  });
  return { ...company, threadId: created.thread.id };
}

function freshPartner(): string {
  seq += 1;
  return `gate-partner-${seq}`;
}

const keyFor = (label: string): string => `sk-gate-companies-${label}-${"x".repeat(20)}`;

beforeAll(async () => {
  sessionStore = createMemorySessionStore();
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const text = String(url);
    if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
      const bearer = bearerOf(init);
      gatewayAsked.push({ bearer });
      return new Response(JSON.stringify({ data: (gatewayModels.get(bearer) ?? []).map((id) => ({ id })) }), {
        status: gatewayAnswers.get(bearer) ?? 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  // Load the router's database once, while the process is still a desk, so the first request of a case
  // is not the one that pays for it.
  await import("@agentforge/db");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_SERVER = "1";
  gatewayAnswers.clear();
  gatewayModels.clear();
  gatewayAsked.length = 0;
  gateModule.resetGatewayRefreshThrottle();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  settingsStore.resetSettingsCacheForTests();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("two companies under one partner: each gate follows its own key", () => {
  it("lets both companies chat after each has saved a different key the gateway accepts", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 200);

    expect(await saveKey(a, keyFor("a"))).toMatchObject({ status: "ok", allowed: true });
    expect(await saveKey(b, keyFor("b"))).toMatchObject({ status: "ok", allowed: true });

    // The report: B's save used to leave A's next turn answered 403 gateway_blocked.
    expect(await chatTurn(a)).toEqual({ ran: true });
    expect(await chatTurn(b)).toEqual({ ran: true });
  });

  it("closes only the company whose key the gateway rejected", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 401);

    expect(await saveKey(a, keyFor("a"))).toMatchObject({ status: "ok", allowed: true });
    expect(await saveKey(b, keyFor("b"))).toMatchObject({ status: "invalid_key", allowed: false });

    expect(await chatTurn(a)).toEqual({ ran: true });
    expect(await chatTurn(b)).toMatchObject({
      ran: false,
      status: 403,
      error: "gateway_blocked",
      gateStatus: "invalid_key",
    });
  });

  it("reports each company's own verdict on a Settings read, whichever saved last", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 401);

    await saveKey(a, keyFor("a"));
    await saveKey(b, keyFor("b"));

    expect(await settingsGate(a)).toMatchObject({ status: "ok", allowed: true, grace: false });
    expect(await settingsGate(b)).toMatchObject({ status: "invalid_key", allowed: false });
    // And back again: reading one company's gate never rewrites the other's.
    expect(await settingsGate(a)).toMatchObject({ status: "ok", allowed: true });
  });

  it("keeps one company's lastOkAt out of the other's payload", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 200);

    const savedA = await saveKey(a, keyFor("a"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const savedB = await saveKey(b, keyFor("b"));

    expect(savedA.lastOkAt).not.toBeNull();
    expect(savedB.lastOkAt).not.toBeNull();
    expect(savedB.lastOkAt).not.toBe(savedA.lastOkAt);
    expect((await settingsGate(a)).lastOkAt).toBe(savedA.lastOkAt);
    expect((await settingsGate(b)).lastOkAt).toBe(savedB.lastOkAt);
  });

  it("tells a company with no key nothing about the others' keys or checks", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const keyless = await provision(partner, "keyless");
    const before = await settingsGate(keyless);

    gatewayAnswers.set(keyFor("a"), 200);
    await saveKey(a, keyFor("a"));
    const after = await settingsGate(keyless);

    expect(before).toMatchObject({ status: "needs_key", allowed: false, checkedAt: null, lastOkAt: null });
    expect(after).toEqual(before);
    expect(await chatTurn(keyless)).toMatchObject({ ran: false, status: 403, gateStatus: "needs_key" });
    // Nobody asked the gateway anything on the keyless company's behalf.
    expect(gatewayAsked.filter((call) => call.bearer === "")).toEqual([]);
  });

  it("signing out of the gateway forgets that company's key and verdict, and no one else's", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 200);
    await saveKey(a, keyFor("a"));
    await saveKey(b, keyFor("b"));

    const out = await json<{ gateway: GateBody }>(b, "POST", "/api/v1/settings/reset", { scope: "key" });
    expect(out.gateway).toMatchObject({ status: "needs_key", allowed: false });

    expect(settingsStore.loadSettings(b.tenant).openaiApiKey).toBeFalsy();
    expect(settingsStore.loadSettings(a.tenant).openaiApiKey).toBe(keyFor("a"));
    expect(await chatTurn(a)).toEqual({ ran: true });
    expect(await chatTurn(b)).toMatchObject({ ran: false, status: 403, gateStatus: "needs_key" });
  });

  it("re-checks each company's own key in the background, and never one company's key for another", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 401);
    // Keys on file and no verdict yet: what a hosted company looks like after an upgrade.
    settingsStore.saveSettings({ openaiApiKey: keyFor("a") }, a.tenant);
    settingsStore.saveSettings({ openaiApiKey: keyFor("b") }, b.tenant);

    // A Settings read starts the check and does not wait for it, so the first answer may or may not
    // already carry the verdict (the stand-in gateway answers at once). What matters is who was asked.
    // The hosted model-cache warm-up probes the same `/models` on that read too, so this counts keys,
    // not requests.
    const askedKeys = () => [...new Set(gatewayAsked.map((call) => call.bearer))];
    await settingsGate(a);
    await vi.waitFor(async () => expect(await settingsGate(a)).toMatchObject({ status: "ok", allowed: true }), {
      timeout: 5_000,
    });
    expect(askedKeys()).toEqual([keyFor("a")]);

    await settingsGate(b);
    await vi.waitFor(
      async () => expect(await settingsGate(b)).toMatchObject({ status: "invalid_key", allowed: false }),
      {
        timeout: 5_000,
      },
    );
    expect(askedKeys()).toEqual([keyFor("a"), keyFor("b")]);

    // B's refusal did not close A, and each verdict is still its own: with the throttle forgotten, neither
    // company is due a re-check (A's is fresh and its key's; B's is a rejection, which is never asked
    // again on its own). Before the fix B's write had replaced A's, and A was due again.
    expect(await settingsGate(a)).toMatchObject({ status: "ok", allowed: true });
    gateModule.resetGatewayRefreshThrottle();
    const due = async () => undefined;
    expect(
      gateModule.maybeRefreshGateway(settingsStore.loadSettings(a.tenant), { tenant: a.tenant, runCheck: due }),
    ).toBe(false);
    expect(
      gateModule.maybeRefreshGateway(settingsStore.loadSettings(b.tenant), { tenant: b.tenant, runCheck: due }),
    ).toBe(false);
  });

  it("gives two companies that hold the same key one background re-check each", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("shared"), 200);
    settingsStore.saveSettings({ openaiApiKey: keyFor("shared") }, a.tenant);
    settingsStore.saveSettings({ openaiApiKey: keyFor("shared") }, b.tenant);

    const started: string[] = [];
    const runCheck = async (_settings: unknown, opts: { tenant?: unknown }) => {
      started.push(String((opts.tenant as TenantContext).organizationId));
    };
    const first = gateModule.maybeRefreshGateway(settingsStore.loadSettings(a.tenant), { tenant: a.tenant, runCheck });
    const second = gateModule.maybeRefreshGateway(settingsStore.loadSettings(b.tenant), { tenant: b.tenant, runCheck });

    expect([first, second]).toEqual([true, true]);
    expect(started).toEqual([a.tenant.organizationId, b.tenant.organizationId]);
  });
});

describe("two partners with one company each: the topology every earlier test used", () => {
  it("keeps each partner's gate on its own key, accepted or rejected", async () => {
    const a = await provision(freshPartner(), "a");
    const b = await provision(freshPartner(), "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 401);

    await saveKey(a, keyFor("a"));
    await saveKey(b, keyFor("b"));

    expect(await chatTurn(a)).toEqual({ ran: true });
    expect(await chatTurn(b)).toMatchObject({ ran: false, status: 403, gateStatus: "invalid_key" });
    expect(await settingsGate(a)).toMatchObject({ status: "ok", allowed: true });
  });
});

/** A second desk for the same company, made the way a person makes one (`POST /api/v1/workspaces`), with its own thread. */
async function addDesk(company: Company, name: string): Promise<Company> {
  const made = await json<{ workspace: { id: string } }>(company, "POST", "/api/v1/workspaces", { name });
  const onIt: Company = { ...company, deskId: made.workspace.id, threadId: "" };
  const chat = await json<{ agent: { id: string } }>(onIt, "GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>(onIt, "POST", "/api/v1/threads", { agentId: chat.agent.id });
  return { ...onIt, threadId: created.thread.id };
}

function deskSettings(company: Company) {
  return settingsStore.loadSettings({
    tenantId: company.tenant.tenantId,
    workspaceId: company.deskId ?? company.tenant.workspaceId,
  });
}

/**
 * SR-163, review round. The verdict is per company but a key is stored per desk, and a desk made later
 * copies the key once at creation. Rotating the key on one desk left a company's other desks on the old
 * one: their fingerprint no longer matched the company's verdict, they answered `403 gateway_blocked`,
 * and a re-check from one of them could replace the verdict and close the first. On the server the key
 * belongs to the company (`handlers/settings.ts`), so saving it writes it to every desk of the company.
 */
describe("two desks in one company: the company's key reaches every desk", () => {
  it("keeps the second desk open when the key is rotated on the first", async () => {
    const partner = freshPartner();
    const d1 = await provision(partner, "a");
    gatewayAnswers.set(keyFor("k0"), 200);
    gatewayAnswers.set(keyFor("k1"), 200);
    await saveKey(d1, keyFor("k0"));
    const d2 = await addDesk(d1, "Second");
    // The second desk took the key at creation, as it always has.
    expect(deskSettings(d2).openaiApiKey).toBe(keyFor("k0"));
    expect(await chatTurn(d2)).toEqual({ ran: true });

    expect(await saveKey(d1, keyFor("k1"))).toMatchObject({ status: "ok", allowed: true });

    // Both desks hold the company's new key, and both are open on its verdict.
    expect(deskSettings(d1).openaiApiKey).toBe(keyFor("k1"));
    expect(deskSettings(d2).openaiApiKey).toBe(keyFor("k1"));
    expect(await chatTurn(d1)).toEqual({ ran: true });
    expect(await chatTurn(d2)).toEqual({ ran: true });
    expect(await settingsGate(d2)).toMatchObject({ status: "ok", allowed: true });
    // A re-check started from the second desk judges the same key, so it cannot close the first.
    const recheck = await json<{ gateway: GateBody }>(d2, "POST", "/api/v1/settings/gateway/check");
    expect(recheck.gateway).toMatchObject({ status: "ok", allowed: true });
    expect(await chatTurn(d1)).toEqual({ ran: true });
  });

  it("does the same from the second desk: the key is the company's, whichever desk it is typed on", async () => {
    const partner = freshPartner();
    const d1 = await provision(partner, "a");
    gatewayAnswers.set(keyFor("k0"), 200);
    gatewayAnswers.set(keyFor("k1"), 200);
    await saveKey(d1, keyFor("k0"));
    const d2 = await addDesk(d1, "Second");

    await saveKey(d2, keyFor("k1"));

    expect(deskSettings(d1).openaiApiKey).toBe(keyFor("k1"));
    expect(await chatTurn(d1)).toEqual({ ran: true });
    expect(await chatTurn(d2)).toEqual({ ran: true });
  });

  it("closes every desk of the company together when the gateway rejects the new key", async () => {
    const partner = freshPartner();
    const d1 = await provision(partner, "a");
    gatewayAnswers.set(keyFor("k0"), 200);
    gatewayAnswers.set(keyFor("bad"), 401);
    await saveKey(d1, keyFor("k0"));
    const d2 = await addDesk(d1, "Second");

    expect(await saveKey(d1, keyFor("bad"))).toMatchObject({ status: "invalid_key", allowed: false });

    expect(await chatTurn(d1)).toMatchObject({ ran: false, status: 403, gateStatus: "invalid_key" });
    expect(await chatTurn(d2)).toMatchObject({ ran: false, status: 403, gateStatus: "invalid_key" });
  });

  it("leaves another company's desks, and their keys, exactly as they were", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b1 = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a0"), 200);
    gatewayAnswers.set(keyFor("a1"), 200);
    gatewayAnswers.set(keyFor("b"), 200);
    await saveKey(b1, keyFor("b"));
    const b2 = await addDesk(b1, "B second");
    await saveKey(a, keyFor("a0"));
    const a2 = await addDesk(a, "A second");
    const verdictOfB = await settingsGate(b1);

    await saveKey(a, keyFor("a1"));

    expect(deskSettings(a).openaiApiKey).toBe(keyFor("a1"));
    expect(deskSettings(a2).openaiApiKey).toBe(keyFor("a1"));
    expect(deskSettings(b1).openaiApiKey).toBe(keyFor("b"));
    expect(deskSettings(b2).openaiApiKey).toBe(keyFor("b"));
    expect(await settingsGate(b1)).toEqual(verdictOfB);
    expect(await chatTurn(b1)).toEqual({ ran: true });
    expect(await chatTurn(b2)).toEqual({ ran: true });
  });

  it("carries every provider key, and nothing else, to the company's other desks", async () => {
    const partner = freshPartner();
    const d1 = await provision(partner, "a");
    gatewayAnswers.set(keyFor("k0"), 200);
    await saveKey(d1, keyFor("k0"));
    const d2 = await addDesk(d1, "Second");

    await json(d1, "POST", "/api/v1/settings", {
      googleApiKey: "g-key-from-first-desk",
      imageGenModel: "image-model-of-first-desk",
      editTurnCapUsd: 3,
    });

    expect(deskSettings(d2).googleApiKey).toBe("g-key-from-first-desk");
    // A desk's own choices stay its own: only the company's credentials are the company's.
    expect(deskSettings(d1).imageGenModel).toBe("image-model-of-first-desk");
    expect(deskSettings(d2).imageGenModel).toBeUndefined();
    expect(deskSettings(d1).editTurnCapUsd).toBe(3);
    expect(deskSettings(d2).editTurnCapUsd).toBeUndefined();
  });

  it("does not touch the other desks when a save carries no key, however the field is spelt", async () => {
    const partner = freshPartner();
    const d1 = await provision(partner, "a");
    gatewayAnswers.set(keyFor("k0"), 200);
    await saveKey(d1, keyFor("k0"));
    const d2 = await addDesk(d1, "Second");
    // A desk holding a key of its own, put there before this rule: a save that names no key leaves it.
    settingsStore.saveSettings({ openaiApiKey: keyFor("own") }, {
      tenantId: d2.tenant.tenantId,
      workspaceId: d2.deskId as string,
    });

    await json(d1, "POST", "/api/v1/settings", { openaiApiKey: "   ", imageGenModel: "m" });

    expect(deskSettings(d1).openaiApiKey).toBe(keyFor("k0"));
    expect(deskSettings(d2).openaiApiKey).toBe(keyFor("own"));
  });
});

/**
 * SR-163, review round. The deploy window. Before this change a hosted partner had ONE stored verdict, and
 * every company's slot starts empty; on the hosted server "no verdict for this key" is a closed gate, and a
 * check that finds the gateway unreachable at that moment stores `unreachable` with no `lastOkAt`, so the
 * company gets no grace either. The partner's old row names the fingerprint of the key it judged, so a
 * company whose own key has exactly that fingerprint adopts it (its `lastOkAt` too). A different key never
 * does.
 */
describe("the deploy window: a company adopts the partner's old verdict for the key it holds", () => {
  const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
  const partnerVerdict = async (key: string, status: "ok" | "invalid_key" = "ok") => ({
    version: 1 as const,
    fingerprint: (await import("@agentforge/core")).keyFingerprintOrNull(key),
    status,
    checkedAt: hourAgo(),
    lastOkAt: status === "ok" ? hourAgo() : null,
  });
  const slotsOf = async (partner: string): Promise<string[]> => {
    const { db } = await import("@agentforge/db");
    return (
      db.$client
        .prepare("SELECT key FROM tenant_state WHERE tenant_id = ? AND key LIKE 'gateway_gate%' ORDER BY key")
        .all(partner) as Array<{ key: string }>
    ).map((row) => row.key);
  };
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;

  it("opens a company on the verdict the partner already had for its key, and keeps it as its own", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("a")));
    settingsStore.saveSettings({ openaiApiKey: keyFor("a") }, a.tenant);
    expect(await slotsOf(partner)).toEqual(["gateway_gate"]);

    const gate = gateModule.reportGatewayGate(settingsStore.loadSettings(a.tenant), {
      tenant: a.tenant,
      envRuntime: undefined,
    });

    expect(gate).toMatchObject({ status: "ok", allowed: true, grace: false });
    expect(gate.lastOkAt).not.toBeNull();
    // Adopted into the company's own slot, and the partner's row is left for other companies to adopt.
    expect(await slotsOf(partner)).toEqual(["gateway_gate", `gateway_gate:${a.tenant.organizationId}`]);
    expect(gateModule.loadGateState(partner, a.tenant.organizationId)).toEqual(gateModule.loadGateState(partner));
  });

  it("keeps the grace window when the gateway cannot be reached at the moment of the first check", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("a")));
    const settings = { ...settingsStore.loadSettings(a.tenant), openaiApiKey: keyFor("a") };

    const gate = await gateModule.runGatewayCheck(settings, { tenant: a.tenant, envRuntime: undefined, fetchImpl: down });

    // Not a verdict on the key, so the last time it was known good still counts: open, on grace.
    expect(gate).toMatchObject({ status: "unreachable", allowed: true, grace: true });
    expect(gate.lastOkAt).not.toBeNull();
  });

  it("never adopts a verdict that judged a different key", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("old")));
    settingsStore.saveSettings({ openaiApiKey: keyFor("new") }, a.tenant);

    const reported = gateModule.reportGatewayGate(settingsStore.loadSettings(a.tenant), {
      tenant: a.tenant,
      envRuntime: undefined,
    });
    expect(reported).toMatchObject({ allowed: false, lastOkAt: null });
    expect(await slotsOf(partner)).toEqual(["gateway_gate"]);

    const settings = { ...settingsStore.loadSettings(a.tenant), openaiApiKey: keyFor("new") };
    const checked = await gateModule.runGatewayCheck(settings, { tenant: a.tenant, envRuntime: undefined, fetchImpl: down });
    // The new key has no history to stand on: closed, no grace, exactly as a company with no old row.
    expect(checked).toMatchObject({ status: "unreachable", allowed: false, grace: false, lastOkAt: null });
  });

  it("is by key, not by company: one partner row serves the company that holds that key and no other", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("a")));
    settingsStore.saveSettings({ openaiApiKey: keyFor("a") }, a.tenant);
    settingsStore.saveSettings({ openaiApiKey: keyFor("b") }, b.tenant);

    const asked = (company: Company) =>
      gateModule.reportGatewayGate(settingsStore.loadSettings(company.tenant), {
        tenant: company.tenant,
        envRuntime: undefined,
      });

    expect(asked(a)).toMatchObject({ status: "ok", allowed: true });
    expect(asked(b)).toMatchObject({ allowed: false });
    expect(await slotsOf(partner)).toEqual(["gateway_gate", `gateway_gate:${a.tenant.organizationId}`]);
  });

  it("carries a rejection for the same key over as well: a rejected key stays rejected", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("a"), "invalid_key"));
    settingsStore.saveSettings({ openaiApiKey: keyFor("a") }, a.tenant);

    expect(
      gateModule.reportGatewayGate(settingsStore.loadSettings(a.tenant), { tenant: a.tenant, envRuntime: undefined }),
    ).toMatchObject({ status: "invalid_key", allowed: false });
  });

  it("starts no live check for a company that adopted a fresh verdict", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    gateModule.saveGateState(partner, await partnerVerdict(keyFor("a")));
    settingsStore.saveSettings({ openaiApiKey: keyFor("a") }, a.tenant);
    const runCheck = async () => undefined;

    expect(
      gateModule.maybeRefreshGateway(settingsStore.loadSettings(a.tenant), { tenant: a.tenant, runCheck }),
    ).toBe(false);
  });

  it("Personal: a desk never touches the tenant_state slots, and reads its file as it always did", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const desk = { tenantId: "local-tenant", workspaceId: "home", organizationId: "any-org" };
    const settings = { openaiApiKey: keyFor("desk"), openaiBaseUrl: "https://gateway.example/v1" };
    gateModule.clearGateState(desk);
    try {
      // No file: a desk opens on trust, as ever, and writes nothing to the database while asking.
      expect(gateModule.reportGatewayGate(settings, { tenant: desk, envRuntime: undefined })).toMatchObject({
        status: "ok",
        allowed: true,
        grace: true,
      });
      expect(await slotsOf("local-tenant")).toEqual([]);
    } finally {
      gateModule.clearGateState(desk);
    }
  });
});

/**
 * SR-163, review round. The organisation id is already canonical (the database's own), so the slot is built
 * from it as it is. Trimming it first could merge two ids that differ only by whitespace into one verdict.
 */
describe("the company id is used exactly as it is", () => {
  const verdict = (status: "ok" | "invalid_key") => ({
    version: 1 as const,
    fingerprint: "fp",
    status,
    checkedAt: new Date(T0).toISOString(),
    lastOkAt: status === "ok" ? new Date(T0).toISOString() : null,
  });

  it("keeps two organisation ids that differ only by whitespace in two slots", async () => {
    const partner = freshPartner();
    await provision(partner, "a"); // the partner's row has to exist for the verdicts to be stored

    gateModule.saveGateState(partner, verdict("ok"), "org-ws");
    gateModule.saveGateState(partner, verdict("invalid_key"), " org-ws ");

    expect(gateModule.loadGateState(partner, "org-ws")?.status).toBe("ok");
    expect(gateModule.loadGateState(partner, " org-ws ")?.status).toBe("invalid_key");
  });

  it("reads the slot of the id it was given, never of its trimmed spelling", async () => {
    const partner = freshPartner();
    await provision(partner, "a");
    const key = keyFor("ws");
    const fingerprint = (await import("@agentforge/core")).keyFingerprintOrNull(key);
    gateModule.saveGateState(partner, { ...verdict("ok"), fingerprint }, "org-ws");
    const askedAs = (organizationId: string) =>
      gateModule.reportGatewayGate(
        { openaiApiKey: key },
        { tenant: { tenantId: partner, workspaceId: "w", organizationId }, envRuntime: undefined },
      );

    expect(askedAs("org-ws")).toMatchObject({ status: "ok", allowed: true });
    // Another company's id (it only looks the same once trimmed) has no verdict of its own, and on the
    // hosted server no verdict for the key is a closed gate.
    expect(askedAs(" org-ws ")).toMatchObject({ allowed: false });
  });
});

/**
 * SR-163, review round. The model-list cache and its probe were per partner: company A's Settings showed
 * company B's probe error and model list. They are per company now (`model-cache.ts`), and this is the
 * route-level proof, through the real Settings and Models routes.
 */
describe("two companies under one partner: each Settings shows its own probe and models", () => {
  type ProbeBody = { openaiCount: number; totalCount: number; openaiError?: string };

  it("shows company A its own catalogue and no probe error while company B's key is rejected", async () => {
    const partner = freshPartner();
    const a = await provision(partner, "a");
    const b = await provision(partner, "b");
    gatewayAnswers.set(keyFor("a"), 200);
    gatewayAnswers.set(keyFor("b"), 401);
    gatewayModels.set(keyFor("a"), ["a-only-chat-model"]);

    await saveKey(a, keyFor("a"));
    await saveKey(b, keyFor("b")); // the last save, which used to overwrite the partner's one cache

    const probeA = (await json<{ probe: ProbeBody }>(a, "GET", "/api/v1/settings")).probe;
    const probeB = (await json<{ probe: ProbeBody }>(b, "GET", "/api/v1/settings")).probe;
    expect(probeA.openaiError).toBeUndefined();
    expect(probeA.openaiCount).toBeGreaterThan(0);
    expect(probeB.openaiError).toBeTruthy();
    expect(probeB.openaiCount).toBe(0);

    const modelsOf = async (company: Company) =>
      (await json<{ models: Array<{ id: string }> }>(company, "GET", "/api/v1/models")).models.map((m) => m.id);
    expect(await modelsOf(a)).toContain("a-only-chat-model");
    expect(await modelsOf(b)).not.toContain("a-only-chat-model");
  });
});

describe("Personal: server mode off, a key saved on one desk stays on that desk", () => {
  const LOCAL = "local-tenant";

  beforeEach(() => {
    delete process.env.AGENTFORGE_SERVER;
  });

  afterEach(() => {
    settingsStore.clearGatewayKeyEverywhere();
    gateModule.clearGateState({ tenantId: LOCAL, workspaceId: "home" });
  });

  it("does not mirror the key onto the owner's other desks", async () => {
    const desk = async (method: string, path: string, body?: unknown, workspaceId?: string) => {
      const result = await dispatch(
        {
          method,
          path,
          query: {},
          params: {},
          headers: {},
          ...(workspaceId ? { workspaceId } : {}),
          ...(body === undefined ? {} : { body }),
        },
        { serverMode: false },
      );
      return (result as HostJsonResult).body as Record<string, unknown>;
    };
    gatewayAnswers.set(keyFor("p0"), 200);
    gatewayAnswers.set(keyFor("p1"), 200);

    await desk("POST", "/api/v1/settings", { openaiApiKey: keyFor("p0") });
    const first = (await desk("GET", "/api/v1/workspaces")) as { currentWorkspaceId: string };
    const made = (await desk("POST", "/api/v1/workspaces", { name: "Second desk" })) as { workspace: { id: string } };
    const second = made.workspace.id;
    // The new desk took the key at creation, exactly as before.
    expect(settingsStore.loadSettings({ tenantId: LOCAL, workspaceId: second }).openaiApiKey).toBe(keyFor("p0"));

    await desk("POST", "/api/v1/settings", { openaiApiKey: keyFor("p1") }, second);

    expect(settingsStore.loadSettings({ tenantId: LOCAL, workspaceId: second }).openaiApiKey).toBe(keyFor("p1"));
    // The first desk is still on the key it had: a desk saves for itself.
    expect(settingsStore.loadSettings({ tenantId: LOCAL, workspaceId: first.currentWorkspaceId }).openaiApiKey).toBe(
      keyFor("p0"),
    );
  });
});

describe("Personal: server mode off, the verdict is the file it always was", () => {
  const LOCAL = "local-tenant";
  const desk = { tenantId: LOCAL, workspaceId: "home" };

  beforeEach(() => {
    delete process.env.AGENTFORGE_SERVER;
    gateModule.clearGateState(desk);
  });

  afterEach(() => {
    gateModule.clearGateState(desk);
    vi.useRealTimers();
  });

  it("writes the same bytes to the same path whichever organisation the scope names", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T09:00:00.000Z"));
    const settings = { openaiApiKey: keyFor("desk"), openaiBaseUrl: "https://gateway.example/v1" };
    gatewayAnswers.set(keyFor("desk"), 200);
    const fingerprint = (await import("@agentforge/core")).keyFingerprintOrNull(keyFor("desk"));
    const path = join(dataDir, "gateway-gate.json");
    const expected = `${JSON.stringify(
      {
        version: 1,
        fingerprint,
        status: "ok",
        checkedAt: "2026-10-07T09:00:00.000Z",
        lastOkAt: "2026-10-07T09:00:00.000Z",
      },
      null,
      2,
    )}\n`;

    for (const scope of [desk, { ...desk, organizationId: "any-org" }, { ...desk, organizationId: "another-org" }]) {
      gateModule.clearGateState(desk);
      const verdict = await gateModule.runGatewayCheck(settings, {
        tenant: scope,
        envRuntime: undefined,
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      });
      expect(verdict).toMatchObject({ status: "ok", allowed: true, grace: false });
      expect(readFileSync(path, "utf8")).toBe(expected);
    }
    expect(gateModule.loadGateState(LOCAL)).toMatchObject({ version: 1, status: "ok", fingerprint });
  });

  it("keeps a non-local desk's verdict in its own file under tenants/, with no company in it", async () => {
    const other = { tenantId: "desk-partner", workspaceId: "w1", organizationId: "org-on-a-desk" };
    const settings = { openaiApiKey: keyFor("other"), openaiBaseUrl: "https://gateway.example/v1" };
    await gateModule.runGatewayCheck(settings, {
      tenant: other,
      envRuntime: undefined,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const file = join(dataDir, "tenants", "desk-partner", "gateway-gate.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["checkedAt", "fingerprint", "lastOkAt", "status", "version"]);
    gateModule.clearGateState(other);
    expect(existsSync(file)).toBe(false);
  });

  it("opens on trust when the file is missing, exactly as before, and never reads an organisation", () => {
    const settings = { openaiApiKey: keyFor("desk"), openaiBaseUrl: "https://gateway.example/v1" };
    const now = new Date("2026-10-07T09:00:00.000Z");
    const expected = {
      status: "ok",
      allowed: true,
      grace: true,
      // Pinned: a stored `openaiBaseUrl` is never the endpoint (`gatewayEndpointFor`).
      endpoint: gateModule.gatewayEndpointFor(settings),
      endpointLocked: true,
      checkedAt: null,
      lastOkAt: null,
      message: "Not checked yet.",
    };

    expect(existsSync(join(dataDir, "gateway-gate.json"))).toBe(false);
    expect(gateModule.reportGatewayGate(settings, { tenant: desk, envRuntime: undefined, now })).toEqual(expected);
    expect(
      gateModule.reportGatewayGate(settings, {
        tenant: { ...desk, organizationId: "any-org" },
        envRuntime: undefined,
        now,
      }),
    ).toEqual(expected);
    expect(() =>
      gateModule.requireGatewayAllowed(settings, { tenant: desk, envRuntime: undefined, now }),
    ).not.toThrow();
  });

  it("throttles a background re-check per key, across desks, as it always did", () => {
    const settings = { openaiApiKey: keyFor("desk"), openaiBaseUrl: "https://gateway.example/v1" };
    gateModule.resetGatewayRefreshThrottle();
    const runCheck = async () => undefined;
    const first = gateModule.maybeRefreshGateway(settings, { tenant: desk, envRuntime: undefined, runCheck });
    const second = gateModule.maybeRefreshGateway(settings, {
      tenant: { tenantId: LOCAL, workspaceId: "second-desk" },
      envRuntime: undefined,
      runCheck,
    });
    expect([first, second]).toEqual([true, false]);
  });
});
