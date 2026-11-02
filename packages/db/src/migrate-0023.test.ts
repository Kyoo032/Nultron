/**
 * Customer inbox — `channel_endpoints`, `customer_conversations` and `customer_messages`.
 *
 * What this has to get right: the three tables exist with exactly the columns the host store writes,
 * on a fresh database and on one baseline-stamped past 0023 (the healer); a number belongs to one
 * desk on the whole install; a customer is one conversation per endpoint; a message id is stored
 * once per conversation and direction (Meta delivers at least once); the CHECK constraints refuse a
 * value the host never writes; a message follows its conversation and a conversation follows its
 * endpoint; the Drizzle declarations match the SQL; and the journal `when` sits above every
 * migration before it, because the runner is forward-only on `when`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "./ensure-schema";
import { channelEndpoints, customerConversations, customerMessages } from "./schema";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realMigrations = path.join(packageDir, "drizzle");

const ENDPOINT_COLUMNS = [
  "id",
  "organization_id",
  "workspace_id",
  "kind",
  "external_id",
  "display_phone",
  "verified_name",
  "status",
  "created_at",
  "updated_at",
] as const;
const CONVERSATION_COLUMNS = [
  "id",
  "organization_id",
  "workspace_id",
  "endpoint_id",
  "kind",
  "contact_id",
  "contact_name",
  "state",
  "unread_count",
  "last_inbound_at",
  "last_outbound_at",
  "last_message_at",
  "last_message_preview",
  "last_message_direction",
  "created_at",
  "updated_at",
] as const;
const MESSAGE_COLUMNS = [
  "id",
  "workspace_id",
  "conversation_id",
  "direction",
  "sent_by",
  "kind",
  "external_id",
  "text",
  "delivery",
  "delivery_error",
  "created_at",
] as const;
const TABLES = ["channel_endpoints", "customer_conversations", "customer_messages"] as const;

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function count(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function insertEndpoint(sqlite: Database.Database, id: string, workspaceId: string, externalId: string, kind = "whatsapp") {
  sqlite
    .prepare(
      `INSERT INTO channel_endpoints (id, organization_id, workspace_id, kind, external_id, status, created_at, updated_at)
       VALUES (?, 'o-1', ?, ?, ?, 'active', 1, 1)`,
    )
    .run(id, workspaceId, kind, externalId);
}

function insertConversation(
  sqlite: Database.Database,
  id: string,
  endpointId: string,
  contactId: string,
  state = "needs_you",
) {
  sqlite
    .prepare(
      `INSERT INTO customer_conversations
         (id, organization_id, workspace_id, endpoint_id, kind, contact_id, contact_name, state,
          last_message_at, last_message_preview, last_message_direction, created_at, updated_at)
       VALUES (?, 'o-1', 'ws-1', ?, 'whatsapp', ?, 'Dewi', ?, 1, 'hi', 'in', 1, 1)`,
    )
    .run(id, endpointId, contactId, state);
}

function insertMessage(
  sqlite: Database.Database,
  id: string,
  conversationId: string,
  externalId: string | null,
  overrides: { direction?: string; sentBy?: string; kind?: string; delivery?: string | null } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO customer_messages (id, workspace_id, conversation_id, direction, sent_by, kind, external_id, text, delivery, created_at)
       VALUES (?, 'ws-1', ?, ?, ?, ?, ?, 'hello', ?, 1)`,
    )
    .run(
      id,
      conversationId,
      overrides.direction ?? "in",
      overrides.sentBy ?? "customer",
      overrides.kind ?? "text",
      externalId,
      overrides.delivery === undefined ? null : overrides.delivery,
    );
}

describe("0023_customer_inbox on a fresh database", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates the three tables with exactly the columns the host writes", () => {
    expect(tableNames(sqlite)).toEqual(expect.arrayContaining([...TABLES]));
    expect(columnNames(sqlite, "channel_endpoints").sort()).toEqual([...ENDPOINT_COLUMNS].sort());
    expect(columnNames(sqlite, "customer_conversations").sort()).toEqual([...CONVERSATION_COLUMNS].sort());
    expect(columnNames(sqlite, "customer_messages").sort()).toEqual([...MESSAGE_COLUMNS].sort());
  });

  it("matches the Drizzle declarations column for column", () => {
    const names = (table: Parameters<typeof getTableColumns>[0]) =>
      Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
    expect(names(channelEndpoints)).toEqual([...ENDPOINT_COLUMNS].sort());
    expect(names(customerConversations)).toEqual([...CONVERSATION_COLUMNS].sort());
    expect(names(customerMessages)).toEqual([...MESSAGE_COLUMNS].sort());
  });

  it("starts empty", () => {
    for (const table of TABLES) {
      expect(count(sqlite, table)).toBe(0);
    }
  });

  it("gives a number to exactly one desk across the whole install", () => {
    insertEndpoint(sqlite, "e1", "ws-1", "1055550001");
    // Another desk cannot register the same number id.
    expect(() => insertEndpoint(sqlite, "e2", "ws-2", "1055550001")).toThrow(/UNIQUE/i);
    // A different number is fine, on either desk.
    insertEndpoint(sqlite, "e3", "ws-2", "1055550002");
    insertEndpoint(sqlite, "e4", "ws-1", "1055550003");
    expect(count(sqlite, "channel_endpoints")).toBe(3);
  });

  it("keeps one conversation per customer per endpoint", () => {
    insertEndpoint(sqlite, "e1", "ws-1", "1055550001");
    insertEndpoint(sqlite, "e2", "ws-1", "1055550002");
    insertConversation(sqlite, "c1", "e1", "6281200000001");
    expect(() => insertConversation(sqlite, "c2", "e1", "6281200000001")).toThrow(/UNIQUE/i);
    // The same customer on another endpoint is a different conversation.
    insertConversation(sqlite, "c3", "e2", "6281200000001");
    expect(count(sqlite, "customer_conversations")).toBe(2);
  });

  it("stores a message id once per conversation and direction, so a redelivery is refused", () => {
    insertEndpoint(sqlite, "e1", "ws-1", "1055550001");
    insertConversation(sqlite, "c1", "e1", "6281200000001");
    insertConversation(sqlite, "c2", "e1", "6281200000002");
    insertMessage(sqlite, "m1", "c1", "wamid.A");
    expect(() => insertMessage(sqlite, "m2", "c1", "wamid.A")).toThrow(/UNIQUE/i);
    // The same id in the other direction, or in another conversation, is a different message.
    insertMessage(sqlite, "m3", "c1", "wamid.A", { direction: "out", sentBy: "owner", delivery: "sent" });
    insertMessage(sqlite, "m4", "c2", "wamid.A");
    // A message with no id yet (an outbound still queued) is not constrained.
    insertMessage(sqlite, "m5", "c1", null, { direction: "out", sentBy: "owner", delivery: "queued" });
    insertMessage(sqlite, "m6", "c1", null, { direction: "out", sentBy: "owner", delivery: "queued" });
    expect(count(sqlite, "customer_messages")).toBe(5);
  });

  it("takes a message with its conversation, and a conversation with its endpoint", () => {
    insertEndpoint(sqlite, "e1", "ws-1", "1055550001");
    insertConversation(sqlite, "c1", "e1", "6281200000001");
    insertMessage(sqlite, "m1", "c1", "wamid.A");
    sqlite.prepare("DELETE FROM channel_endpoints WHERE id = 'e1'").run();
    expect(count(sqlite, "customer_conversations")).toBe(0);
    expect(count(sqlite, "customer_messages")).toBe(0);
  });

  it("refuses a message for a conversation that does not exist", () => {
    expect(() => insertMessage(sqlite, "m1", "ghost", "wamid.A")).toThrow(/FOREIGN KEY/i);
  });

  it("refuses values the host never writes", () => {
    expect(() => insertEndpoint(sqlite, "e1", "ws-1", "1055550001", "sms")).toThrow(/CHECK/i);
    insertEndpoint(sqlite, "e2", "ws-1", "1055550002");
    expect(() => insertConversation(sqlite, "c1", "e2", "6281200000001", "snoozed")).toThrow(/CHECK/i);
    insertConversation(sqlite, "c2", "e2", "6281200000002");
    expect(() => insertMessage(sqlite, "m1", "c2", "wamid.A", { direction: "sideways" })).toThrow(/CHECK/i);
    expect(() => insertMessage(sqlite, "m2", "c2", "wamid.B", { sentBy: "robot" })).toThrow(/CHECK/i);
    expect(() => insertMessage(sqlite, "m3", "c2", "wamid.C", { kind: "image" })).toThrow(/CHECK/i);
    expect(() => insertMessage(sqlite, "m4", "c2", "wamid.D", { delivery: "lost" })).toThrow(/CHECK/i);
  });

  it("indexes the desk list and the status lookup", () => {
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('customer_conversations', 'customer_messages', 'channel_endpoints')")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "channel_endpoints_kind_external_unique",
        "channel_endpoints_ws_idx",
        "customer_conversations_contact_unique",
        "customer_conversations_ws_state_idx",
        "customer_messages_external_unique",
        "customer_messages_conv_idx",
        "customer_messages_external_idx",
        "customer_messages_ws_time_idx",
      ]),
    );
  });
});

describe("0023_customer_inbox is in the committed migration set", () => {
  const journal = JSON.parse(readFileSync(path.join(realMigrations, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const whenOf = (tag: string): number => {
    const entry = journal.entries.find((row) => row.tag === tag);
    if (!entry) {
      throw new Error(`${tag} is not in the migration journal`);
    }
    return entry.when;
  };

  it("carries a `when` above every migration before it", () => {
    const mine = whenOf("0023_customer_inbox");
    const before = journal.entries.slice(
      0,
      journal.entries.findIndex((row) => row.tag === "0023_customer_inbox"),
    );
    expect(before.length).toBeGreaterThan(0);
    for (const entry of before) {
      expect(mine, `${entry.tag} is at or above 0023`).toBeGreaterThan(entry.when);
    }
  });

  it("sits after 0022 in the entries array, so array order and `when` order agree", () => {
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.indexOf("0023_customer_inbox")).toBeGreaterThan(tags.indexOf("0022_desk_files"));
    const whens = journal.entries.map((entry) => entry.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });

  it("is additive: it creates tables and alters none", () => {
    const sqlText = readFileSync(path.join(realMigrations, "0023_customer_inbox.sql"), "utf8");
    expect(sqlText).not.toContain("ALTER TABLE");
    expect(sqlText).not.toContain("DROP ");
    expect(sqlText).toContain("WHERE `external_id` IS NOT NULL");
  });

  it("heals a database stamped past 0023 that never got the tables", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    sqlite.exec("DROP TABLE customer_messages; DROP TABLE customer_conversations; DROP TABLE channel_endpoints;");
    expect(tableNames(sqlite)).not.toContain("customer_messages");

    ensureSchema(sqlite);

    expect(columnNames(sqlite, "channel_endpoints").sort()).toEqual([...ENDPOINT_COLUMNS].sort());
    expect(columnNames(sqlite, "customer_conversations").sort()).toEqual([...CONVERSATION_COLUMNS].sort());
    expect(columnNames(sqlite, "customer_messages").sort()).toEqual([...MESSAGE_COLUMNS].sort());
    // The healed shape keeps the unique indexes and the constraints.
    insertEndpoint(sqlite, "e1", "ws-1", "1055550001");
    expect(() => insertEndpoint(sqlite, "e2", "ws-2", "1055550001")).toThrow(/UNIQUE/i);
    insertConversation(sqlite, "c1", "e1", "6281200000001");
    insertMessage(sqlite, "m1", "c1", "wamid.A");
    expect(() => insertMessage(sqlite, "m2", "c1", "wamid.A")).toThrow(/UNIQUE/i);
    expect(() => insertConversation(sqlite, "c2", "e1", "6281200000002", "snoozed")).toThrow(/CHECK/i);
    sqlite.close();
  });

  it("actually ran as a migration, rather than only being healed into place", () => {
    const sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    const stamps = sqlite.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at").all() as Array<{
      created_at: number;
    }>;
    expect(stamps.map((row) => row.created_at)).toContain(whenOf("0023_customer_inbox"));
    sqlite.close();
  });
});
