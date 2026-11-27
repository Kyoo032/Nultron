import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

function insertKey(sqlite: Database.Database, overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: "k1",
    tenant_id: "t1",
    name: "bot",
    key_prefix: `nk_live_${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`,
    key_hash: crypto.getRandomValues(Buffer.alloc(32)),
    last4: "bbbb",
    allowed_agents: '["*"]',
    rate_limit_rpm: null,
    status: "active",
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    created_by: "u1",
    created_at: 1,
    ...overrides,
  };
  sqlite
    .prepare(
      `INSERT INTO agent_api_keys
       (id, tenant_id, name, key_prefix, key_hash, last4, allowed_agents, rate_limit_rpm,
        status, expires_at, revoked_at, last_used_at, created_by, created_at)
       VALUES (@id, @tenant_id, @name, @key_prefix, @key_hash, @last4, @allowed_agents,
               @rate_limit_rpm, @status, @expires_at, @revoked_at, @last_used_at, @created_by, @created_at)`,
    )
    .run(row);
}

describe("0029_agent_api_keys", () => {
  it("follows every existing migration in the forward-only journal", () => {
    const index = journal.entries.findIndex((entry) => entry.tag === "0029_agent_api_keys");
    expect(index).toBeGreaterThan(-1);
    const entry = journal.entries[index]!;
    for (const previous of journal.entries.slice(0, index)) expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("applies on a fresh database and enforces hash-only storage and lifecycle CHECKs", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      insertKey(sqlite);
      // 32-byte hash enforced.
      expect(() => insertKey(sqlite, { id: "k2", key_hash: Buffer.alloc(16) })).toThrow();
      // Revoked requires revoked_at (and active forbids it).
      expect(() => insertKey(sqlite, { id: "k3", status: "revoked" })).toThrow();
      expect(() => insertKey(sqlite, { id: "k4", status: "active", revoked_at: 2 })).toThrow();
      insertKey(sqlite, { id: "k5", status: "revoked", revoked_at: 2 });
      // rate_limit_rpm is null or positive.
      expect(() => insertKey(sqlite, { id: "k6", rate_limit_rpm: 0 })).toThrow();
      // prefix and hash unique.
      // Same id + same prefix path hits a UNIQUE violation.
      expect(() => insertKey(sqlite, { id: "k1" })).toThrow(/UNIQUE/i);
      // api_jobs lifecycle statuses.
      sqlite
        .prepare(
          `INSERT INTO api_jobs (id, tenant_id, key_id, agent_id, status, result_sealed, created_at, updated_at)
           VALUES ('j1', 't1', 'k1', 'a1', 'queued', NULL, 1, 1)`,
        )
        .run();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO api_jobs (id, tenant_id, key_id, agent_id, status, created_at, updated_at)
             VALUES ('j2', 't1', 'k1', 'a1', 'vanished', 1, 1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
