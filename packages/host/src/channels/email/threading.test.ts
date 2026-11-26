import { describe, expect, it } from "vitest";
import { readThreadHeaders, replyHeaders } from "./threading";

describe("readThreadHeaders", () => {
  it("keys a thread by the References root, else In-Reply-To, else the message's own id", () => {
    const first = readThreadHeaders({ "message-id": "<a@m>" });
    expect(first.threadKey).toBe("<a@m>");
    const reply = readThreadHeaders({
      "message-id": "<b@m>",
      "in-reply-to": "<a@m>",
      references: "<a@m>",
    });
    expect(reply.threadKey).toBe("<a@m>");
    expect(reply.inReplyTo).toBe("<a@m>");
    // A one-hop reply with no References threads on its In-Reply-To target.
    expect(readThreadHeaders({ "message-id": "<b@m>", "in-reply-to": "<a@m>" }).threadKey).toBe("<a@m>");
    // A deep thread keeps the root, not the parent.
    expect(readThreadHeaders({ "message-id": "<c@m>", references: "<a@m> <b@m>" }).threadKey).toBe("<a@m>");
    expect(readThreadHeaders({}).threadKey).toBeNull();
  });
});

describe("replyHeaders", () => {
  it("answers in-thread: In-Reply-To plus the full References chain", () => {
    const headers = replyHeaders({
      fromDomain: "mail.example.com",
      inReplyTo: "<b@m>",
      references: ["<a@m>"],
    });
    expect(headers.messageId).toMatch(/^<[^@]+@mail\.example\.com>$/);
    expect(headers.inReplyTo).toBe("<b@m>");
    expect(headers.references).toBe("<a@m> <b@m>");
  });

  it("sends only a Message-ID for a new thread", () => {
    const headers = replyHeaders({ fromDomain: "mail.example.com", inReplyTo: null, references: [] });
    expect(headers.inReplyTo).toBeUndefined();
    expect(headers.references).toBeUndefined();
  });
});
