/**
 * The email channel store — `email_channels`, `email_sender_allowlist`, `email_inbound_seen`,
 * `email_threads` (drizzle/0030_email_channel.sql).
 *
 * `createEmailStore` takes the database so tests hand it a scratch one; `./db.ts` binds the app's.
 * A channel's `workspaceId` is the desk's workspace id — the one value the webhook can resolve to a
 * full TenantContext through `workspaces` → `organizations` (`./tenant.ts`).
 *
 * Sender addresses are personal data: rows that hold one (`address`, `pattern`) never reach a log
 * line, and `email_inbound_seen` keeps only the provider's message id.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type EmailSql = Pick<Database.Database, "prepare">;

export type EmailChannelRow = {
  id: string;
  workspaceId: string;
  agentId: string;
  address: string;
  unknownSenderPolicy: "ignore" | "refuse";
  status: "active" | "disabled";
  createdAt: number;
};

export type EmailAllowlistRow = {
  id: string;
  channelId: string;
  /** A full address (`person@example.com`) or a domain (`@example.com`, `*@example.com`). */
  pattern: string;
  /** The Nultron user the sender maps to; null means the desk's owner. */
  userId: string | null;
};

export type EmailThreadRow = {
  id: string;
  channelId: string;
  /** The chat thread the mail thread's replies run in. */
  threadId: string;
  rootMessageId: string;
  /** sha256 of the sender address — senders never share a chat thread. */
  senderKey: string;
};

type ChannelDb = {
  id: string;
  workspace_id: string;
  agent_id: string;
  address: string;
  unknown_sender_policy: "ignore" | "refuse";
  status: "active" | "disabled";
  created_at: number;
};

const channelOf = (row: ChannelDb): EmailChannelRow => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  address: row.address,
  unknownSenderPolicy: row.unknown_sender_policy,
  status: row.status,
  createdAt: row.created_at,
});

export interface EmailStore {
  createChannel(input: {
    workspaceId: string;
    agentId: string;
    address: string;
    unknownSenderPolicy: "ignore" | "refuse";
  }): EmailChannelRow;
  listChannels(workspaceId: string): EmailChannelRow[];
  getChannel(workspaceId: string, channelId: string): EmailChannelRow | null;
  /** The webhook's one lookup: the address in the delivery names the desk. */
  findChannelByAddress(address: string): EmailChannelRow | null;
  removeChannel(workspaceId: string, channelId: string): boolean;
  addAllowlistEntry(channelId: string, pattern: string, userId: string | null): EmailAllowlistRow;
  listAllowlist(channelId: string): EmailAllowlistRow[];
  removeAllowlistEntry(channelId: string, entryId: string): boolean;
  /**
   * The at-least-once dedupe: false when this provider message id was already taken, inside the
   * same transaction the caller stores the mail in.
   */
  markInboundSeen(providerMessageId: string, channelId: string, at: number): boolean;
  /** Drops the dedupe mark so a transiently failed delivery can be retried by the provider. */
  unmarkInboundSeen(providerMessageId: string, channelId: string): void;
  findThread(channelId: string, rootMessageId: string, senderKey: string): EmailThreadRow | null;
  createThread(channelId: string, threadId: string, rootMessageId: string, senderKey: string): EmailThreadRow;
  /** Drops a stale mapping (its chat thread was deleted). */
  removeThread(id: string): void;
  /** Desk delete: the channel rows go, and the keyed tables cascade with them. */
  dropWorkspace(workspaceId: string): void;
}

export function createEmailStore(sql: EmailSql): EmailStore {
  return {
    createChannel(input) {
      const row: ChannelDb = {
        id: randomUUID(),
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        address: input.address,
        unknown_sender_policy: input.unknownSenderPolicy,
        status: "active",
        created_at: Date.now(),
      };
      sql
        .prepare(
          `INSERT INTO email_channels (id, workspace_id, agent_id, address, unknown_sender_policy, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.workspace_id,
          row.agent_id,
          row.address,
          row.unknown_sender_policy,
          row.status,
          row.created_at,
        );
      return channelOf(row);
    },

    listChannels(workspaceId) {
      const rows = sql
        .prepare(`SELECT * FROM email_channels WHERE workspace_id = ? ORDER BY created_at DESC`)
        .all(workspaceId) as ChannelDb[];
      return rows.map(channelOf);
    },

    getChannel(workspaceId, channelId) {
      const row = sql
        .prepare(`SELECT * FROM email_channels WHERE id = ? AND workspace_id = ?`)
        .get(channelId, workspaceId) as ChannelDb | undefined;
      return row ? channelOf(row) : null;
    },

    findChannelByAddress(address) {
      const row = sql.prepare(`SELECT * FROM email_channels WHERE address = ? AND status = 'active'`).get(address) as
        | ChannelDb
        | undefined;
      return row ? channelOf(row) : null;
    },

    removeChannel(workspaceId, channelId) {
      const result = sql
        .prepare(`DELETE FROM email_channels WHERE id = ? AND workspace_id = ?`)
        .run(channelId, workspaceId);
      return result.changes > 0;
    },

    addAllowlistEntry(channelId, pattern, userId) {
      const id = randomUUID();
      sql
        .prepare(`INSERT INTO email_sender_allowlist (id, channel_id, pattern, user_id) VALUES (?, ?, ?, ?)`)
        .run(id, channelId, pattern, userId);
      return { id, channelId, pattern, userId };
    },

    listAllowlist(channelId) {
      return sql
        .prepare(
          `SELECT id, channel_id AS channelId, pattern, user_id AS userId FROM email_sender_allowlist WHERE channel_id = ?`,
        )
        .all(channelId) as EmailAllowlistRow[];
    },

    removeAllowlistEntry(channelId, entryId) {
      const result = sql
        .prepare(`DELETE FROM email_sender_allowlist WHERE id = ? AND channel_id = ?`)
        .run(entryId, channelId);
      return result.changes > 0;
    },

    markInboundSeen(providerMessageId, channelId, at) {
      const result = sql
        .prepare(
          `INSERT OR IGNORE INTO email_inbound_seen (provider_message_id, channel_id, received_at) VALUES (?, ?, ?)`,
        )
        .run(providerMessageId, channelId, at);
      return result.changes > 0;
    },

    unmarkInboundSeen(providerMessageId, channelId) {
      sql
        .prepare(`DELETE FROM email_inbound_seen WHERE provider_message_id = ? AND channel_id = ?`)
        .run(providerMessageId, channelId);
    },

    findThread(channelId, rootMessageId, senderKey) {
      return (
        (sql
          .prepare(
            `SELECT id, channel_id AS channelId, thread_id AS threadId, root_message_id AS rootMessageId,
                    sender_key AS senderKey
             FROM email_threads WHERE channel_id = ? AND root_message_id = ? AND sender_key = ?`,
          )
          .get(channelId, rootMessageId, senderKey) as EmailThreadRow | undefined) ?? null
      );
    },

    createThread(channelId, threadId, rootMessageId, senderKey) {
      const row: EmailThreadRow = { id: randomUUID(), channelId, threadId, rootMessageId, senderKey };
      sql
        .prepare(
          `INSERT INTO email_threads (id, channel_id, thread_id, root_message_id, sender_key) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.channelId, row.threadId, row.rootMessageId, row.senderKey);
      return row;
    },

    removeThread(id) {
      sql.prepare(`DELETE FROM email_threads WHERE id = ?`).run(id);
    },

    dropWorkspace(workspaceId) {
      sql.prepare(`DELETE FROM email_channels WHERE workspace_id = ?`).run(workspaceId);
    },
  };
}
