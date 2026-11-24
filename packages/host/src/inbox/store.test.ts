/**
 * The inbox store against a scratch SQLite database: the desk boundary, the one-number-one-desk rule,
 * idempotent inbound, keep-everything (no expiry) with erase on request, forward-only delivery status, and the numbers on the Today strip.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEnvelope } from "@agentforge/core";
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

  it("releases a disconnected number without moving its conversations to the new desk", () => {
    const old = endpointFor(deskA, "1000001");
    store.recordInbound(old, inbound({ text: "old desk only" }), NOW);
    const conversation = store.listConversations(deskA, {}, NOW)[0];
    store.disconnectEndpoint(deskA, "whatsapp", NOW);
    const next = endpointFor(deskB, "1000001");
    expect(next.id).not.toBe(old.id);
    expect(store.findActiveEndpoint("whatsapp", "1000001")).toMatchObject({
      id: next.id,
      workspaceId: deskB.workspaceId,
    });
    expect(db.prepare("SELECT status FROM channel_endpoints WHERE id = ?").get(old.id)).toEqual({ status: "disabled" });
    expect(store.listConversations(deskB, {}, NOW)).toEqual([]);
    expect(store.getConversation(deskB, conversation.id, NOW)).toBeNull();
    expect(store.listMessages(deskB, conversation.id)).toBeNull();
    expect(store.listMessages(deskA, conversation.id)?.map((row) => row.text)).toEqual(["old desk only"]);
    expect(() => endpointFor(deskA, "1000001")).toThrowError(
      expect.objectContaining({ code: "channel_conflict", status: 409 }),
    );
    store.recordInbound(
      store.findActiveEndpoint("whatsapp", "1000001") as EndpointRow,
      inbound({ text: "new desk only" }),
      NOW,
    );
    expect(store.listConversations(deskB, {}, NOW)).toHaveLength(1);
    expect(store.listMessages(deskA, conversation.id)).toHaveLength(1);
    store.disconnectEndpoint(deskB, "whatsapp", NOW);
    expect(endpointFor(deskB, "1000001").id).toBe(next.id);
    store.disconnectEndpoint(deskB, "whatsapp", NOW);
    expect(endpointFor(deskA, "1000001").id).toBe(old.id);
    expect(count("channel_endpoints")).toBe(2);
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

  it("keeps every message and every conversation: nothing is deleted for age or count", () => {
    const endpoint = endpointFor(deskA, "1000001");
    const extra = 20;
    for (let index = 0; index < INBOX_CAPS.maxThreadMessages + extra; index += 1) {
      store.recordInbound(endpoint, inbound({ at: NOW + index * 1000, text: `m${index}` }), NOW);
    }
    for (let index = 0; index < INBOX_CAPS.maxListed + 20; index += 1) {
      store.recordInbound(
        endpoint,
        inbound({ contactId: String(6281300000000 + index), at: NOW - (index + 1) * 60 * MIN }),
        NOW,
      );
    }
    expect(count("customer_messages")).toBe(INBOX_CAPS.maxThreadMessages + extra + INBOX_CAPS.maxListed + 20);
    expect(count("customer_conversations")).toBe(1 + INBOX_CAPS.maxListed + 20);
  });

  it("reads the newest messages of a long thread, oldest first, and still stores the rest", () => {
    const endpoint = endpointFor(deskA, "1000001");
    const extra = 7;
    for (let index = 0; index < INBOX_CAPS.maxThreadMessages + extra; index += 1) {
      store.recordInbound(endpoint, inbound({ at: NOW + index * 1000, text: `m${index}` }), NOW);
    }
    const id = store.listConversations(deskA, {}, NOW)[0].id;
    const messages = store.listMessages(deskA, id) ?? [];
    expect(messages).toHaveLength(INBOX_CAPS.maxThreadMessages);
    expect(messages[0].text).toBe(`m${extra}`);
    expect(messages.at(-1)?.text).toBe(`m${INBOX_CAPS.maxThreadMessages + extra - 1}`);
    expect(count("customer_messages")).toBe(INBOX_CAPS.maxThreadMessages + extra);
  });

  it("lists the newest conversations but still finds an older one by search", () => {
    const endpoint = endpointFor(deskA, "1000001");
    const total = INBOX_CAPS.maxListed + 5;
    for (let index = 0; index < total; index += 1) {
      store.recordInbound(
        endpoint,
        inbound({ contactId: String(6281300000000 + index), contactName: `Customer ${index}`, at: NOW - index * MIN }),
        NOW,
      );
    }
    const listed = store.listConversations(deskA, {}, NOW);
    expect(listed).toHaveLength(INBOX_CAPS.maxListed);
    expect(listed.some((row) => row.contactName === `Customer ${total - 1}`)).toBe(false);
    expect(store.listConversations(deskA, { query: `Customer ${total - 1}` }, NOW)).toHaveLength(1);
  });
});

describe("erasing a customer", () => {
  function twoCustomers() {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactId: "6281200000001", contactName: "Dewi", text: "Ada kopi?" }), NOW);
    store.recordInbound(endpoint, inbound({ contactId: "6281200000002", contactName: "Budi", text: "Ada teh?" }), NOW);
    const rows = store.listConversations(deskA, {}, NOW);
    const dewi = rows.find((row) => row.contactName === "Dewi");
    const budi = rows.find((row) => row.contactName === "Budi");
    if (!dewi || !budi) {
      throw new Error("seed failed");
    }
    return { endpoint, dewi, budi };
  }

  it("removes the conversation and every message in it, and leaves the other customer alone", () => {
    const { dewi, budi } = twoCustomers();
    const queued = store.beginOutbound(deskA, dewi.id, "Ada, Kak", NOW);
    store.finishOutbound(deskA, queued.id, { ok: true, externalId: "wamid.OUT1" }, NOW);
    expect(count("customer_messages")).toBe(3);

    expect(store.eraseConversation(deskA, dewi.id)).toBe(true);

    expect(store.getConversation(deskA, dewi.id, NOW)).toBeNull();
    expect(store.listMessages(deskA, dewi.id)).toBeNull();
    expect(store.listConversations(deskA, { query: "Dewi" }, NOW)).toEqual([]);
    expect(count("customer_messages")).toBe(1);
    expect(count("customer_conversations")).toBe(1);
    expect(store.listMessages(deskA, budi.id)?.map((row) => row.text)).toEqual(["Ada teh?"]);
    expect(store.summary(deskA, NOW - 3600_000)).toMatchObject({ receivedToday: 1, sentToday: 0 });
  });

  it("reads another desk's id, a made-up id and a second erase alike: false, and nothing changes", () => {
    const { dewi } = twoCustomers();
    expect(store.eraseConversation(deskB, dewi.id)).toBe(false);
    expect(store.eraseConversation(deskA, "does-not-exist")).toBe(false);
    expect(count("customer_conversations")).toBe(2);
    expect(store.eraseConversation(deskA, dewi.id)).toBe(true);
    expect(store.eraseConversation(deskA, dewi.id)).toBe(false);
  });

  it("starts a fresh conversation, with none of the old messages, when the same customer writes again", () => {
    const { endpoint, dewi } = twoCustomers();
    store.eraseConversation(deskA, dewi.id);
    store.recordInbound(endpoint, inbound({ contactId: "6281200000001", contactName: "Dewi", text: "halo lagi" }), NOW + MIN);
    const again = store.listConversations(deskA, { query: "Dewi" }, NOW + MIN);
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(dewi.id);
    expect(store.listMessages(deskA, again[0].id)?.map((row) => row.text)).toEqual(["halo lagi"]);
  });

  it("drops a late delivery report for a message that is gone", () => {
    const { endpoint, dewi } = twoCustomers();
    const queued = store.beginOutbound(deskA, dewi.id, "Ada, Kak", NOW);
    store.finishOutbound(deskA, queued.id, { ok: true, externalId: "wamid.OUT1" }, NOW);
    store.eraseConversation(deskA, dewi.id);
    expect(store.applyStatus(endpoint, report("wamid.OUT1", "read"))).toBe(false);
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

describe("encryption at rest (SR-193)", () => {
  it("seals contact_name, last_message_preview, and message text in SQLite while keeping webhook lookup and search working", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactId: "6281299990001", contactName: "Siti Rahma", text: "Confidential order #44" }), NOW);

    const rawConv = db
      .prepare("SELECT contact_id, contact_name, last_message_preview FROM customer_conversations WHERE endpoint_id = ? AND contact_id = ?")
      .get(endpoint.id, "6281299990001") as { contact_id: string; contact_name: string; last_message_preview: string };
    expect(rawConv.contact_id).toBe("6281299990001");
    expect(rawConv.contact_name).not.toContain("Siti Rahma");
    expect(rawConv.last_message_preview).not.toContain("Confidential order #44");
    expect(isEnvelope(JSON.parse(rawConv.contact_name))).toBe(true);
    expect(isEnvelope(JSON.parse(rawConv.last_message_preview))).toBe(true);

    const rawMsg = db.prepare("SELECT text FROM customer_messages").get() as { text: string };
    expect(rawMsg.text).not.toContain("Confidential order #44");
    expect(isEnvelope(JSON.parse(rawMsg.text))).toBe(true);

    // Owner reply seals outbound text and preview
    const conv = store.listConversations(deskA, { query: "rahma" }, NOW)[0];
    expect(conv.contactName).toBe("Siti Rahma");
    expect(conv.lastMessagePreview).toBe("Confidential order #44");

    const queued = store.beginOutbound(deskA, conv.id, "Private reply 77", NOW + MIN);
    store.finishOutbound(deskA, queued.id, { ok: true, externalId: "wamid.PRIV1" }, NOW + MIN);

    const rawAfter = db
      .prepare("SELECT last_message_preview FROM customer_conversations WHERE id = ?")
      .get(conv.id) as { last_message_preview: string };
    expect(rawAfter.last_message_preview).not.toContain("Private reply 77");
    expect(isEnvelope(JSON.parse(rawAfter.last_message_preview))).toBe(true);
    expect(store.getConversation(deskA, conv.id, NOW + MIN)?.lastMessagePreview).toBe("Private reply 77");
  });

  it("reads legacy plaintext customer rows cleanly as fallback", () => {
    const endpoint = endpointFor(deskA, "1000001");
    store.recordInbound(endpoint, inbound({ contactId: "6281299990002", contactName: "Placeholder", text: "placeholder" }), NOW);
    const conv = store.listConversations(deskA, {}, NOW)[0];
    db.prepare("UPDATE customer_conversations SET contact_name = ?, last_message_preview = ? WHERE id = ?").run(
      "Legacy Customer",
      "Legacy preview",
      conv.id,
    );
    db.prepare("UPDATE customer_messages SET text = ? WHERE conversation_id = ?").run("Legacy text", conv.id);

    expect(store.getConversation(deskA, conv.id, NOW)).toMatchObject({
      contactName: "Legacy Customer",
      lastMessagePreview: "Legacy preview",
    });
    expect(store.listMessages(deskA, conv.id)?.map((m) => m.text)).toEqual(["Legacy text"]);
  });
});
