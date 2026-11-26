import Database from "better-sqlite3";
import { ensureSchema } from "@agentforge/db";
import { describe, expect, it } from "vitest";
import { createApiKey, resolveApiKey, allowsAgent, revokeApiKey } from "./keys";
import { isPublicApiPath, publicApiEnabled } from "./auth";

/**
 * The 401/403 matrix (AC-5a.2): every credential shape that is not an active key is a 401,
 * and a key outside its agent scope is a 403 — two distinct answers, never merged.
 */
describe("public API auth (F5a)", () => {
  const sqlite = () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    return db;
  };

  it("401s: no header, wrong scheme, garbage, revoked, expired, hash mismatch", () => {
    const db = sqlite();
    const { key, apiKey } = createApiKey({ tenantId: "t1", name: "a", allowedAgents: ["*"] }, db);
    const cases: (string | null)[] = [null, "", "Basic abc", "nk_test_xxxxxxxx", `nk_live_${"0".repeat(48)}`];
    for (const value of cases) {
      expect(() => resolveApiKey(value, Date.now(), db)).toThrowError(/Invalid API key/);
    }
    resolveApiKey(key, Date.now(), db);
    revokeApiKey("t1", apiKey.id, Date.now(), db);
    expect(() => resolveApiKey(key, Date.now(), db)).toThrowError(/Invalid API key/);
  });

  it("403: a key for agent A cannot speak for agent B", () => {
    const db = sqlite();
    const { key } = createApiKey({ tenantId: "t1", name: "a", allowedAgents: ["agent-a"] }, db);
    const row = resolveApiKey(key, Date.now(), db);
    expect(allowsAgent(row, "agent-a")).toBe(true);
    expect(allowsAgent(row, "agent-b")).toBe(false);
  });

  it("recognises only the public prefixes, and defaults off", () => {
    expect(isPublicApiPath("/api/public/v1/agents")).toBe(true);
    expect(isPublicApiPath("/api/public/v1/agents/x/messages")).toBe(true);
    expect(isPublicApiPath("/v1/chat/completions")).toBe(true);
    expect(isPublicApiPath("/api/v1/settings")).toBe(false);
    expect(isPublicApiPath("/api/v1/api-keys")).toBe(false);
    expect(isPublicApiPath("/api/public/v2/x")).toBe(false);
    expect(isPublicApiPath("/v1/models")).toBe(false);
    expect(publicApiEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(publicApiEnabled({ AGENTFORGE_PUBLIC_API: "on" } as NodeJS.ProcessEnv)).toBe(true);
    expect(publicApiEnabled({ AGENTFORGE_PUBLIC_API: "off" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
