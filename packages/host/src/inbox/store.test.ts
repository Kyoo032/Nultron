/**
 * The inbox store against a scratch SQLite database: the desk boundary, the one-number-one-desk rule,
 * idempotent inbound, the caps, forward-only delivery status, and the numbers on the Today strip.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INBOX_CAPS, WHATSAPP_WINDOW_MS } from "@agentforge/core/inbox";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { createInboxStore, type DeskScope, type EndpointRow, type InboxStore } from "./store";
import type { InboundMessage, InboundStatus } from "./whatsapp";

const deskA: DeskScope = { organizationId: "org-a", workspaceId: "desk-a" };
const deskB: DeskScope = { organizationId: "org-b", workspaceId: "desk-b" };
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const MIN = 60_000;

let db: Database.Database;
let store: InboxStore;
let counter = 0;

function endpointFor(scope: DeskScope, externalId: string): EndpointRow {
  return store.connectEndpoint(scope, { kind: "whatsapp", externalId, displayPhone: "+62 812", verifiedName: "Shop" }, NOW);
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  counter += 1;
  return {
    type: "message",
    phoneNumberId: "1000001",
    contactId: "6281200000001",
    contactName: "Dewi",
    messageId: `wamid.IN${counter}`,
    at: NOW,
    kind: "text",
    text: "Ada kopi?",
    ...overrides,
  };
}

function report(messageId: string, status: InboundStatus["status"], error: string | null = null): InboundStatus {
  return { type: "status", phoneNumberId: "1000001", messageId, status, at: NOW, error };
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  let id = 0;
  store = createInboxStore(db, () => {
    id += 1;
    return `id-${id}`;
  });
  counter = 0;
});

afterEach(() => {
  db.close();
});

describe("endpoints", () => {
  it("gives a number to one desk across the whole install", () => {
    endpointFor(deskA, "1000001");
    expect(() => endpointFor(deskB, "1000001")).toThrowError(expect.objectContaining({ code: "channel_conflict", status: 409 }));
    expect(count("channel_endpoints")).toBe(1);
  });

  it("finds an active number for the webhook, and no longer after a disconnect", () => {
    endpointFor(deskA, "1000001");
    expect(store.findActiveEndpoint("whatsapp", "1000001")).toMatchObject({ workspaceId: "desk-a", organizationId: "org-a" });
    expect(store.findActiveEndpoint("whatsapp", "9999999")).toBeNull();
    expect(store.disconnectEndpoint(deskA, "whatsapp", NOW)).toBe(1);
    expect(store.findActiveEndpoint("whatsapp", "1000001")).toBeNull();
    expect(store.endpointForDesk(deskA, "whatsapp")).toBeNull();
  });

  it("keeps the conversations through a disconnect, and picks them up again on reconnect", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    store.disconnectEndpoint(deskA, "whatsapp", NOW);
    expect(store.listConversations(deskA, {}, NOW)).toHaveLength(1);
    const again = endpointFor(deskA, "1000001");
    expect(again.id).toBe(endpoint.id);
    store.recordInbound(again, inbound({ text: "masih ada?" }), NOW);
    expect(store.listConversations(deskA, {}, NOW)).toHaveLength(1);
  });

  it("lets a desk move to a different number and keeps only one active", () => {
    endpointFor(deskA, "1000001");
    const second = endpointFor(deskA, "1000002");
    expect(store.endpointForDesk(deskA, "whatsapp")?.id).toBe(second.id);
    expect(store.findActiveEndpoint("whatsapp", "1000001")).toBeNull();
  });
});

describe("recordInbound", () => {
  it("opens a conversation that needs the owner, with one unread", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ text: "Ada kopi?" }), NOW);
    const [conversation] = store.listConversations(deskA, {}, NOW);
    expect(conversation).toMatchObject({
      contactId: "6281200000001",
      contactName: "Dewi",
      state: "needs_you",
      unreadCount: 1,
      lastMessagePreview: "Ada kopi?",
      lastMessageDirection: "in",
      lastInboundAt: NOW,
    });
    expect(conversation.window).toEqual({ open: true, closesAt: NOW + WHATSAPP_WINDOW_MS });
  });

  it("files a redelivered message once and changes nothing the second time", () => {
    const endpoint = endpointFor(deskA, "1000001");
    const message = inbound({ messageId: "wamid.SAME" });
    expect(store.recordInbound(endpoint, message, NOW).duplicate).toBe(false);
    expect(store.recordInbound(endpoint, message, NOW + MIN).duplicate).toBe(true);
    expect(count("customer_messages")).toBe(1);
    expect(store.listConversations(deskA, {}, NOW)[0].unreadCount).toBe(1);
  });

  it("puts a second message in the same conversation and counts it unread", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ at: NOW }), NOW);
    store.recordInbound(endpoint, inbound({ at: NOW + MIN, text: "halo?" }), NOW + MIN);
    const conversations = store.listConversations(deskA, {}, NOW + MIN);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ unreadCount: 2, lastMessagePreview: "halo?", lastMessageAt: NOW + MIN });
  });

  it("stores a late delivery without moving the preview or the order", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ at: NOW, text: "newer" }), NOW);
    store.recordInbound(endpoint, inbound({ at: NOW - 10 * MIN, text: "older" }), NOW);
    const [conversation] = store.listConversations(deskA, {}, NOW);
    expect(conversation.lastMessagePreview).toBe("newer");
    expect(conversation.lastMessageAt).toBe(NOW);
    expect(store.listMessages(deskA, conversation.id)?.map((row) => row.text)).toEqual(["older", "newer"]);
  });

  it("keeps the customer's name once known and ignores an empty one", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactName: "Dewi" }), NOW);
    store.recordInbound(endpoint, inbound({ contactName: "" }), NOW);
    expect(store.listConversations(deskA, {}, NOW)[0].contactName).toBe("Dewi");
    store.recordInbound(endpoint, inbound({ contactName: "Dewi L." }), NOW);
    expect(store.listConversations(deskA, {}, NOW)[0].contactName).toBe("Dewi L.");
  });

  it("falls back to the number when the customer has no profile name", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactName: "" }), NOW);
    expect(store.listConversations(deskA, {}, NOW)[0].contactName).toBe("6281200000001");
  });

  it("reopens a closed conversation when the customer writes again", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    store.setState(deskA, id, "closed", NOW);
    store.recordInbound(endpoint, inbound({ at: NOW + MIN }), NOW + MIN);
    expect(store.getConversation(deskA, id, NOW)?.state).toBe("needs_you");
  });

  it("keeps the newest 200 messages of a conversation", () => {
    const endpoint = endpointFor(deskA, "1000001");
    for (let index = 0; index < INBOX_CAPS.maxStoredMessages + 5; index += 1) {
      store.recordInbound(endpoint, inbound({ at: NOW + index * 1000, text: `m${index}` }), NOW);
    }
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    const messages = store.listMessages(deskA, id) ?? [];
    expect(messages).toHaveLength(INBOX_CAPS.maxStoredMessages);
    expect(messages[0].text).toBe("m5");
    expect(messages.at(-1)?.text).toBe(`m${INBOX_CAPS.maxStoredMessages + 4}`);
  });

  it("keeps the newest 500 conversations of a desk and takes the oldest with its messages", () => {
    const endpoint = endpointFor(deskA, "1000001");
    for (let index = 0; index < INBOX_CAPS.maxConversationsPerDesk + 3; index += 1) {
      store.recordInbound(
        endpoint,
        inbound({ contactId: String(6281300000000 + index), at: NOW + index * 1000 }),
        NOW,
      );
    }
    expect(count("customer_conversations")).toBe(INBOX_CAPS.maxConversationsPerDesk);
    expect(count("customer_messages")).toBe(INBOX_CAPS.maxConversationsPerDesk);
    const oldest = (db.prepare("SELECT min(contact_id) AS c FROM customer_conversations").get() as { c: string }).c;
    expect(oldest).toBe("6281300000003");
  });
});

describe("the desk boundary", () => {
  it("never shows, counts, searches or changes another desk's customers", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ text: "secret order" }), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;

    expect(store.listConversations(deskB, {}, NOW)).toEqual([]);
    expect(store.listConversations(deskB, { query: "Dewi" }, NOW)).toEqual([]);
    expect(store.getConversation(deskB, id, NOW)).toBeNull();
    expect(store.listMessages(deskB, id)).toBeNull();
    expect(store.markRead(deskB, id)).toBe(false);
    expect(store.setState(deskB, id, "closed", NOW)).toBe(false);
    expect(store.sendTarget(deskB, id, NOW)).toBeNull();
    expect(store.summary(deskB, NOW - 3600_000)).toMatchObject({ needsYou: 0, unread: 0, receivedToday: 0 });
    // The owner's own view is untouched by all of that.
    expect(store.getConversation(deskA, id, NOW)).toMatchObject({ state: "needs_you", unreadCount: 1 });
  });

  it("does not let an outbound settle a message of another desk", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    const queued = store.beginOutbound(deskA, id, "halo", NOW);
    expect(store.finishOutbound(deskB, queued.id, { ok: true, externalId: "wamid.X" }, NOW)).toBeNull();
    expect(store.listMessages(deskA, id)?.at(-1)).toMatchObject({ delivery: "queued", id: queued.id });
  });
});

describe("the owner's reply", () => {
  function openConversation() {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ at: NOW }), NOW);
    return store.listConversations(deskA, {}, NOW)[0].id;
  }

  it("writes the reply queued, then settles it and moves the conversation to with-you", () => {
    const id = openConversation();
    const queued = store.beginOutbound(deskA, id, "Ada, jam 9 buka.", NOW + MIN);
    expect(queued).toMatchObject({ direction: "out", sentBy: "owner", delivery: "queued" });
    const settled = store.finishOutbound(deskA, queued.id, { ok: true, externalId: "wamid.OUT1" }, NOW + MIN);
    expect(settled).toMatchObject({ delivery: "sent" });
    expect(store.getConversation(deskA, id, NOW + MIN)).toMatchObject({
      state: "with_you",
      unreadCount: 0,
      lastMessageDirection: "out",
      lastMessagePreview: "Ada, jam 9 buka.",
    });
  });

  it("shows a failed send in the thread and leaves the conversation as it was", () => {
    const id = openConversation();
    const queued = store.beginOutbound(deskA, id, "halo", NOW + MIN);
    const failed = store.finishOutbound(deskA, queued.id, { ok: false, error: "Token expired" }, NOW + MIN);
    expect(failed).toMatchObject({ delivery: "failed", deliveryError: "Token expired" });
    expect(store.getConversation(deskA, id, NOW + MIN)).toMatchObject({ state: "needs_you", unreadCount: 1, lastMessageDirection: "in" });
  });

  it("closes the window 24 hours after the customer's last message, and reopens it when they write", () => {
    const id = openConversation();
    expect(store.sendTarget(deskA, id, NOW + WHATSAPP_WINDOW_MS - 1)?.conversation.window.open).toBe(true);
    expect(store.sendTarget(deskA, id, NOW + WHATSAPP_WINDOW_MS)?.conversation.window.open).toBe(false);
    const endpoint = store.findActiveEndpoint("whatsapp", "1000001") as EndpointRow;
    store.recordInbound(endpoint, inbound({ at: NOW + WHATSAPP_WINDOW_MS + MIN }), NOW + WHATSAPP_WINDOW_MS + MIN);
    expect(store.sendTarget(deskA, id, NOW + WHATSAPP_WINDOW_MS + 2 * MIN)?.conversation.window.open).toBe(true);
  });
});

describe("delivery reports", () => {
  function sentMessage(externalId = "wamid.OUT1") {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    const queued = store.beginOutbound(deskA, id, "halo", NOW);
    store.finishOutbound(deskA, queued.id, { ok: true, externalId }, NOW);
    return { endpoint, id };
  }
  const deliveryOf = (id: string) => store.listMessages(deskA, id)?.at(-1)?.delivery;

  it("moves a message forward through delivered and read", () => {
    const { endpoint, id } = sentMessage();
    expect(store.applyStatus(endpoint, report("wamid.OUT1", "delivered"))).toBe(true);
    expect(deliveryOf(id)).toBe("delivered");
    store.applyStatus(endpoint, report("wamid.OUT1", "read"));
    expect(deliveryOf(id)).toBe("read");
  });

  it("never moves a status backwards when reports arrive out of order", () => {
    const { endpoint, id } = sentMessage();
    store.applyStatus(endpoint, report("wamid.OUT1", "read"));
    store.applyStatus(endpoint, report("wamid.OUT1", "delivered"));
    store.applyStatus(endpoint, report("wamid.OUT1", "sent"));
    expect(deliveryOf(id)).toBe("read");
  });

  it("records a failure with Meta's title, but not one that arrives after the customer has it", () => {
    const first = sentMessage("wamid.OUT1");
    store.applyStatus(first.endpoint, report("wamid.OUT1", "failed", "Undeliverable"));
    expect(store.listMessages(deskA, first.id)?.at(-1)).toMatchObject({ delivery: "failed", deliveryError: "Undeliverable" });
  });

  it("does not let a failure undo a delivered message", () => {
    const { endpoint, id } = sentMessage();
    store.applyStatus(endpoint, report("wamid.OUT1", "delivered"));
    store.applyStatus(endpoint, report("wamid.OUT1", "failed", "late"));
    expect(deliveryOf(id)).toBe("delivered");
  });

  it("ignores a report for a message this endpoint does not hold, including another desk's", () => {
    const { endpoint } = sentMessage();
    expect(store.applyStatus(endpoint, report("wamid.NOPE", "read"))).toBe(false);
    const other = endpointFor(deskB, "1000002");
    expect(store.applyStatus(other, report("wamid.OUT1", "read"))).toBe(false);
    expect(store.listMessages(deskA, store.listConversations(deskA, {}, NOW)[0].id)?.at(-1)?.delivery).toBe("sent");
  });
});

describe("listing", () => {
  it("filters by state and searches name and number, treating wildcards as text", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactId: "6281200000001", contactName: "Dewi", at: NOW }), NOW);
    store.recordInbound(endpoint, inbound({ contactId: "6281200000002", contactName: "Budi_100%", at: NOW + MIN }), NOW);
    const budi = store.listConversations(deskA, { query: "Budi" }, NOW)[0];
    store.setState(deskA, budi.id, "closed", NOW);

    expect(store.listConversations(deskA, {}, NOW).map((row) => row.contactName)).toEqual(["Budi_100%", "Dewi"]);
    expect(store.listConversations(deskA, { state: "closed" }, NOW).map((row) => row.contactName)).toEqual(["Budi_100%"]);
    expect(store.listConversations(deskA, { state: "needs_you" }, NOW).map((row) => row.contactName)).toEqual(["Dewi"]);
    expect(store.listConversations(deskA, { query: "0000002" }, NOW)).toHaveLength(1);
    expect(store.listConversations(deskA, { query: "%" }, NOW).map((row) => row.contactName)).toEqual(["Budi_100%"]);
    expect(store.listConversations(deskA, { query: "_" }, NOW).map((row) => row.contactName)).toEqual(["Budi_100%"]);
  });

  it("clears the unread count when the owner opens a conversation", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    expect(store.markRead(deskA, id)).toBe(true);
    expect(store.getConversation(deskA, id, NOW)?.unreadCount).toBe(0);
  });
});

describe("summary", () => {
  it("counts the states, today's messages and the median time to a first reply", () => {
    const endpoint = endpointFor(deskA, "1000001");
    const since = NOW - 60 * MIN;
    // Dewi asks at +0 and is answered after 2 minutes; Budi asks at +10 and is answered after 8.
    store.recordInbound(endpoint, inbound({ contactId: "6281200000001", at: NOW }), NOW);
    store.recordInbound(endpoint, inbound({ contactId: "6281200000002", at: NOW + 10 * MIN }), NOW);
    store.recordInbound(endpoint, inbound({ contactId: "6281200000003", at: NOW + 11 * MIN }), NOW);
    const [third, second, first] = store.listConversations(deskA, {}, NOW + 12 * MIN);
    const reply = (conversationId: string, at: number) => {
      const queued = store.beginOutbound(deskA, conversationId, "ok", at);
      store.finishOutbound(deskA, queued.id, { ok: true, externalId: `wamid.R${at}` }, at);
    };
    reply(first.id, NOW + 2 * MIN);
    reply(second.id, NOW + 18 * MIN);

    const summary = store.summary(deskA, since);
    expect(summary).toMatchObject({
      needsYou: 1,
      withYou: 2,
      closed: 0,
      receivedToday: 3,
      sentToday: 2,
      medianFirstReplySeconds: 5 * 60,
    });
    expect(third.state).toBe("needs_you");
  });

  it("has no median until the owner has replied, and does not count a failed send", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound(), NOW);
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    expect(store.summary(deskA, NOW - MIN).medianFirstReplySeconds).toBeNull();
    const queued = store.beginOutbound(deskA, id, "ok", NOW + MIN);
    store.finishOutbound(deskA, queued.id, { ok: false, error: "no" }, NOW + MIN);
    expect(store.summary(deskA, NOW - MIN)).toMatchObject({ sentToday: 0, medianFirstReplySeconds: null });
  });
});

describe("purgeDesk", () => {
  it("removes a desk's numbers, conversations and messages and leaves another desk alone", () => {
    const a = endpointFor(deskA, "1000001");
    const b = endpointFor(deskB, "1000002");
    store.recordInbound(a, inbound(), NOW);
    store.recordInbound(b, { ...inbound(), phoneNumberId: "1000002" }, NOW);
    expect(store.purgeDesk("desk-a")).toBe(1);
    expect(store.listConversations(deskA, {}, NOW)).toEqual([]);
    expect(store.listConversations(deskB, {}, NOW)).toHaveLength(1);
    expect(count("customer_messages")).toBe(1);
  });
});
