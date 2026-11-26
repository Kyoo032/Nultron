/**
 * Two coworkers of one company can share an operator-assigned endpoint while the portal issued
 * them different keys. Their verdicts and model catalogues must never be adopted across keys:
 * the slots under `company:ep:<tag>` carry the issued key's fingerprint, and "forget my key"
 * clears exactly the slot today's writes land on (review round on DFIND-155).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyFingerprintOrNull, LOCAL_TENANT_ID, type ChatModel } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-endpoint-key-isolation-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SECRETS_KEY = "6b1d9f3a7c5e4082b4a6c8e0d2f19357a3c5e7b9d1f40628d0a2c4e6f8b19a75";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
delete process.env.OPENAI_API_KEY;

const modelCache = await import("./model-cache");
const gate = await import("./gateway-gate");
const stateStore = await import("./tenant-state-store");

const PARTNER = "partner-keys";
const ORG = "org-keys";
const ENDPOINT = "https://www.pusattokenai.com/v1";
const KEY_ONE = "sk-issued-for-coworker-one";
const KEY_TWO = "sk-issued-for-coworker-two";

const model = (id: string): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text"] });

const scopeFor = (key: string) => ({
  tenantId: PARTNER,
  organizationId: ORG,
  workspaceId: `desk-${key}`,
  gatewayEndpoint: ENDPOINT,
  gatewayEndpointKey: key,
});

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  for (const tenantId of [PARTNER, LOCAL_TENANT_ID]) {
    sqlite
      .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, tenantId, tenantId, "active", Date.now());
  }
  stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
  stateStore.resetTenantStateAdoptionForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("one endpoint, two issued keys", () => {
  it("keeps each coworker's model catalogue under her own key's fingerprint", () => {
    const one = scopeFor(KEY_ONE);
    const two = scopeFor(KEY_TWO);
    expect(modelCache.modelCacheSlot(one)).not.toBe(modelCache.modelCacheSlot(two));

    modelCache.saveModelCache({ openai: [model("alpha-for-one")], keyId: keyFingerprintOrNull(KEY_ONE) ?? undefined }, one);
    modelCache.saveModelCache({ openai: [model("beta-for-two")], keyId: keyFingerprintOrNull(KEY_TWO) ?? undefined }, two);
    expect(modelCache.loadModelCache(one).openai?.[0]?.id).toBe("alpha-for-one");
    expect(modelCache.loadModelCache(two).openai?.[0]?.id).toBe("beta-for-two");
  });

  it("keeps each coworker's gateway verdict under her own key's fingerprint", () => {
    const one = scopeFor(KEY_ONE);
    const ok = {
      version: 1 as const,
      fingerprint: keyFingerprintOrNull(KEY_ONE),
      endpoint: ENDPOINT,
      status: "ok" as const,
      checkedAt: "2026-11-26T00:00:00.000Z",
      lastOkAt: "2026-11-26T00:00:00.000Z",
    };
    gate.saveGateState(PARTNER, ok, ORG, ENDPOINT);
    expect(gate.loadGateState(PARTNER, ORG, ENDPOINT, keyFingerprintOrNull(KEY_ONE))).not.toBeNull();
    // Coworker two's key was never judged: the slot one wrote is not hers to read.
    expect(gate.loadGateState(PARTNER, ORG, ENDPOINT, keyFingerprintOrNull(KEY_TWO))).toBeNull();
  });

  it("'forget my key' drops the verdict saved under the key's fingerprint", () => {
    const one = scopeFor(KEY_ONE);
    const fingerprint = keyFingerprintOrNull(KEY_ONE);
    gate.saveGateState(
      PARTNER,
      {
        version: 1,
        fingerprint,
        endpoint: ENDPOINT,
        status: "ok",
        checkedAt: "2026-11-26T00:00:00.000Z",
        lastOkAt: "2026-11-26T00:00:00.000Z",
      },
      ORG,
      ENDPOINT,
    );
    expect(gate.loadGateState(PARTNER, ORG, ENDPOINT, fingerprint)).not.toBeNull();

    gate.clearGateState(one);
    expect(gate.loadGateState(PARTNER, ORG, ENDPOINT, fingerprint)).toBeNull();
  });
});
