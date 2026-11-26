import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

/**
 * F6 layer 2 (B6): the per-agent tool allowlist table. The file is named 0031 per the
 * migration map (0027–0030 belong to parallel lanes); journal order — not the numeric
 * prefix — is what `ensureSchema` replays, so the test asserts journal position rather
 * than "the highest number".
 */
describe("0031_agent_tool_allowlist", () => {
  it("is the last journal entry and forward-only", () => {
    const entry = journal.entries.at(-1)!;
    expect(entry.tag).toBe("0031_agent_tool_allowlist");
    for (const previous of journal.entries.slice(0, -1)) expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("applies on a fresh database and enforces the composite key", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      sqlite.prepare("INSERT INTO agent_tool_allowlist (agent_id, tool_key) VALUES ('a1', 'web_fetch')").run();
      // A duplicate (agent, tool) pair is refused.
      expect(() =>
        sqlite.prepare("INSERT INTO agent_tool_allowlist (agent_id, tool_key) VALUES ('a1', 'web_fetch')").run(),
      ).toThrow(/unique|primary/i);
      // The same tool on another agent, and another tool on the same agent, are fine.
      sqlite.prepare("INSERT INTO agent_tool_allowlist (agent_id, tool_key) VALUES ('a2', 'web_fetch')").run();
      sqlite.prepare("INSERT INTO agent_tool_allowlist (agent_id, tool_key) VALUES ('a1', 'read_file')").run();
      // The agent's list reads back as a set; no rows means "unrestricted" by contract.
      const rows = sqlite
        .prepare("SELECT tool_key FROM agent_tool_allowlist WHERE agent_id = 'a1' ORDER BY tool_key")
        .all() as { tool_key: string }[];
      expect(rows.map((row) => row.tool_key)).toEqual(["read_file", "web_fetch"]);
    } finally {
      sqlite.close();
    }
  });
});
