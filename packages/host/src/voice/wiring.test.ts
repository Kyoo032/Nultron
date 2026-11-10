/**
 * `createVoiceModels`: which key the talker and the transcriber are opened with. A Chat turn reads
 * `resolveProviderKeys(loadSettings(tenant))`; voice must read the same call, on a desk and on the
 * hosted server. `fetch` is replaced, so nothing here reaches a gateway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT_ID, resolvedGatewayBaseUrl, type TenantContext } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-voice-wiring-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
/** Server mode demands a real wrap key. Generated, not typed. */
process.env.AGENTFORGE_SECRETS_KEY = "7b1d0c9e42a5f38614bd7c02e9f5a831d64c7fe20b93a15c8e7d4620fa31c95b";
delete process.env.AGENTFORGE_SERVER;
delete process.env.OPENAI_API_KEY;

const settingsStore = await import("../settings-store");
const stateStore = await import("../tenant-state-store");
const { createVoiceModels } = await import("./wiring");
const { resetTalkerCachesForTests } = await import("./talker-omni-http");

const DESK_KEY = "voice-wiring-desk-key-0001";
const ENV_KEY = "voice-wiring-env-key-0002";
const OPERATOR_KEY = "voice-wiring-operator-key-0003";
const KEY_A = "voice-wiring-company-a-0004";
const KEY_B = "voice-wiring-company-b-0005";

/** A desk that has saved nothing: every case names its own, because a desk keeps its key in a file. */
let deskCount = 0;
function freshDesk(): TenantContext {
  deskCount += 1;
  return { tenantId: LOCAL_TENANT_ID, organizationId: "org-local", workspaceId: `desk-voice-${deskCount}`, userId: "user-local", role: "owner" };
}
const A: TenantContext = { tenantId: "tenant-alpha", organizationId: "org-alpha", workspaceId: "desk-a", userId: "user-a1", role: "owner" };
const B: TenantContext = { tenantId: "tenant-beta", organizationId: "org-beta", workspaceId: "desk-b", userId: "user-b1", role: "owner" };
const C: TenantContext = { tenantId: "tenant-gamma", organizationId: "org-gamma", workspaceId: "desk-c", userId: "user-c1", role: "owner" };

type Seen = { url: string; authorization: string | null };

let sqlite: Database.Database;
let seen: Seen[] = [];

/** One answer for every call: an event stream with no words, or the transcript for the transcriber. */
function fakeFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: "hello" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

/** Makes both models call the gateway once each, so the headers they were opened with are on record. */
async function touch(models: NonNullable<ReturnType<typeof createVoiceModels>>): Promise<void> {
  const signal = new AbortController().signal;
  await models.transcriber.transcribe(Buffer.alloc(9_600), { locale: "en", signal });
  const session = models.talker.open({ locale: "en", history: [] });
  await session.hearShort(Buffer.alloc(9_600), signal);
  session.close();
}

function seedTenant(tenantId: string): void {
  sqlite
    .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(tenantId, tenantId, tenantId, "active", Date.now());
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  for (const tenantId of [A.tenantId, B.tenantId, C.tenantId, LOCAL_TENANT_ID]) seedTenant(tenantId);
  stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
  stateStore.resetTenantStateAdoptionForTests();
  settingsStore.resetSettingsCacheForTests();
  resetTalkerCachesForTests();
  seen = [];
  vi.stubGlobal("fetch", fakeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_RUNTIME;
  delete process.env.OPENAI_API_KEY;
  stateStore.resetTenantStateSqlForTests();
  settingsStore.resetSettingsCacheForTests();
  resetTalkerCachesForTests();
  sqlite.close();
});

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows holds the desk database open until the worker exits; the temp folder is cleaned later.
  }
});

describe("createVoiceModels on a desk", () => {
  it("opens both models with the key saved on this desk, at the pinned gateway", async () => {
    process.env.AGENTFORGE_RUNTIME = "ai";
    const desk = freshDesk();
    settingsStore.saveSettings({ openaiApiKey: DESK_KEY }, desk);
    const models = createVoiceModels(desk, "qwen3.5-omni-flash");
    expect(models).not.toBeNull();
    if (!models) return;
    expect(models.talker.model).toBe("qwen3.5-omni-flash");
    await touch(models);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((call) => call.authorization === `Bearer ${DESK_KEY}`)).toBe(true);
    expect(seen.every((call) => call.url.startsWith(resolvedGatewayBaseUrl()))).toBe(true);
    expect(seen.some((call) => call.url.endsWith("/audio/transcriptions"))).toBe(true);
    expect(seen.some((call) => call.url.endsWith("/chat/completions"))).toBe(true);
  });

  it("falls back to OPENAI_API_KEY on a desk that asked for the live runtime, as a Chat turn does", async () => {
    process.env.AGENTFORGE_RUNTIME = "ai";
    process.env.OPENAI_API_KEY = ENV_KEY;
    const desk = freshDesk();
    const models = createVoiceModels(desk, "qwen3.5-omni-flash");
    expect(models).not.toBeNull();
    if (!models) return;
    await touch(models);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((call) => call.authorization === `Bearer ${ENV_KEY}`)).toBe(true);
  });

  it("has no models without a key, and none on the stub runtime even with a stray environment key", () => {
    const desk = freshDesk();
    process.env.AGENTFORGE_RUNTIME = "ai";
    expect(createVoiceModels(desk, "qwen3.5-omni-flash")).toBeNull();
    process.env.AGENTFORGE_RUNTIME = "stub";
    process.env.OPENAI_API_KEY = ENV_KEY;
    expect(createVoiceModels(desk, "qwen3.5-omni-flash")).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("createVoiceModels on the hosted server", () => {
  it("opens each company's models with that company's own key", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_RUNTIME = "ai";
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    settingsStore.saveSettings({ openaiApiKey: KEY_B }, B);
    const first = createVoiceModels(A, "qwen3.5-omni-flash");
    const second = createVoiceModels(B, "qwen3.5-omni-flash");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;
    await touch(first);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((call) => call.authorization === `Bearer ${KEY_A}`)).toBe(true);
    seen = [];
    resetTalkerCachesForTests();
    await touch(second);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((call) => call.authorization === `Bearer ${KEY_B}`)).toBe(true);
  });

  it("never hands a tenant with no key of its own the operator's key", () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_RUNTIME = "ai";
    process.env.OPENAI_API_KEY = OPERATOR_KEY;
    settingsStore.saveSettings({ openaiApiKey: KEY_A }, A);
    expect(createVoiceModels(C, "qwen3.5-omni-flash")).toBeNull();
    expect(seen).toEqual([]);
  });
});
