import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema, migrationsFolder } from "./ensure-schema";

const migration = readFileSync(`${migrationsFolder()}/0030_email_channel.sql`, "utf8");
const journal = JSON.parse(readFileSync(`${migrationsFolder()}/meta/_journal.json`, "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};

describe("0030_email_channel", () => {
  it("follows every existing migration in the forward-only journal", () => {
    const entry = journal.entries[journal.entries.length - 1];
    expect(entry.tag).toBe("0030_email_channel");
    for (const previous of journal.entries.slice(0, -1)) {
      expect(entry.when).toBeGreaterThan(previous.when);
    }
  });

  it("applies on a fresh database and enforces the channel contract", () => {
    const sqlite = new Database(":memory:");
    try {
      ensureSchema(sqlite);
      sqlite
        .prepare(
          `INSERT INTO email_channels (id, workspace_id, agent_id, address, unknown_sender_policy, status, created_at)
           VALUES ('c1', 'w1', 'a1', 'agent@mail.example.com', 'ignore', 'active', 1)`,
        )
        .run();
      // One address belongs to one channel.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO email_channels (id, workspace_id, agent_id, address, unknown_sender_policy, status, created_at)
             VALUES ('c2', 'w1', 'a1', 'agent@mail.example.com', 'ignore', 'active', 1)`,
          )
          .run(),
      ).toThrow();
      // The policy and status checks hold.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO email_channels (id, workspace_id, agent_id, address, unknown_sender_policy, status, created_at)
             VALUES ('c3', 'w1', 'a1', 'b@mail.example.com', 'bounce', 'active', 1)`,
          )
          .run(),
      ).toThrow();
      // The dedupe primary key refuses a redelivery.
      sqlite
        .prepare(`INSERT INTO email_inbound_seen (provider_message_id, channel_id, received_at) VALUES ('m1', 'c1', 1)`)
        .run();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO email_inbound_seen (provider_message_id, channel_id, received_at) VALUES ('m1', 'c1', 2)`,
          )
          .run(),
      ).toThrow();
      // A mail thread files one chat thread per root message id per channel per user.
      sqlite
        .prepare(
          `INSERT INTO email_threads (id, channel_id, thread_id, root_message_id, user_id)
           VALUES ('e1', 'c1', 't1', '<r@m>', 'u1')`,
        )
        .run();
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO email_threads (id, channel_id, thread_id, root_message_id, user_id)
             VALUES ('e2', 'c1', 't2', '<r@m>', 'u1')`,
          )
          .run(),
      ).toThrow();
      // Removing a channel cascades its allowlist.
      sqlite
        .prepare(
          `INSERT INTO email_sender_allowlist (id, channel_id, pattern, user_id) VALUES ('s1', 'c1', '@x.com', NULL)`,
        )
        .run();
      sqlite.prepare(`DELETE FROM email_channels WHERE id = 'c1'`).run();
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM email_sender_allowlist WHERE channel_id = 'c1'`).get()).toEqual({
        n: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("re-creates the tables on a database stamped past 0030 without them", () => {
    const sqlite = new Database(":memory:");
    try {
      // Replay the migrations through 0029 and stamp the journal over them all — the baseline a
      // desk carries when its 0030 tables were never created.
      sqlite.pragma("foreign_keys = OFF");
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
      );
      const stamp = sqlite.prepare("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)");
      const before = journal.entries.slice(0, -1);
      for (const entry of before) {
        const file = readFileSync(join(migrationsFolder(), `${entry.tag}.sql`), "utf8");
        for (const statement of file.split("--> statement-breakpoint")) {
          const trimmed = statement.trim();
          if (trimmed.length > 0) {
            sqlite.exec(trimmed);
          }
        }
        stamp.run(`replayed-${entry.tag}`, entry.when);
      }
      stamp.run("stamped-0030", journal.entries[journal.entries.length - 1].when);
      sqlite.pragma("foreign_keys = ON");
      ensureSchema(sqlite);
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='email_channels'`).get(),
      ).toEqual({ name: "email_channels" });
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='email_inbound_seen'`).get(),
      ).toEqual({ name: "email_inbound_seen" });
    } finally {
      sqlite.close();
    }
  });

  it("stores no message body column (bodies live in the sealed message store only)", () => {
    for (const match of migration.matchAll(/`(\w+)`\s+text/gi)) {
      expect(match[1]).not.toMatch(/body|subject|content/i);
    }
  });
});
