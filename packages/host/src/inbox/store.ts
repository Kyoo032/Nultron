/**
 * The customer inbox store — conversations and messages in SQLite, scoped to a desk.
 *
 * `createInboxStore` takes the database as an argument so a test hands it a scratch one; `inbox/db.ts`
 * binds it to the app database. Tables: drizzle/0023_customer_inbox.sql.
 *
 * **Every read and write names a desk.** A `DeskScope` is `{ organizationId, workspaceId }` and every
 * statement filters on `workspace_id`. A conversation id from another desk is simply not found (the
 * handlers turn that into a 404), so existence is never confirmed across desks.
 *
 * **Where a `DeskScope` comes from is the security question.** From a browser request it is the
 * signed-in tenant (`getTenant`). From the WhatsApp webhook it is the endpoint row that the payload's
 * phone number id resolves to — only after the signature has passed (`webhook.ts`). Nothing in a
 * payload can name a desk.
 */

import type Database from "better-sqlite3";
import { ApiError } from "@agentforge/core";
import {
  INBOX_CAPS,
  inboxDisplayText,
  nextDeliveryStatus,
  previewOf,
  replyWindowFor,
  type ConversationState,
  type CustomerConversation,
  type CustomerMessage,
  type DeliveryStatus,
  type InboxKind,
  type InboxSummary,
  type MessageDirection,
  type MessageKind,
  type MessageSender,
} from "@agentforge/core/inbox";
import type { InboundMessage, InboundStatus } from "./whatsapp";

type TransactionBody = Parameters<Database.Database["transaction"]>[0];

export type InboxSql = Pick<Database.Database, "prepare"> & {
  transaction<F extends TransactionBody>(fn: F): Database.Transaction<F>;
};

export type DeskScope = { organizationId: string; workspaceId: string };

export type EndpointRow = {
  id: string;
  organizationId: string;
  workspaceId: string;
  kind: InboxKind;
  externalId: string;
  displayPhone: string | null;
  verifiedName: string | null;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
};

type EndpointDb = {
  id: string;
  organization_id: string;
  workspace_id: string;
  kind: InboxKind;
  external_id: string;
  display_phone: string | null;
  verified_name: string | null;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
};

type ConversationDb = {
  id: string;
  endpoint_id: string;
  kind: InboxKind;
  contact_id: string;
  contact_name: string;
  state: ConversationState;
  unread_count: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  last_message_at: number;
  last_message_preview: string;
  last_message_direction: MessageDirection;
  created_at: number;
};

type MessageDb = {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  sent_by: MessageSender;
  kind: MessageKind;
  text: string;
  delivery: DeliveryStatus | null;
  delivery_error: string | null;
  created_at: number;
};

function endpointOf(row: EndpointDb): EndpointRow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    externalId: row.external_id,
    displayPhone: row.display_phone,
    verifiedName: row.verified_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversationOf(row: ConversationDb, now: number): CustomerConversation {
  return {
    id: row.id,
    kind: row.kind,
    contactId: row.contact_id,
    contactName: row.contact_name,
    state: row.state,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageDirection: row.last_message_direction,
    lastInboundAt: row.last_inbound_at,
    window: replyWindowFor(row.kind, row.last_inbound_at, now),
    createdAt: row.created_at,
  };
}

function messageOf(row: MessageDb): CustomerMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    sentBy: row.sent_by,
    kind: row.kind,
    text: row.text,
    delivery: row.delivery,
    deliveryError: row.delivery_error,
    at: row.created_at,
  };
}

/** What an owner reply needs to be sent: the conversation and the number it goes out from. */
export type SendTarget = { conversation: CustomerConversation; endpoint: EndpointRow };

export type InboundOutcome = { duplicate: boolean; conversationId: string };

/** `LIKE` wildcards in a search box are literal text, not patterns. */
function likePattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export type ConnectEndpointInput = {
  kind: InboxKind;
  externalId: string;
  displayPhone: string | null;
  verifiedName: string | null;
};

export type ListFilter = { state?: ConversationState; query?: string; limit?: number };

export type InboxStore = ReturnType<typeof createInboxStore>;

export function createInboxStore(sql: InboxSql, newId: () => string = () => crypto.randomUUID()) {
  /* ------------------------------------------------------------------------------ endpoints */

  function findActiveEndpoint(kind: InboxKind, externalId: string): EndpointRow | null {
    const row = sql
      .prepare("SELECT * FROM channel_endpoints WHERE kind = ? AND external_id = ? AND status = 'active'")
      .get(kind, externalId) as EndpointDb | undefined;
    return row ? endpointOf(row) : null;
  }

  function endpointForDesk(scope: DeskScope, kind: InboxKind): EndpointRow | null {
    const row = sql
      .prepare(
        "SELECT * FROM channel_endpoints WHERE workspace_id = ? AND kind = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(scope.workspaceId, kind) as EndpointDb | undefined;
    return row ? endpointOf(row) : null;
  }

  /**
   * Register a number for this desk, or take it back after a disconnect.
   *
   * An active number belongs to exactly one desk on the whole install: the partial unique index is
   * over `(kind, external_id)` and a second desk gets a 409 here before it reaches the index. A desk has
   * one active number per kind; connecting a different one disables the old one and keeps its
   * conversations.
   */
  const connectEndpoint = sql.transaction((scope: DeskScope, input: ConnectEndpointInput, now: number): EndpointRow => {
    const active = sql
      .prepare("SELECT * FROM channel_endpoints WHERE kind = ? AND external_id = ? AND status = 'active'")
      .get(input.kind, input.externalId) as EndpointDb | undefined;
    if (active && active.workspace_id !== scope.workspaceId) {
      throw new ApiError("channel_conflict", "That number is already connected to another desk", 409);
    }
    const existing =
      active ??
      (sql
        .prepare(
          "SELECT * FROM channel_endpoints WHERE kind = ? AND external_id = ? AND workspace_id = ? ORDER BY updated_at DESC, id LIMIT 1",
        )
        .get(input.kind, input.externalId, scope.workspaceId) as EndpointDb | undefined);
    sql
      .prepare(
        "UPDATE channel_endpoints SET status = 'disabled', updated_at = ? WHERE workspace_id = ? AND kind = ? AND status = 'active' AND external_id <> ?",
      )
      .run(now, scope.workspaceId, input.kind, input.externalId);
    if (existing) {
      sql
        .prepare(
          "UPDATE channel_endpoints SET status = 'active', display_phone = ?, verified_name = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.displayPhone, input.verifiedName, now, existing.id);
      return endpointOf({
        ...existing,
        status: "active",
        display_phone: input.displayPhone,
        verified_name: input.verifiedName,
        updated_at: now,
      });
    }
    const id = newId();
    sql
      .prepare(
        `INSERT INTO channel_endpoints
           (id, organization_id, workspace_id, kind, external_id, display_phone, verified_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        scope.organizationId,
        scope.workspaceId,
        input.kind,
        input.externalId,
        input.displayPhone,
        input.verifiedName,
        now,
        now,
      );
    return endpointOf({
      id,
      organization_id: scope.organizationId,
      workspace_id: scope.workspaceId,
      kind: input.kind,
      external_id: input.externalId,
      display_phone: input.displayPhone,
      verified_name: input.verifiedName,
      status: "active",
      created_at: now,
      updated_at: now,
    });
  });

  /** Stop receiving on this desk's number. The conversations stay; reconnecting picks them up. */
  function disconnectEndpoint(scope: DeskScope, kind: InboxKind, now: number): number {
    return Number(
      sql
        .prepare(
          "UPDATE channel_endpoints SET status = 'disabled', updated_at = ? WHERE workspace_id = ? AND kind = ? AND status = 'active'",
        )
        .run(now, scope.workspaceId, kind).changes ?? 0,
    );
  }

  /* ------------------------------------------------------------------------------- inbound */

  /**
   * File one customer message. Idempotent: Meta delivers at least once, and the second copy is
   * refused by the unique index inside the same transaction, so a redelivery changes nothing.
   *
   * The scope is the **endpoint's**, never anything from the payload. A late delivery (older than
   * the conversation's newest message) is stored but does not move the preview or the order.
   */
  const recordInbound = sql.transaction((endpoint: EndpointRow, message: InboundMessage, now: number): InboundOutcome => {
    const name = inboxDisplayText(message.contactName, "");
    const existing = sql
      .prepare("SELECT * FROM customer_conversations WHERE endpoint_id = ? AND contact_id = ?")
      .get(endpoint.id, message.contactId) as ConversationDb | undefined;

    let conversationId = existing?.id ?? "";
    if (!existing) {
      conversationId = newId();
      sql
        .prepare(
          `INSERT INTO customer_conversations
             (id, organization_id, workspace_id, endpoint_id, kind, contact_id, contact_name, state, unread_count,
              last_inbound_at, last_outbound_at, last_message_at, last_message_preview, last_message_direction,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_you', 0, NULL, NULL, ?, '', 'in', ?, ?)`,
        )
        .run(
          conversationId,
          endpoint.organizationId,
          endpoint.workspaceId,
          endpoint.id,
          endpoint.kind,
          message.contactId,
          name || message.contactId,
          message.at,
          now,
          now,
        );
    }

    const inserted = sql
      .prepare(
        `INSERT OR IGNORE INTO customer_messages
           (id, workspace_id, conversation_id, direction, sent_by, kind, external_id, text, delivery, delivery_error, created_at)
         VALUES (?, ?, ?, 'in', 'customer', ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(newId(), endpoint.workspaceId, conversationId, message.kind, message.messageId, message.text, message.at);
    if (Number(inserted.changes ?? 0) === 0) {
      return { duplicate: true, conversationId };
    }

    const newest = !existing || message.at >= existing.last_message_at;
    sql
      .prepare(
        `UPDATE customer_conversations SET
           contact_name = CASE WHEN ? <> '' THEN ? ELSE contact_name END,
           state = CASE WHEN state = 'auto' THEN state ELSE 'needs_you' END,
           unread_count = unread_count + 1,
           last_inbound_at = CASE WHEN last_inbound_at IS NULL OR ? > last_inbound_at THEN ? ELSE last_inbound_at END,
           last_message_at = CASE WHEN ? THEN ? ELSE last_message_at END,
           last_message_preview = CASE WHEN ? THEN ? ELSE last_message_preview END,
           last_message_direction = CASE WHEN ? THEN 'in' ELSE last_message_direction END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        name,
        message.at,
        message.at,
        newest ? 1 : 0,
        message.at,
        newest ? 1 : 0,
        previewOf(message.text),
        newest ? 1 : 0,
        now,
        conversationId,
      );

    return { duplicate: false, conversationId };
  });

  /**
   * Apply a delivery report to an outbound message of this endpoint. Never moves a status backwards
   * (Meta's order is not guaranteed). Returns false when no message of this endpoint has that id.
   */
  const applyStatus = sql.transaction((endpoint: EndpointRow, report: InboundStatus): boolean => {
    const row = sql
      .prepare(
        `SELECT m.id AS id, m.delivery AS delivery
           FROM customer_messages m
           JOIN customer_conversations c ON c.id = m.conversation_id
          WHERE m.external_id = ? AND m.direction = 'out' AND c.endpoint_id = ?`,
      )
      .get(report.messageId, endpoint.id) as { id: string; delivery: DeliveryStatus | null } | undefined;
    if (!row) {
      return false;
    }
    const next = nextDeliveryStatus(row.delivery ?? "queued", report.status);
    sql
      .prepare("UPDATE customer_messages SET delivery = ?, delivery_error = ? WHERE id = ?")
      .run(next, next === "failed" ? report.error : null, row.id);
    return true;
  });

  /* ------------------------------------------------------------------------- the dashboard */

  function listConversations(scope: DeskScope, filter: ListFilter, now: number): CustomerConversation[] {
    const clauses = ["workspace_id = ?"];
    const params: Array<string | number> = [scope.workspaceId];
    if (filter.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    const query = filter.query?.trim();
    if (query) {
      clauses.push("(contact_name LIKE ? ESCAPE '\\' OR contact_id LIKE ? ESCAPE '\\')");
      params.push(likePattern(query), likePattern(query));
    }
    const limit = Math.min(Math.max(1, filter.limit ?? INBOX_CAPS.maxListed), INBOX_CAPS.maxListed);
    const rows = sql
      .prepare(
        `SELECT * FROM customer_conversations WHERE ${clauses.join(" AND ")}
          ORDER BY last_message_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as ConversationDb[];
    return rows.map((row) => conversationOf(row, now));
  }

  function getConversation(scope: DeskScope, conversationId: string, now: number): CustomerConversation | null {
    const row = sql
      .prepare("SELECT * FROM customer_conversations WHERE id = ? AND workspace_id = ?")
      .get(conversationId, scope.workspaceId) as ConversationDb | undefined;
    return row ? conversationOf(row, now) : null;
  }

  function listMessages(scope: DeskScope, conversationId: string): CustomerMessage[] | null {
    if (!getConversation(scope, conversationId, 0)) {
      return null;
    }
    // The newest `maxThreadMessages`, shown oldest first. Older ones stay stored (see `INBOX_CAPS`).
    const rows = sql
      .prepare(
        `SELECT * FROM (
           SELECT *, rowid AS seq FROM customer_messages WHERE conversation_id = ? AND workspace_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?
         ) ORDER BY created_at ASC, seq ASC`,
      )
      .all(conversationId, scope.workspaceId, INBOX_CAPS.maxThreadMessages) as MessageDb[];
    return rows.map(messageOf);
  }

  /**
   * Erase one customer from this desk: the conversation and every message in it, for good. This is the
   * only way a stored message goes (nothing expires). The scope is the signed-in desk's, so another
   * desk's id erases nothing and reads as not found. Returns false for an id that is not this desk's.
   */
  const eraseConversation = sql.transaction((scope: DeskScope, conversationId: string): boolean => {
    const row = sql
      .prepare("SELECT id FROM customer_conversations WHERE id = ? AND workspace_id = ?")
      .get(conversationId, scope.workspaceId);
    if (!row) {
      return false;
    }
    // Explicit rather than trusting the cascade: this is the call that has to leave nothing behind.
    sql.prepare("DELETE FROM customer_messages WHERE conversation_id = ? AND workspace_id = ?").run(conversationId, scope.workspaceId);
    sql.prepare("DELETE FROM customer_conversations WHERE id = ? AND workspace_id = ?").run(conversationId, scope.workspaceId);
    return true;
  });

  function markRead(scope: DeskScope, conversationId: string): boolean {
    return (
      Number(
        sql
          .prepare("UPDATE customer_conversations SET unread_count = 0 WHERE id = ? AND workspace_id = ?")
          .run(conversationId, scope.workspaceId).changes ?? 0,
      ) > 0
    );
  }

  function setState(scope: DeskScope, conversationId: string, state: "needs_you" | "with_you" | "closed", now: number): boolean {
    return (
      Number(
        sql
          .prepare("UPDATE customer_conversations SET state = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
          .run(state, now, conversationId, scope.workspaceId).changes ?? 0,
      ) > 0
    );
  }

  /** The conversation and the number an owner reply goes out from, or null for another desk's id. */
  function sendTarget(scope: DeskScope, conversationId: string, now: number): SendTarget | null {
    const row = sql
      .prepare("SELECT * FROM customer_conversations WHERE id = ? AND workspace_id = ?")
      .get(conversationId, scope.workspaceId) as ConversationDb | undefined;
    if (!row) {
      return null;
    }
    const endpoint = sql
      .prepare("SELECT * FROM channel_endpoints WHERE id = ? AND workspace_id = ?")
      .get(row.endpoint_id, scope.workspaceId) as EndpointDb | undefined;
    return endpoint ? { conversation: conversationOf(row, now), endpoint: endpointOf(endpoint) } : null;
  }

  /** Write the owner's reply as `queued` before the send, so a failed send is visible in the thread. */
  function beginOutbound(scope: DeskScope, conversationId: string, text: string, now: number): CustomerMessage {
    const id = newId();
    sql
      .prepare(
        `INSERT INTO customer_messages
           (id, workspace_id, conversation_id, direction, sent_by, kind, external_id, text, delivery, delivery_error, created_at)
         VALUES (?, ?, ?, 'out', 'owner', 'text', NULL, ?, 'queued', NULL, ?)`,
      )
      .run(id, scope.workspaceId, conversationId, text, now);
    return messageOf(
      sql.prepare("SELECT * FROM customer_messages WHERE id = ?").get(id) as MessageDb,
    );
  }

  /**
   * Settle a queued reply. On success the conversation moves to `with_you` and its unread count
   * clears; on failure the message shows `failed` and the conversation is left exactly as it was.
   */
  const finishOutbound = sql.transaction(
    (
      scope: DeskScope,
      messageId: string,
      result: { ok: true; externalId: string } | { ok: false; error: string },
      now: number,
    ): CustomerMessage | null => {
      const row = sql
        .prepare("SELECT * FROM customer_messages WHERE id = ? AND workspace_id = ? AND direction = 'out'")
        .get(messageId, scope.workspaceId) as MessageDb | undefined;
      if (!row) {
        return null;
      }
      if (result.ok) {
        // A status webhook can beat us here with `delivered` or `read`; the id is stored either way
        // and the status only moves forward.
        const next = nextDeliveryStatus(row.delivery ?? "queued", "sent");
        sql
          .prepare("UPDATE customer_messages SET external_id = ?, delivery = ?, delivery_error = NULL WHERE id = ?")
          .run(result.externalId, next, messageId);
        sql
          .prepare(
            `UPDATE customer_conversations SET
               state = 'with_you', unread_count = 0, last_outbound_at = ?,
               last_message_at = CASE WHEN ? >= last_message_at THEN ? ELSE last_message_at END,
               last_message_preview = CASE WHEN ? >= last_message_at THEN ? ELSE last_message_preview END,
               last_message_direction = CASE WHEN ? >= last_message_at THEN 'out' ELSE last_message_direction END,
               updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
          )
          .run(
            row.created_at,
            row.created_at,
            row.created_at,
            row.created_at,
            previewOf(row.text),
            row.created_at,
            now,
            row.conversation_id,
            scope.workspaceId,
          );
      } else {
        sql
          .prepare("UPDATE customer_messages SET delivery = 'failed', delivery_error = ? WHERE id = ?")
          .run(inboxDisplayText(result.error, "The message could not be sent"), messageId);
      }
      return messageOf(sql.prepare("SELECT * FROM customer_messages WHERE id = ?").get(messageId) as MessageDb);
    },
  );

  /**
   * The numbers on the Today strip. `since` is the start of the owner's day, from their browser; the
   * median reply time pairs each owner reply with the first customer message it answered.
   */
  function summary(scope: DeskScope, since: number): InboxSummary {
    const counts = sql
      .prepare(
        `SELECT state, count(*) AS n, coalesce(sum(unread_count), 0) AS unread
           FROM customer_conversations WHERE workspace_id = ? GROUP BY state`,
      )
      .all(scope.workspaceId) as Array<{ state: ConversationState; n: number; unread: number }>;
    const by = (state: ConversationState) => counts.find((row) => row.state === state)?.n ?? 0;
    const today = sql
      .prepare(
        `SELECT
           coalesce(sum(CASE WHEN direction = 'in' THEN 1 ELSE 0 END), 0) AS received,
           coalesce(sum(CASE WHEN direction = 'out' AND delivery <> 'failed' THEN 1 ELSE 0 END), 0) AS sent
           FROM customer_messages WHERE workspace_id = ? AND created_at >= ?`,
      )
      .get(scope.workspaceId, since) as { received: number; sent: number };

    // Look back a day before `since`, so a question asked last night and answered this morning counts.
    const recent = sql
      .prepare(
        `SELECT conversation_id AS conversationId, direction, delivery, created_at AS at
           FROM customer_messages WHERE workspace_id = ? AND created_at >= ?
          ORDER BY conversation_id, created_at, rowid LIMIT 5000`,
      )
      .all(scope.workspaceId, since - 24 * 60 * 60 * 1000) as Array<{
      conversationId: string;
      direction: MessageDirection;
      delivery: DeliveryStatus | null;
      at: number;
    }>;
    const waits: number[] = [];
    let current = "";
    let pending: number | null = null;
    for (const row of recent) {
      if (row.conversationId !== current) {
        current = row.conversationId;
        pending = null;
      }
      if (row.direction === "in") {
        pending ??= row.at;
      } else if (pending !== null && row.delivery !== "failed") {
        if (row.at >= since) {
          waits.push(Math.max(0, Math.round((row.at - pending) / 1000)));
        }
        pending = null;
      }
    }
    waits.sort((a, b) => a - b);
    const middle = Math.floor(waits.length / 2);
    const median =
      waits.length === 0 ? null : waits.length % 2 === 1 ? waits[middle] : Math.round((waits[middle - 1] + waits[middle]) / 2);
    return {
      needsYou: by("needs_you"),
      withYou: by("with_you"),
      closed: by("closed"),
      unread: counts.reduce((sum, row) => sum + Number(row.unread ?? 0), 0),
      receivedToday: Number(today.received ?? 0),
      sentToday: Number(today.sent ?? 0),
      medianFirstReplySeconds: median,
    };
  }

  /** Delete every endpoint of a desk; conversations and messages follow through the foreign keys. */
  function purgeDesk(workspaceId: string): number {
    return Number(sql.prepare("DELETE FROM channel_endpoints WHERE workspace_id = ?").run(workspaceId).changes ?? 0);
  }

  return {
    findActiveEndpoint,
    endpointForDesk,
    connectEndpoint,
    disconnectEndpoint,
    recordInbound,
    applyStatus,
    listConversations,
    getConversation,
    listMessages,
    markRead,
    setState,
    eraseConversation,
    sendTarget,
    beginOutbound,
    finishOutbound,
    summary,
    purgeDesk,
  };
}
