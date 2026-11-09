import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { encryptJson, wrappingKeyFromSecret } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { SERVER_VAULT_KEY_TOO_WEAK } from "@agentforge/db/vault-key";
import {
  loadSettings,
  saveSettings,
  adoptLegacySettings,
  dropWorkspaceSettings,
  loadOwnerLocale,
  saveOwnerLocale,
  clearGatewayKeyEverywhere,
} from "./settings-store";
import {
  registerTenantStateSql,
  resetTenantStateAdoptionForTests,
  resetTenantStateSqlForTests,
} from "./tenant-state-store";

const SECRET = "a".repeat(64);
const PLAIN_KEY = "sk-test-plaintext-should-not-appear";

describe("settings-store", () => {
  let dir: string;
  let previousPath: string | undefined;
  let previousKey: string | undefined;
  let previousServer: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "af-settings-"));
    previousPath = process.env.AGENTFORGE_SETTINGS_PATH;
    previousKey = process.env.AGENTFORGE_SECRETS_KEY;
    previousServer = process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_SETTINGS_PATH = dir;
    process.env.AGENTFORGE_SECRETS_KEY = SECRET;
  });

  afterEach(() => {
    if (previousPath === undefined) {
      delete process.env.AGENTFORGE_SETTINGS_PATH;
    } else {
      process.env.AGENTFORGE_SETTINGS_PATH = previousPath;
    }
    if (previousKey === undefined) {
      delete process.env.AGENTFORGE_SECRETS_KEY;
    } else {
      process.env.AGENTFORGE_SECRETS_KEY = previousKey;
    }
    if (previousServer === undefined) {
      delete process.env.AGENTFORGE_SERVER;
    } else {
      process.env.AGENTFORGE_SERVER = previousServer;
    }
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes settings.enc that is not raw openaiApiKey plaintext", () => {
    const saved = saveSettings({ openaiApiKey: PLAIN_KEY });
    expect(saved.openaiApiKey).toBe(PLAIN_KEY);

    const encPath = join(dir, "settings.enc");
    expect(existsSync(encPath)).toBe(true);
    const raw = readFileSync(encPath, "utf8");
    expect(raw).not.toContain("openaiApiKey");
    expect(raw).not.toContain(PLAIN_KEY);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);

    expect(loadSettings().openaiApiKey).toBe(PLAIN_KEY);
  });

  it("migrates legacy settings.json into settings.enc", () => {
    writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ openaiApiKey: PLAIN_KEY })}\n`, "utf8");
    const loaded = loadSettings();
    expect(loaded.openaiApiKey).toBe(PLAIN_KEY);
    const raw = readFileSync(join(dir, "settings.enc"), "utf8");
    expect(raw).not.toContain(PLAIN_KEY);
    expect(raw).not.toContain("openaiApiKey");
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  });

  it("returns empty settings when settings.enc cannot be decrypted with the current wrap key", () => {
    const envelope = encryptJson({ openaiApiKey: PLAIN_KEY }, wrappingKeyFromSecret(SECRET));
    writeFileSync(join(dir, "settings.enc"), `${JSON.stringify(envelope)}\n`, "utf8");
    process.env.AGENTFORGE_SECRETS_KEY = "b".repeat(64);

    const loaded = loadSettings();
    expect(loaded.openaiApiKey).toBeUndefined();
    expect(existsSync(join(dir, "settings.enc"))).toBe(false);
    expect(existsSync(join(dir, "settings.enc.unreadable"))).toBe(true);
    expect(readFileSync(join(dir, "settings.enc.unreadable"), "utf8")).not.toContain(PLAIN_KEY);
  });

  it("opens settings.enc sealed under a short AGENTFORGE_SECRETS_KEY on a desk, warns, and keeps saving", () => {
    const encPath = join(dir, "settings.enc");
    const short = "short-pass";
    const envelope = encryptJson({ openaiApiKey: PLAIN_KEY }, wrappingKeyFromSecret(short));
    writeFileSync(encPath, `${JSON.stringify(envelope)}\n`, "utf8");
    process.env.AGENTFORGE_SECRETS_KEY = short;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadSettings().openaiApiKey).toBe(PLAIN_KEY);
    saveSettings({ openaiApiKey: "sk-after-warning" });
    expect(loadSettings().openaiApiKey).toBe("sk-after-warning");
    expect(existsSync(`${encPath}.unreadable`)).toBe(false);
    expect(readFileSync(encPath, "utf8")).not.toContain("sk-after-warning");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(short);
    }
  });

  describe("in server mode", () => {
    let sqlite: Database.Database;
    const scope = { tenantId: "local-tenant", workspaceId: "ws-home" };

    function seed(value: string) {
      sqlite
        .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(scope.tenantId, scope.tenantId, scope.tenantId, "active", Date.now());
      sqlite
        .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'settings', ?, ?)")
        .run(scope.tenantId, value, Date.now());
    }

    function stored(): string {
      return (
        sqlite.prepare("SELECT value FROM tenant_state WHERE tenant_id = ?").get(scope.tenantId) as { value: string }
      ).value;
    }

    beforeEach(() => {
      sqlite = new Database(":memory:");
      ensureSchema(sqlite);
      registerTenantStateSql(sqlite as unknown as Parameters<typeof registerTenantStateSql>[0]);
      resetTenantStateAdoptionForTests();
      process.env.AGENTFORGE_SERVER = "1";
      process.env.AGENTFORGE_SECRETS_KEY = "hunter2";
    });

    afterEach(() => {
      resetTenantStateSqlForTests();
      sqlite.close();
    });

    it("still refuses a weak AGENTFORGE_SECRETS_KEY and leaves the sealed settings where they are", () => {
      seed(`${JSON.stringify(encryptJson({ openaiApiKey: PLAIN_KEY }, wrappingKeyFromSecret(SECRET)))}\n`);
      const before = stored();

      expect(() => loadSettings(scope)).toThrow(SERVER_VAULT_KEY_TOO_WEAK);
      expect(() => saveSettings({ openaiApiKey: "sk-after-refusal" }, scope)).toThrow(SERVER_VAULT_KEY_TOO_WEAK);
      expect(stored()).toBe(before);
    });

    it("refuses a weak key before it judges what is stored", () => {
      seed("not json at all");

      expect(() => loadSettings(scope)).toThrow(SERVER_VAULT_KEY_TOO_WEAK);
      expect(stored()).toBe("not json at all");
    });
  });

  it("keeps gateway keys isolated per workspace", () => {
    saveSettings({ openaiApiKey: "sk-home-desk" }, "ws-home");
    saveSettings({ openaiApiKey: "sk-legal-desk" }, "ws-legal");
    expect(loadSettings("ws-home").openaiApiKey).toBe("sk-home-desk");
    expect(loadSettings("ws-legal").openaiApiKey).toBe("sk-legal-desk");
    expect(loadSettings("ws-new").openaiApiKey).toBeUndefined();
  });

  it("adopts a pre-isolation key onto Default and leaves other desks empty", () => {
    const envelope = encryptJson({ openaiApiKey: PLAIN_KEY }, wrappingKeyFromSecret(SECRET));
    writeFileSync(join(dir, "settings.enc"), `${JSON.stringify(envelope)}\n`, "utf8");

    expect(loadSettings("ws-home").openaiApiKey).toBeUndefined();
    expect(loadSettings().openaiApiKey).toBe(PLAIN_KEY);

    adoptLegacySettings("ws-home");
    expect(loadSettings("ws-home").openaiApiKey).toBe(PLAIN_KEY);
    expect(loadSettings("ws-other").openaiApiKey).toBeUndefined();
  });

  it("drops a deleted desk's saved key", () => {
    saveSettings({ openaiApiKey: "sk-scratch" }, "ws-scratch");
    expect(loadSettings("ws-scratch").openaiApiKey).toBe("sk-scratch");
    dropWorkspaceSettings("ws-scratch");
    expect(loadSettings("ws-scratch").openaiApiKey).toBeUndefined();
  });

  it("clears the gateway key on every desk and leaves the rest of each slice alone", () => {
    saveSettings({ openaiApiKey: PLAIN_KEY, imageGenModel: "gpt-image-1" }, "ws-home");
    saveSettings({ openaiApiKey: "sk-second-desk", anthropicApiKey: "sk-ant-keepme" }, "ws-other");
    saveSettings({ imageGenModel: "gpt-image-1" }, "ws-keyless");

    const touched = clearGatewayKeyEverywhere();

    expect(touched.sort()).toEqual(["ws-home", "ws-other"]);
    expect(loadSettings("ws-home").openaiApiKey).toBeUndefined();
    expect(loadSettings("ws-other").openaiApiKey).toBeUndefined();
    expect(loadSettings("ws-home").imageGenModel).toBe("gpt-image-1");
    expect(loadSettings("ws-other").anthropicApiKey).toBe("sk-ant-keepme");
    // Nothing left to clear: a second call is a no-op, not a rewrite.
    expect(clearGatewayKeyEverywhere()).toEqual([]);
  });

  it("persists owner locale outside workspace secrets and does not put it on the key slice", () => {
    expect(loadOwnerLocale()).toBe("en");
    expect(saveOwnerLocale("id")).toBe("id");
    expect(loadOwnerLocale()).toBe("id");
    saveSettings({ openaiApiKey: "sk-home-desk" }, "ws-home");
    expect(loadOwnerLocale()).toBe("id");
    expect(loadSettings("ws-home")).not.toHaveProperty("locale");
    expect(saveOwnerLocale("en")).toBe("en");
  });
});
