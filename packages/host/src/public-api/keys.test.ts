import Database from "better-sqlite3";
import { ensureSchema } from "@agentforge/db";
import { describe, expect, it } from "vitest";
import { createApiKey, listApiKeys, revokeApiKey, resolveApiKey, rotateApiKey, API_KEY_PREFIX } from "./keys";

function db() {
  const sqlite = new Database(":memory:");
  ensureSchema(sqlite);
  return sqlite;
}

const input = {
  tenantId: "t1",
  name: "billing bot",
  allowedAgents: ["agent-a"],
};

describe("desk API keys (F5a)", () => {
  it("shows the raw key once and stores only the SHA-256, prefix and last four (AC-5a.1)", () => {
    const sqlite = db();
    const { key, apiKey } = createApiKey(input, sqlite);
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    const stored = sqlite.prepare("SELECT * FROM agent_api_keys WHERE id = ?").get(apiKey.id) as {
      key_hash: Buffer;
      key_prefix: string;
      last4: string;
    };
    expect(stored.key_hash).toHaveLength(32);
    // The stored hash is sha256(raw); the raw string is nowhere in the row.
    expect(Buffer.from(key).length).toBeGreaterThan(32);
    expect(stored.key_prefix).toBe(key.slice(0, API_KEY_PREFIX.length + 8));
    expect(stored.last4).toBe(key.slice(-4));
    const rowText = JSON.stringify(stored);
    expect(rowText).not.toContain(key.slice(9, 40));
  });

  it("verifies with a constant-time compare: right key resolves, wrong one 401s (AC-5a.2)", () => {
    const sqlite = db();
    const { key } = createApiKey(input, sqlite);
    expect(resolveApiKey(key, Date.now(), sqlite).tenant_id).toBe("t1");
    const wrong = `${API_KEY_PREFIX}${"f".repeat(48)}`;
    expect(() => resolveApiKey(wrong, Date.now(), sqlite)).toThrowError(/invalid/i);
    expect(() => resolveApiKey("not-a-key", Date.now(), sqlite)).toThrowError(/invalid/i);
    expect(() => resolveApiKey(null, Date.now(), sqlite)).toThrowError(/invalid/i);
  });

  it("refuses revoked and expired keys", () => {
    const sqlite = db();
    const { key, apiKey } = createApiKey(input, sqlite);
    revokeApiKey("t1", apiKey.id, "o1", Date.now(), sqlite);
    expect(() => resolveApiKey(key, Date.now(), sqlite)).toThrowError(/invalid/i);
    const soon = Date.now() + 60_000;
    const expired = createApiKey({ ...input, name: "old", expiresAt: soon }, sqlite);
    expect(() => resolveApiKey(expired.key, soon + 1, sqlite)).toThrowError(/invalid/i);
  });

  it("rotates: the old key 401s immediately, the new one resolves", () => {
    const sqlite = db();
    const { key, apiKey } = createApiKey(input, sqlite);
    const rotated = rotateApiKey("t1", apiKey.id, { organizationId: "o1" }, sqlite);
    expect(rotated.key).not.toBe(key);
    expect(() => resolveApiKey(key, Date.now(), sqlite)).toThrowError(/invalid/i);
    expect(resolveApiKey(rotated.key, Date.now(), sqlite).id).toBe(rotated.apiKey.id);
    // Old row is revoked, not deleted — the audit trail keeps it.
    const rows = listApiKeys("t1", "o1", sqlite);
    expect(rows.find((r) => r.id === apiKey.id)?.status).toBe("revoked");
  });

  it("rotation carries the key's jobs and threads to the replacement id", () => {
    const sqlite = db();
    sqlite.pragma("foreign_keys = OFF"); // the lineage check needs no org/agent fixtures
    const { apiKey } = createApiKey(input, sqlite);
    sqlite
      .prepare(
        `INSERT INTO api_jobs (id, tenant_id, key_id, agent_id, status, created_at, updated_at)
         VALUES ('j1', 't1', ?, 'agent-a', 'done', 0, 0)`,
      )
      .run(apiKey.id);
    sqlite
      .prepare(
        "INSERT INTO threads (id, organization_id, workspace_id, user_id, agent_id, title, created_at) VALUES ('th1', 'o1', 'w1', ?, 'agent-a', 't', 0)",
      )
      .run(`apikey-${apiKey.id}`);
    const rotated = rotateApiKey("t1", apiKey.id, { organizationId: "o1" }, sqlite);
    expect(sqlite.prepare("SELECT key_id FROM api_jobs WHERE id = 'j1'").get()).toEqual({ key_id: rotated.apiKey.id });
    expect(sqlite.prepare("SELECT user_id FROM threads WHERE id = 'th1'").get()).toEqual({
      user_id: `apikey-${rotated.apiKey.id}`,
    });
  });

  it("refuses a caller from another org under the same partner (list, revoke, rotate)", () => {
    const sqlite = db();
    sqlite.pragma("foreign_keys = OFF");
    // Partner t1 hosts two companies; the key's desk lives in the second.
    sqlite
      .prepare(
        "INSERT INTO organizations (id, tenant_id, name, slug, industry_pack, created_at) VALUES ('o-a', 't1', 'A', 'a', 'generic', 1), ('o-b', 't1', 'B', 'b', 'generic', 1)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES ('w-b', 'o-b', 'B desk', 'home', 1)",
      )
      .run();
    const { apiKey } = createApiKey({ ...input, workspaceId: "w-b" }, sqlite);
    expect(listApiKeys("t1", "o-a", sqlite)).toHaveLength(0);
    expect(() => revokeApiKey("t1", apiKey.id, "o-a", Date.now(), sqlite)).toThrowError(/not found/i);
    expect(() => rotateApiKey("t1", apiKey.id, { organizationId: "o-a" }, sqlite)).toThrowError(/not found/i);
    // The owning org is untouched and still administers it.
    expect(listApiKeys("t1", "o-b", sqlite)).toHaveLength(1);
    revokeApiKey("t1", apiKey.id, "o-b", Date.now(), sqlite);
    expect(listApiKeys("t1", "o-b", sqlite)[0].status).toBe("revoked");
  });

  it("enforces the agent allow-list", async () => {
    const sqlite = db();
    const { key } = createApiKey(input, sqlite);
    const row = resolveApiKey(key, Date.now(), sqlite);
    const { allowsAgent } = await import("./keys");
    expect(allowsAgent(row, "agent-a")).toBe(true);
    expect(allowsAgent(row, "agent-b")).toBe(false);
    const wildcard = createApiKey({ ...input, name: "all", allowedAgents: ["*"] }, sqlite);
    expect(allowsAgent(resolveApiKey(wildcard.key, Date.now(), sqlite), "anything")).toBe(true);
  });
});
