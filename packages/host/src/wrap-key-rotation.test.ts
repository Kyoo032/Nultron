/**
 * Phase 4 — the wrap-key rotation drill.
 *
 * The plan's test for this phase is "a wrap-key rotation re-encrypts without data loss"
 * (`docs/internal/web-migration-plan.md`, Phase 4). Data loss here has a specific shape: a rotation
 * that gets partway through leaves some tenants sealed under the old key and some under the new
 * one, which is a state no single key can read and no second run can repair. So the cases that
 * matter most are the refusals — the ones that prove nothing was written.
 *
 * Both backends are driven, because the drill has to work on a desk (files) and on the hosted
 * server (rows), and the whole reason it can is that the stored bytes are the same in both.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson, LOCAL_TENANT_ID, wrappingKeyFromSecret } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";

const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-rotate-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
delete process.env.AGENTFORGE_SERVER;

const { rotateWrapKey, sqlSessionTokens, WrapKeyRotationError } = await import("./wrap-key-rotation");
const { openRefresh, sealRefresh } = await import("./auth/session-secrets");
const stateStore = await import("./tenant-state-store");
const { TENANTS_DIR } = await import("./tenant-paths");

const OLD_KEY = "11aa22bb33cc44dd55ee66ff7788990011aa22bb33cc44dd55ee66ff77889900";
const NEW_KEY = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";

const A = "tenant-alpha";
const B = "tenant-beta";

function payloadFor(deskId: string, apiKey: string): unknown {
  return { version: 2, workspaces: { [deskId]: { openaiApiKey: apiKey } } };
}

function sealed(payload: unknown, secret: string): string {
  return `${JSON.stringify(encryptJson(payload, wrappingKeyFromSecret(secret)))}\n`;
}

function openWith(raw: string, secret: string): unknown {
  return decryptJson<unknown>(JSON.parse(raw), wrappingKeyFromSecret(secret));
}

/* -------------------------------------------------------------------------------- file backend */

function tenantFile(tenantId: string): string {
  return tenantId === LOCAL_TENANT_ID
    ? path.join(dataDir, "settings.enc")
    : path.join(dataDir, TENANTS_DIR, tenantId, "settings.enc");
}

function writeFileState(tenantId: string, value: string): void {
  const file = tenantFile(tenantId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

function clearDataDir(): void {
  for (const entry of readdirSync(dataDir)) {
    rmSync(path.join(dataDir, entry), { recursive: true, force: true });
  }
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("rotating the file store (a desk, or a webdev instance)", () => {
  beforeEach(() => {
    clearDataDir();
  });

  it("re-seals every tenant and loses nothing", () => {
    writeFileState(LOCAL_TENANT_ID, sealed(payloadFor("home", "sk-local-key-0000"), OLD_KEY));
    writeFileState(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));
    writeFileState(B, sealed(payloadFor("desk-b", "sk-beta-key-00000"), OLD_KEY));

    const result = rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.fileTenantStateBackend });

    expect(result.backend).toBe("file");
    expect(result.rotated.sort()).toEqual([A, B, LOCAL_TENANT_ID].sort());
    expect(openWith(readFileSync(tenantFile(A), "utf8"), NEW_KEY)).toEqual(payloadFor("desk-a", "sk-alpha-key-0000"));
    expect(openWith(readFileSync(tenantFile(LOCAL_TENANT_ID), "utf8"), NEW_KEY)).toEqual(
      payloadFor("home", "sk-local-key-0000"),
    );
    // And the old key no longer opens any of them, which is the point of rotating.
    expect(() => openWith(readFileSync(tenantFile(B), "utf8"), OLD_KEY)).toThrow();
  });

  it("finds the local tenant at the install root and every other under tenants/", () => {
    writeFileState(LOCAL_TENANT_ID, sealed(payloadFor("home", "sk-local-key-0000"), OLD_KEY));
    writeFileState(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));

    // Lane D's one rule, seen from the rotation's side: the local tenant's root IS the install root,
    // so a walk that only looked under `tenants/` would silently skip the desktop owner's own key.
    expect(stateStore.fileTenantStateBackend.tenantsWith("settings").sort()).toEqual([A, LOCAL_TENANT_ID].sort());
  });

  it("writes NOTHING when one tenant will not open with the current key", () => {
    const goodA = sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY);
    const strangerB = sealed(payloadFor("desk-b", "sk-beta-key-00000"), NEW_KEY);
    writeFileState(A, goodA);
    writeFileState(B, strangerB);

    expect(() => rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.fileTenantStateBackend })).toThrow(
      WrapKeyRotationError,
    );

    // The tenant that would have rotated first is untouched: this is the two-phase commit working.
    expect(readFileSync(tenantFile(A), "utf8")).toBe(goodA);
    expect(readFileSync(tenantFile(B), "utf8")).toBe(strangerB);
  });

  it("names the tenant that would not open, and nothing about the key", () => {
    writeFileState(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), NEW_KEY));
    try {
      rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.fileTenantStateBackend });
      throw new Error("expected the rotation to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(WrapKeyRotationError);
      expect((error as InstanceType<typeof WrapKeyRotationError>).tenantId).toBe(A);
      expect((error as Error).message).not.toContain(OLD_KEY);
      expect((error as Error).message).not.toContain(NEW_KEY);
    }
  });

  it("rehearses with --dry-run and writes nothing", () => {
    const before = sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY);
    writeFileState(A, before);

    const result = rotateWrapKey({
      from: OLD_KEY,
      to: NEW_KEY,
      dryRun: true,
      backend: stateStore.fileTenantStateBackend,
    });

    expect(result).toMatchObject({ dryRun: true, rotated: [A] });
    expect(readFileSync(tenantFile(A), "utf8")).toBe(before);
  });

  it("is a no-op that reports nothing when there is nothing stored", () => {
    expect(rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.fileTenantStateBackend })).toMatchObject({
      rotated: [],
      skipped: [],
    });
  });

  it("refuses a payload that is not a sealed envelope, before writing anything", () => {
    writeFileState(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));
    writeFileState(B, "{}\n");
    expect(() => rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.fileTenantStateBackend })).toThrow(
      /not a sealed envelope/,
    );
    expect(openWith(readFileSync(tenantFile(A), "utf8"), OLD_KEY)).toBeTruthy();
  });

  it("refuses a weak or malformed key on either side", () => {
    writeFileState(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));
    const backend = stateStore.fileTenantStateBackend;
    // Too short to be a wrap key at all.
    expect(() => rotateWrapKey({ from: "abcd", to: NEW_KEY, backend })).toThrow(/current wrap key/);
    // Long enough, but typed rather than generated. Refused as the NEW key, allowed as the current
    // one: rotating AWAY from a weak key is exactly what someone would want this for.
    expect(() => rotateWrapKey({ from: OLD_KEY, to: "a".repeat(64), backend })).toThrow(/not random/);
    expect(() => rotateWrapKey({ from: "a".repeat(64), to: NEW_KEY, backend })).toThrow(
      /do not open with the current wrap key/,
    );
    // And rotating onto the same key is a mistake, not a no-op.
    expect(() => rotateWrapKey({ from: OLD_KEY, to: OLD_KEY, backend })).toThrow(/same as the current one/);
  });
});

/* ---------------------------------------------------------------------------------- row backend */

describe("rotating the hosted row store", () => {
  let sqlite: Database.Database;

  function putRow(tenantId: string, value: string): void {
    sqlite
      .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, tenantId, tenantId, "active", Date.now());
    sqlite
      .prepare(
        `INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'settings', ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(tenantId, value, Date.now());
  }

  function rowValue(tenantId: string): string {
    return (
      sqlite.prepare("SELECT value FROM tenant_state WHERE tenant_id = ? AND key = 'settings'").get(tenantId) as {
        value: string;
      }
    ).value;
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
  });

  it("re-seals every tenant's row", () => {
    putRow(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));
    putRow(B, sealed(payloadFor("desk-b", "sk-beta-key-00000"), OLD_KEY));

    const result = rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend });

    expect(result).toMatchObject({ backend: "db", rotated: [A, B] });
    expect(openWith(rowValue(A), NEW_KEY)).toEqual(payloadFor("desk-a", "sk-alpha-key-0000"));
    expect(openWith(rowValue(B), NEW_KEY)).toEqual(payloadFor("desk-b", "sk-beta-key-00000"));
    expect(() => openWith(rowValue(A), OLD_KEY)).toThrow();
  });

  it("writes NOTHING when one row will not open with the current key", () => {
    const goodA = sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY);
    putRow(A, goodA);
    putRow(B, sealed(payloadFor("desk-b", "sk-beta-key-00000"), NEW_KEY));

    expect(() => rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend })).toThrow(
      WrapKeyRotationError,
    );
    expect(rowValue(A)).toBe(goodA);
  });

  /**
   * Every case above and below hands `rotateWrapKey` a backend, and that is exactly how the drill
   * shipped broken: pointed at a hosted deployment the way its own header says to, the script died
   * with `tenant_state_backend_missing` before reading a byte, because nothing had installed a
   * database connection and the store fails closed rather than quietly reading the desk's files.
   *
   * So this one passes no backend. It is the call the script makes.
   */
  it("picks the hosted store itself when the caller injects nothing", () => {
    process.env.AGENTFORGE_SERVER = "1";
    try {
      putRow(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));

      const result = rotateWrapKey({ from: OLD_KEY, to: NEW_KEY });

      expect(result).toMatchObject({ backend: "db", rotated: [A] });
      expect(openWith(rowValue(A), NEW_KEY)).toEqual(payloadFor("desk-a", "sk-alpha-key-0000"));
    } finally {
      delete process.env.AGENTFORGE_SERVER;
    }
  });

  it("leaves the gate verdict alone, because no wrap key opens it", () => {
    putRow(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY));
    sqlite
      .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'gateway_gate', ?, ?)")
      .run(A, '{"version":1,"status":"ok"}\n', Date.now());

    rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend });

    const verdict = sqlite
      .prepare("SELECT value FROM tenant_state WHERE tenant_id = ? AND key = 'gateway_gate'")
      .get(A) as { value: string };
    expect(JSON.parse(verdict.value)).toMatchObject({ version: 1, status: "ok" });
  });
});

/**
 * The portal refresh tokens sealed on `auth_sessions` (owner decision 2026-09-23) are sealed under a
 * key derived from the same wrap key, so the drill has to carry them across too — or every hosted
 * session ends at its first check after the restart with the new key. Same rules as the settings:
 * open everything first, write nothing if anything will not open, read everything back.
 */
describe("rotating the session refresh tokens sealed on auth_sessions", () => {
  let sqlite: Database.Database;

  function wrap(secret: string): Buffer {
    return wrappingKeyFromSecret(secret);
  }

  function putSession(idHash: string, refreshToken: string, secret: string, revoked = false): void {
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, tenant_id, user_id, org_id, created_at, last_seen_at, expires_at,
           absolute_expires_at, revoked_at, portal_checked_at, refresh_sealed)
         VALUES (?, 't', 'u', 'o', 1, 1, 9999999999999, 9999999999999, ?, 1, ?)`,
      )
      .run(idHash, revoked ? 5 : null, sealRefresh(idHash, { refreshToken, deviceId: "dev_1" }, wrap(secret)));
  }

  function storedFor(idHash: string): string | null {
    return (
      sqlite.prepare("SELECT refresh_sealed FROM auth_sessions WHERE id = ?").get(idHash) as {
        refresh_sealed: string | null;
      }
    ).refresh_sealed;
  }

  const S1 = "1".repeat(64);
  const S2 = "2".repeat(64);

  beforeEach(() => {
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
  });

  function tokensFrom(): ReturnType<typeof sqlSessionTokens> {
    return sqlSessionTokens(sqlite as unknown as Parameters<typeof sqlSessionTokens>[0]);
  }

  it("re-seals every stored session token under the new key, and loses none", () => {
    putSession(S1, "refresh-one", OLD_KEY);
    putSession(S2, "refresh-two", OLD_KEY);

    const result = rotateWrapKey({
      from: OLD_KEY,
      to: NEW_KEY,
      backend: stateStore.dbTenantStateBackend,
      sessionTokens: tokensFrom(),
    });

    expect(result.sessionTokens).toBe(2);
    expect(openRefresh(S1, storedFor(S1) as string, wrap(NEW_KEY))).toEqual({
      refreshToken: "refresh-one",
      deviceId: "dev_1",
    });
    expect(openRefresh(S2, storedFor(S2) as string, wrap(NEW_KEY))).toEqual({
      refreshToken: "refresh-two",
      deviceId: "dev_1",
    });
    expect(openRefresh(S1, storedFor(S1) as string, wrap(OLD_KEY))).toBeNull();
  });

  it("rehearses with --dry-run and re-seals none", () => {
    putSession(S1, "refresh-one", OLD_KEY);
    const before = storedFor(S1);
    const result = rotateWrapKey({
      from: OLD_KEY,
      to: NEW_KEY,
      dryRun: true,
      backend: stateStore.dbTenantStateBackend,
      sessionTokens: tokensFrom(),
    });
    expect(result.sessionTokens).toBe(1);
    expect(storedFor(S1)).toBe(before);
  });

  it("writes NOTHING — no session and no tenant — when one session token will not open with the current key", () => {
    const goodSettings = sealed(payloadFor("desk-a", "sk-alpha-key-0000"), OLD_KEY);
    sqlite
      .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(A, A, A, "active", Date.now());
    sqlite
      .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'settings', ?, ?)")
      .run(A, goodSettings, Date.now());
    putSession(S1, "refresh-one", OLD_KEY);
    putSession(S2, "refresh-two", NEW_KEY);
    const before1 = storedFor(S1);

    expect(() =>
      rotateWrapKey({
        from: OLD_KEY,
        to: NEW_KEY,
        backend: stateStore.dbTenantStateBackend,
        sessionTokens: tokensFrom(),
      }),
    ).toThrow(WrapKeyRotationError);
    expect(storedFor(S1)).toBe(before1);
    const settings = sqlite
      .prepare("SELECT value FROM tenant_state WHERE tenant_id = ? AND key = 'settings'")
      .get(A) as {
      value: string;
    };
    expect(settings.value).toBe(goodSettings);
  });

  it("names the session by the first characters of its digest, and says nothing about any key or token", () => {
    putSession(S1, "refresh-one", NEW_KEY);
    try {
      rotateWrapKey({
        from: OLD_KEY,
        to: NEW_KEY,
        backend: stateStore.dbTenantStateBackend,
        sessionTokens: tokensFrom(),
      });
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(S1.slice(0, 8));
      expect(message).not.toContain(S1);
      expect(message).not.toContain(OLD_KEY);
      expect(message).not.toContain("refresh-one");
    }
  });

  it("leaves a revoked session alone: it holds no token worth carrying", () => {
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, tenant_id, user_id, org_id, created_at, last_seen_at, expires_at,
           absolute_expires_at, revoked_at, portal_checked_at, refresh_sealed)
         VALUES (?, 't', 'u', 'o', 1, 1, 2, 3, 5, 1, NULL)`,
      )
      .run(S1);
    const result = rotateWrapKey({
      from: OLD_KEY,
      to: NEW_KEY,
      backend: stateStore.dbTenantStateBackend,
      sessionTokens: tokensFrom(),
    });
    expect(result.sessionTokens).toBe(0);
  });

  it("only replaces a token that is still the one it read, so a live rotation is never clobbered", () => {
    putSession(S1, "refresh-one", OLD_KEY);
    const store = tokensFrom();
    expect(store.replace(S1, "not-what-is-stored", "next")).toBe(false);
    expect(storedFor(S1)).not.toBe("next");
    const current = storedFor(S1) as string;
    expect(store.replace(S1, current, "next")).toBe(true);
    expect(storedFor(S1)).toBe("next");
  });

  it("finds the session tokens itself in server mode, as the script runs it", () => {
    process.env.AGENTFORGE_SERVER = "1";
    try {
      putSession(S1, "refresh-one", OLD_KEY);
      const result = rotateWrapKey({ from: OLD_KEY, to: NEW_KEY });
    expect(result.sessionTokens).toBe(1);
      expect(openRefresh(S1, storedFor(S1) as string, wrap(NEW_KEY))).not.toBeNull();
    } finally {
      delete process.env.AGENTFORGE_SERVER;
    }
  });
});

describe("rotating every encrypted database store and desk file object", () => {
  let sqlite: Database.Database;
  let deskMediaRoot: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
    deskMediaRoot = mkdtempSync(path.join(tmpdir(), "agentforge-rotate-media-"));
    process.env.MEDIA_ROOT = deskMediaRoot;
  });

  afterAll(() => {
    delete process.env.MEDIA_ROOT;
  });

  function sealStr(value: unknown, secret: string): string {
    return JSON.stringify(encryptJson(value, wrappingKeyFromSecret(secret)));
  }

  function openStr<T>(raw: string, secret: string): T {
    return decryptJson<T>(JSON.parse(raw), wrappingKeyFromSecret(secret));
  }

  function seedAllStores(keySecret: string, options: { corruptTable?: "artifacts" | "desk_files" } = {}): {
    deskObjectKey: string;
    deskObjectPath: string;
  } {
    const now = Date.now();
    sqlite
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(A, A, A, "active", now);
    sqlite
      .prepare("INSERT INTO tenant_state (tenant_id, key, value, updated_at) VALUES (?, 'settings', ?, ?)")
      .run(A, sealed(payloadFor("desk-a", "sk-alpha-key-0000"), keySecret), now);
    sqlite
      .prepare("INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("org-1", A, "Org 1", "org-1", "general", now);
    sqlite
      .prepare("INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("ws-1", "org-1", "Desk 1", "ws-1", now);
    sqlite
      .prepare(
        "INSERT INTO agents (id, organization_id, workspace_id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("agent-1", "org-1", "ws-1", "Chat", "chat", "user-1", now, now);
    sqlite
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, organization_id, version, system_prompt, model, input_modalities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("ver-1", "agent-1", "org-1", 1, sealStr("secret system prompt", keySecret), "gpt-4o", '["text"]', now);
    sqlite
      .prepare(
        "INSERT INTO agent_versions (id, agent_id, organization_id, version, system_prompt, model, input_modalities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("ver-legacy", "agent-1", "org-1", 2, "legacy plaintext prompt", "gpt-4o", '["text"]', now);
    sqlite
      .prepare(
        "INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("thread-1", "org-1", "ws-1", "agent-1", "user-1", sealStr("Encrypted thread title", keySecret), now);
    sqlite
      .prepare(
        "INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("thread-legacy", "org-1", "ws-1", "agent-1", "user-1", "Legacy plaintext title", now);
    sqlite
      .prepare("INSERT INTO messages (id, organization_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("msg-1", "org-1", "thread-1", "user", sealStr([{ type: "text", text: "secret message" }], keySecret), now);
    sqlite
      .prepare(
        "INSERT INTO runs (id, organization_id, thread_id, agent_version_id, modality, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("run-1", "org-1", "thread-1", "ver-1", "text", "completed", now);
    sqlite
      .prepare("INSERT INTO tool_invocations (id, organization_id, run_id, tool_key, input, output, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "tool-1",
        "org-1",
        "run-1",
        "web_search",
        sealStr({ query: "confidential" }, keySecret),
        sealStr({ hits: ["classified"] }, keySecret),
        "ok",
      );
    sqlite
      .prepare(
        "INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "art-1",
        "ws-1",
        "documents",
        "draft",
        "Memo",
        "text/markdown",
        options.corruptTable === "artifacts" ? sealStr("bad", NEW_KEY) : sealStr("# Secret artifact body", keySecret),
        "{}",
        20,
        now,
        now,
      );
    sqlite
      .prepare(
        "INSERT INTO channel_endpoints (id, organization_id, workspace_id, kind, external_id, status, created_at, updated_at) VALUES (?, ?, ?, 'whatsapp', '10001', 'active', ?, ?)",
      )
      .run("ep-1", "org-1", "ws-1", now, now);
    sqlite
      .prepare(
        `INSERT INTO customer_conversations
           (id, organization_id, workspace_id, endpoint_id, kind, contact_id, contact_name, state, unread_count,
            last_message_at, last_message_preview, last_message_direction, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, 'needs_you', 1, ?, ?, 'in', ?, ?)`,
      )
      .run(
        "conv-1",
        "org-1",
        "ws-1",
        "ep-1",
        "628120001",
        sealStr("Customer Dewi", keySecret),
        now,
        sealStr("Customer preview", keySecret),
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO customer_messages
           (id, workspace_id, conversation_id, direction, sent_by, kind, external_id, text, created_at)
         VALUES (?, ?, ?, 'in', 'customer', 'text', 'wamid.1', ?, ?)`,
      )
      .run("cmsg-1", "ws-1", "conv-1", sealStr("Customer secret text", keySecret), now);
    sqlite
      .prepare(
        `INSERT INTO desk_files (id, workspace_id, path, head_version, bytes, mime, sha256, created_at, updated_at)
         VALUES (?, ?, 'notes/secret.md', 1, 15, 'text/markdown', 'abc', ?, ?)`,
      )
      .run("df-1", "ws-1", now, now);
    const deskObjectKey = `tenants/${A}/desk-files/df-1/1`;
    sqlite
      .prepare(
        `INSERT INTO desk_file_versions (file_id, version, object_key, bytes, sha256, author_kind, author_id, mode, created_at)
         VALUES (?, 1, ?, 15, 'abc', 'user', 'user-1', NULL, ?)`,
      )
      .run("df-1", deskObjectKey, now);
    // Also a version row with missing object on disk to ensure missing files don't abort rotation
    sqlite
      .prepare(
        `INSERT INTO desk_files (id, workspace_id, path, head_version, bytes, mime, sha256, created_at, updated_at)
         VALUES (?, ?, 'notes/missing.md', 1, 5, 'text/markdown', 'def', ?, ?)`,
      )
      .run("df-missing", "ws-1", now, now);
    sqlite
      .prepare(
        `INSERT INTO desk_file_versions (file_id, version, object_key, bytes, sha256, author_kind, author_id, mode, created_at)
         VALUES (?, 1, ?, 5, 'def', 'user', 'user-1', NULL, ?)`,
      )
      .run("df-missing", `tenants/${A}/desk-files/df-missing/1`, now);

    const deskObjectPath = path.join(deskMediaRoot, ...deskObjectKey.split("/"));
    mkdirSync(path.dirname(deskObjectPath), { recursive: true });
    writeFileSync(
      deskObjectPath,
      options.corruptTable === "desk_files" ? sealStr("wrong", NEW_KEY) : sealStr("Secret desk file content", keySecret),
      "utf8",
    );
    return { deskObjectKey, deskObjectPath };
  }

  it("rotates and verifies every encrypted store while preserving legacy plaintext rows", () => {
    const { deskObjectPath } = seedAllStores(OLD_KEY);
    try {
      const result = rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend });

      expect(result.encryptedStores).toEqual({
        messages: 1,
        toolInvocations: 1,
        agentVersions: 1,
        artifacts: 1,
        threads: 1,
        customerConversations: 1,
        customerMessages: 1,
        deskFiles: 1,
      });

      const msg = sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string };
      expect(openStr(msg.content, NEW_KEY)).toEqual([{ type: "text", text: "secret message" }]);
      expect(() => openStr(msg.content, OLD_KEY)).toThrow();

      const tool = sqlite.prepare("SELECT input, output FROM tool_invocations WHERE id = 'tool-1'").get() as {
        input: string;
        output: string;
      };
      expect(openStr(tool.input, NEW_KEY)).toEqual({ query: "confidential" });
      expect(openStr(tool.output, NEW_KEY)).toEqual({ hits: ["classified"] });

      const ver = sqlite.prepare("SELECT system_prompt FROM agent_versions WHERE id = 'ver-1'").get() as {
        system_prompt: string;
      };
      expect(openStr(ver.system_prompt, NEW_KEY)).toBe("secret system prompt");
      const verLegacy = sqlite.prepare("SELECT system_prompt FROM agent_versions WHERE id = 'ver-legacy'").get() as {
        system_prompt: string;
      };
      expect(verLegacy.system_prompt).toBe("legacy plaintext prompt");

      const art = sqlite.prepare("SELECT body FROM artifacts WHERE id = 'art-1'").get() as { body: string };
      expect(openStr(art.body, NEW_KEY)).toBe("# Secret artifact body");

      const thr = sqlite.prepare("SELECT title FROM threads WHERE id = 'thread-1'").get() as { title: string };
      expect(openStr(thr.title, NEW_KEY)).toBe("Encrypted thread title");
      const thrLegacy = sqlite.prepare("SELECT title FROM threads WHERE id = 'thread-legacy'").get() as {
        title: string;
      };
      expect(thrLegacy.title).toBe("Legacy plaintext title");

      const conv = sqlite
        .prepare("SELECT contact_name, last_message_preview FROM customer_conversations WHERE id = 'conv-1'")
        .get() as { contact_name: string; last_message_preview: string };
      expect(openStr(conv.contact_name, NEW_KEY)).toBe("Customer Dewi");
      expect(openStr(conv.last_message_preview, NEW_KEY)).toBe("Customer preview");

      const cmsg = sqlite.prepare("SELECT text FROM customer_messages WHERE id = 'cmsg-1'").get() as { text: string };
      expect(openStr(cmsg.text, NEW_KEY)).toBe("Customer secret text");

      const deskBody = readFileSync(deskObjectPath, "utf8");
      expect(openStr(deskBody, NEW_KEY)).toBe("Secret desk file content");
      expect(() => openStr(deskBody, OLD_KEY)).toThrow();
    } finally {
      rmSync(deskMediaRoot, { recursive: true, force: true });
    }
  });

  it("writes NOTHING across any store when one artifact or desk file fails to open with oldKey", () => {
    const { deskObjectPath } = seedAllStores(OLD_KEY, { corruptTable: "artifacts" });
    try {
      const msgBefore = (sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string })
        .content;
      const deskBefore = readFileSync(deskObjectPath, "utf8");

      expect(() =>
        rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend }),
      ).toThrow(WrapKeyRotationError);

      const msgAfter = (sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string })
        .content;
      expect(msgAfter).toBe(msgBefore);
      expect(readFileSync(deskObjectPath, "utf8")).toBe(deskBefore);
    } finally {
      rmSync(deskMediaRoot, { recursive: true, force: true });
    }

    // Also when a desk file fails to decrypt, nothing in SQLite is mutated
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    stateStore.registerTenantStateSql(sqlite as unknown as Parameters<typeof stateStore.registerTenantStateSql>[0]);
    deskMediaRoot = mkdtempSync(path.join(tmpdir(), "agentforge-rotate-media2-"));
    process.env.MEDIA_ROOT = deskMediaRoot;
    seedAllStores(OLD_KEY, { corruptTable: "desk_files" });
    try {
      const msgBefore = (sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string })
        .content;
      expect(() =>
        rotateWrapKey({ from: OLD_KEY, to: NEW_KEY, backend: stateStore.dbTenantStateBackend }),
      ).toThrow(WrapKeyRotationError);
      const msgAfter = (sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string })
        .content;
      expect(msgAfter).toBe(msgBefore);
    } finally {
      rmSync(deskMediaRoot, { recursive: true, force: true });
    }
  });

  it("supports --dry-run without modifying any store or desk file", () => {
    const { deskObjectPath } = seedAllStores(OLD_KEY);
    try {
      const msgBefore = (sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string })
        .content;
      const deskBefore = readFileSync(deskObjectPath, "utf8");

      const result = rotateWrapKey({
        from: OLD_KEY,
        to: NEW_KEY,
        dryRun: true,
        backend: stateStore.dbTenantStateBackend,
      });

      expect(result.dryRun).toBe(true);
      expect(result.encryptedStores.messages).toBe(1);
      expect(result.encryptedStores.deskFiles).toBe(1);
      expect((sqlite.prepare("SELECT content FROM messages WHERE id = 'msg-1'").get() as { content: string }).content).toBe(
        msgBefore,
      );
      expect(readFileSync(deskObjectPath, "utf8")).toBe(deskBefore);
    } finally {
      rmSync(deskMediaRoot, { recursive: true, force: true });
    }
  });
});
