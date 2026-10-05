/**
 * "Add the key later": `POST /api/v1/settings/key-later` records that this person chose to start
 * without a gateway key, `GET /api/v1/settings` carries it as `keyLater`, and it lives in the sealed
 * settings payload beside the language and the first-run guide's record.
 *
 * **Enterprise only.** The Personal app has no such door: a closed gate there is onboarding's key
 * step and nothing else. So off server mode the route does not exist (404, the answer an
 * unregistered path gets) and the settings answer carries no `keyLater` at all. The switch is
 * injected, like the reset and key-save suites in `settings.test.ts`: flipping `AGENTFORGE_SERVER`
 * in this process would put the router's session gate in front of every call.
 *
 * The record is a preference about what the SCREEN shows. It must never be read as a decision about
 * what the host allows: the gate stays closed after it is written, and every gateway-calling route
 * still answers the flat `403 gateway_blocked`. That half is pinned here too.
 *
 * Real router, real sealed store, throwaway data dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-key-later-handler-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
// Outside the stub runtime, the way a hosted tenant with no key runs: a CLOSED gate is the state the
// choice has to be recordable in.
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type Dispatch = (request: HostRequest) => Promise<HostResult>;
let dispatch: Dispatch;
let store: typeof import("../settings-store");

const HOSTED = { isServerMode: () => true };
const DESK = { isServerMode: () => false };

type KeyLaterView = { chosen: boolean; at: number | null };

type Answer = {
  keyLater?: KeyLaterView;
  guide: { seen: boolean };
  gateway: { allowed: boolean; status: string };
  error: unknown;
  status: string;
  savedLocale: string;
};

type Response = { status: number; body: Answer };

function request(method: string, path: string, body?: unknown): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, body };
}

function asResponse(result: HostResult): Response {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Answer };
}

/** Through the real router: desk mode, so what a Personal app would see. */
async function viaRouter(method: string, path: string, body?: unknown): Promise<Response> {
  return asResponse(await dispatch(request(method, path, body)));
}

async function chooseLater(deps: { isServerMode: () => boolean }, body?: unknown): Promise<Response> {
  const { handlePostKeyLater } = await import("./key-later");
  return asResponse(await handlePostKeyLater(request("POST", "/api/v1/settings/key-later", body), deps));
}

async function readSettings(deps: { isServerMode: () => boolean }): Promise<Response> {
  const { handleGetSettings } = await import("./settings");
  return asResponse(await handleGetSettings(request("GET", "/api/v1/settings"), deps));
}

async function keyLater(): Promise<KeyLaterView | undefined> {
  const answer = await readSettings(HOSTED);
  expect(answer.status).toBe(200);
  return answer.body.keyLater;
}

beforeAll(async () => {
  ({ dispatch } = await import("../router"));
  store = await import("../settings-store");
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the add-it-later record, hosted", () => {
  it("is not chosen on a fresh tenant", async () => {
    expect(await keyLater()).toEqual({ chosen: false, at: null });
  });

  it("records the choice, answers with it, and GET settings reports it", async () => {
    const before = Date.now();
    const recorded = await chooseLater(HOSTED);

    expect(recorded.status).toBe(200);
    expect(recorded.body.keyLater?.chosen).toBe(true);
    expect(recorded.body.keyLater?.at).toBeGreaterThanOrEqual(before);
    expect(await keyLater()).toEqual(recorded.body.keyLater);
  });

  it("survives a cold read of the sealed file, not just a warm cache", async () => {
    await chooseLater(HOSTED);
    store.resetSettingsCacheForTests();

    expect((await keyLater())?.chosen).toBe(true);
  });

  it("takes the time from the host: a body cannot set it, or anything else", async () => {
    const before = Date.now();
    const answer = await chooseLater(HOSTED, { at: 5, chosen: false, openaiApiKey: "sk-nope" });

    expect(answer.status).toBe(200);
    expect(answer.body.keyLater?.chosen).toBe(true);
    expect(answer.body.keyLater?.at).toBeGreaterThanOrEqual(before);
    // The body's key went nowhere: the gate below is still closed for want of one.
    expect((await readSettings(HOSTED)).body.gateway.status).toBe("needs_key");
  });
});

describe("the Personal app is untouched", () => {
  it("has no such route: the router answers 404 and records nothing", async () => {
    const answer = await viaRouter("POST", "/api/v1/settings/key-later");

    expect(answer.status).toBe(404);
    expect(answer.body.error).toMatchObject({ code: "not_found" });
  });

  it("answers 404 from the handler itself when the switch says desk", async () => {
    const answer = await chooseLater(DESK);

    expect(answer.status).toBe(404);
    expect(answer.body.error).toMatchObject({ code: "not_found" });
  });

  it("leaves `keyLater` out of the settings answer, so the payload is the one it always was", async () => {
    // Even after a hosted-mode write: the field is a hosted fact, and off that mode nobody reads it.
    await chooseLater(HOSTED);

    const fromRouter = await viaRouter("GET", "/api/v1/settings");
    const fromDesk = await readSettings(DESK);

    expect(fromRouter.status).toBe(200);
    expect(fromRouter.body).not.toHaveProperty("keyLater");
    expect(fromDesk.body).not.toHaveProperty("keyLater");
  });
});

describe("the choice is a preference, never a decision the host honours", () => {
  it("leaves the gate closed: the host still says needs_key and allowed false", async () => {
    await chooseLater(HOSTED);
    const settings = await readSettings(HOSTED);

    expect(settings.body.gateway.allowed).toBe(false);
    expect(settings.body.gateway.status).toBe("needs_key");
  });

  it("does not loosen a single gateway-calling route: it still answers the flat 403 gateway_blocked", async () => {
    await chooseLater(HOSTED);
    // The cheapest route that reaches the gateway and gates on entry (see settings.test.ts).
    const blocked = await viaRouter("GET", "/api/v1/knowledge/context");

    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("gateway_blocked");
    expect(blocked.body.status).toBe("needs_key");
  });

  it("is itself open on a closed gate: choosing to wait for a key needs no key", async () => {
    const settings = await readSettings(HOSTED);
    expect(settings.body.gateway.allowed).toBe(false);

    expect((await chooseLater(HOSTED)).status).toBe(200);
  });
});

describe("what leaves it alone", () => {
  it("is not wiped by a language save, and does not change the language or the guide", async () => {
    await chooseLater(HOSTED);

    const { handlePostSettings } = await import("./settings");
    const saved = asResponse(
      await handlePostSettings(request("POST", "/api/v1/settings", { locale: "id" }), HOSTED),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.keyLater?.chosen).toBe(true);
    expect(saved.body.savedLocale).toBe("id");
    expect(saved.body.guide.seen).toBe(false);
    await handlePostSettings(request("POST", "/api/v1/settings", { locale: "en" }), HOSTED);
  });

  it("is not wiped by signing out of the gateway: forgetting a key is not a fresh start", async () => {
    await chooseLater(HOSTED);
    const signedOut = await viaRouter("POST", "/api/v1/settings/reset", { scope: "key" });

    expect(signedOut.status).toBe(200);
    expect((await keyLater())?.chosen).toBe(true);
  });
});

describe("the record is per person, never inherited", () => {
  const tenantId = "tenant-key-later";
  const alice = { tenantId, workspaceId: "desk-1", userId: "alice" };
  const bob = { tenantId, workspaceId: "desk-1", userId: "bob" };

  it("gives one user's choice to that user only", () => {
    expect(store.loadUserKeyLater(alice)).toBeNull();

    store.saveUserKeyLater(alice, 1_790_000_000_000);

    expect(store.loadUserKeyLater(alice)).toEqual({ at: 1_790_000_000_000 });
    expect(store.loadUserKeyLater(bob)).toBeNull();
  });

  it("keeps both people's choices, languages and guide records apart in the one sealed payload", () => {
    store.saveUserLocale(alice, "id");
    store.saveUserGuide(bob, "skipped", 5);
    store.saveUserKeyLater(bob, 7);
    store.saveUserKeyLater(alice, 8);
    store.resetSettingsCacheForTests();

    expect(store.loadUserKeyLater(alice)).toEqual({ at: 8 });
    expect(store.loadUserKeyLater(bob)).toEqual({ at: 7 });
    expect(store.loadUserGuide(bob)).toEqual({ outcome: "skipped", at: 5 });
    expect(store.loadUserLocale(alice)).toBe("id");
  });

  it("refuses to record for a caller with no user id, and reads nothing for one", () => {
    expect(() => store.saveUserKeyLater({ tenantId, workspaceId: "desk-1", userId: "  " })).toThrow(/signed-in user/);
    expect(store.loadUserKeyLater({ tenantId, workspaceId: "desk-1", userId: "" })).toBeNull();
  });

  it("drops an unreadable record instead of reading it as a choice", async () => {
    const { parseKeyLaterRecord } = await import("../key-later");
    for (const bad of [null, undefined, "yes", 5, [], {}, { at: "now" }, { at: -1 }, { at: Number.NaN }]) {
      expect(parseKeyLaterRecord(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseKeyLaterRecord({ at: 12 })).toEqual({ at: 12 });
  });
});
