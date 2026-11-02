/**
 * The WhatsApp wire work: who may call the webhook, what a payload is allowed to become, and what
 * the Graph client sends. Everything here is a pure function or runs against the in-memory Meta
 * sandbox, so a code path that reached the real network would fail loudly.
 */
import { describe, expect, it } from "vitest";
import { INBOX_CAPS } from "@agentforge/core/inbox";
import {
  SANDBOX_ACCESS_TOKEN,
  SANDBOX_APP_SECRET,
  SANDBOX_PHONE_NUMBER_ID,
  SANDBOX_VERIFY_TOKEN,
  createMetaSandbox,
} from "./__fixtures__/meta-api";
import { WHATSAPP_APP_SECRET_ENV, WHATSAPP_VERIFY_TOKEN_ENV } from "./webhook-path";
import {
  WHATSAPP_WINDOW_CLOSED_CODE,
  WhatsAppClient,
  parseWebhook,
  redactToken,
  signBody,
  verifyHandshake,
  verifySignature,
} from "./whatsapp";

const ENV = { [WHATSAPP_APP_SECRET_ENV]: SANDBOX_APP_SECRET, [WHATSAPP_VERIFY_TOKEN_ENV]: SANDBOX_VERIFY_TOKEN };
const bytes = (text: string) => new TextEncoder().encode(text);

describe("verifySignature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts the signature Meta would send for exactly these bytes", () => {
    expect(verifySignature(bytes(body), signBody(body, SANDBOX_APP_SECRET), ENV)).toEqual({ ok: true });
  });

  it("refuses a body that changed by a single character", () => {
    const verdict = verifySignature(bytes(`${body} `), signBody(body, SANDBOX_APP_SECRET), ENV);
    expect(verdict).toMatchObject({ ok: false, code: "whatsapp_unauthorized" });
  });

  it("refuses a signature made with another secret", () => {
    expect(verifySignature(bytes(body), signBody(body, "someone-elses-secret"), ENV)).toMatchObject({
      ok: false,
      code: "whatsapp_unauthorized",
    });
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["no sha256= prefix", signBody(body, SANDBOX_APP_SECRET).slice("sha256=".length)],
    ["the sha1 scheme", `sha1=${"a".repeat(40)}`],
    ["a short digest", "sha256=abc"],
    ["a digest that is not hex", `sha256=${"z".repeat(64)}`],
  ])("refuses %s", (_label, header) => {
    expect(verifySignature(bytes(body), header, ENV)).toMatchObject({ ok: false, code: "whatsapp_unauthorized" });
  });

  it("refuses a request with no body bytes, even with a well-formed header", () => {
    expect(verifySignature(undefined, signBody(body, SANDBOX_APP_SECRET), ENV)).toMatchObject({ ok: false });
  });

  it("fails closed, with a different code, when the server has no app secret", () => {
    const verdict = verifySignature(bytes(body), signBody(body, SANDBOX_APP_SECRET), {});
    expect(verdict).toMatchObject({ ok: false, code: "whatsapp_not_configured" });
    expect(verifySignature(bytes(body), signBody(body, SANDBOX_APP_SECRET), { [WHATSAPP_APP_SECRET_ENV]: "   " })).toMatchObject({
      ok: false,
      code: "whatsapp_not_configured",
    });
  });

  it("accepts a body with non-ASCII text signed over its UTF-8 bytes", () => {
    const text = '{"text":"Selamat pagi, saya mau pesan kopi ☕"}';
    expect(verifySignature(bytes(text), signBody(text, SANDBOX_APP_SECRET), ENV)).toEqual({ ok: true });
  });
});

describe("verifyHandshake", () => {
  const good = { "hub.mode": "subscribe", "hub.verify_token": SANDBOX_VERIFY_TOKEN, "hub.challenge": "1158201444" };

  it("echoes the challenge when the token matches", () => {
    expect(verifyHandshake(good, ENV)).toEqual({ ok: true, challenge: "1158201444" });
  });

  it.each([
    ["a wrong token", { ...good, "hub.verify_token": "nope" }],
    ["no token", { ...good, "hub.verify_token": undefined }],
    ["another mode", { ...good, "hub.mode": "unsubscribe" }],
    ["a challenge that is not plain text", { ...good, "hub.challenge": "<script>alert(1)</script>" }],
    ["no challenge", { ...good, "hub.challenge": undefined }],
  ])("refuses %s", (_label, query) => {
    expect(verifyHandshake(query, ENV)).toMatchObject({ ok: false, status: 403 });
  });

  it("answers 503 when the server has no verify token", () => {
    expect(verifyHandshake(good, {})).toMatchObject({ ok: false, status: 503, code: "whatsapp_not_configured" });
  });
});

describe("parseWebhook", () => {
  const sandbox = createMetaSandbox();
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  const parse = (body: string) => parseWebhook(JSON.parse(body), now);

  it("reads a text message with the customer's name and the time Meta gave", () => {
    const at = now - 60_000;
    const { events } = parse(sandbox.inboundBody({ from: "6281200000007", name: "  Dewi   Lestari ", text: "Ada kopi?", id: "wamid.AAA1", at }));
    expect(events).toEqual([
      {
        type: "message",
        phoneNumberId: SANDBOX_PHONE_NUMBER_ID,
        contactId: "6281200000007",
        contactName: "Dewi Lestari",
        messageId: "wamid.AAA1",
        at: Math.floor(at / 1000) * 1000,
        kind: "text",
        text: "Ada kopi?",
      },
    ]);
  });

  it("turns anything that is not text into a fixed label and never copies the sender's content", () => {
    for (const [type, label] of [
      ["image", "[image]"],
      ["audio", "[voice note]"],
      ["document", "[document]"],
      ["sticker", "[sticker]"],
    ] as const) {
      const [event] = parse(sandbox.inboundBody({ type })).events;
      expect(event).toMatchObject({ kind: "unsupported", text: label });
      expect(JSON.stringify(event)).not.toContain("caption");
    }
    expect(parse(sandbox.inboundBody({ type: "some_future_type" })).events[0]).toMatchObject({
      kind: "unsupported",
      text: "[unsupported message]",
    });
  });

  it("skips a reaction, which is not a customer writing to us", () => {
    const result = parse(sandbox.inboundBody({ type: "reaction" }));
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips an empty text body and a message with no usable id or sender", () => {
    expect(parse(sandbox.inboundBody({ text: "   " })).events).toEqual([]);
    expect(parse(sandbox.inboundBody({ from: "not-a-number" })).events).toEqual([]);
    expect(parse(sandbox.inboundBody({ id: "x" })).events).toEqual([]);
    expect(parse(sandbox.inboundBody({ id: "wamid.has spaces" })).events).toEqual([]);
  });

  it("caps a very long message at the text limit", () => {
    const [event] = parse(sandbox.inboundBody({ text: "x".repeat(INBOX_CAPS.maxTextChars + 500) })).events;
    expect(event).toMatchObject({ kind: "text" });
    expect((event as { text: string }).text).toHaveLength(INBOX_CAPS.maxTextChars);
  });

  it("falls back to now for a missing time and ignores a clock a day ahead", () => {
    const body = JSON.parse(sandbox.inboundBody({ id: "wamid.T1" })) as Record<string, any>;
    const message = body.entry[0].changes[0].value.messages[0];
    delete message.timestamp;
    expect(parseWebhook(body, now).events[0]).toMatchObject({ at: now });
    message.timestamp = String(Math.floor(now / 1000) + 3 * 24 * 3600);
    expect(parseWebhook(body, now).events[0]).toMatchObject({ at: now });
  });

  it("reads delivery reports, and carries Meta's error title for a failure", () => {
    const sent = parse(sandbox.statusBody({ messageId: "wamid.OUT1", status: "read" })).events[0];
    expect(sent).toMatchObject({ type: "status", messageId: "wamid.OUT1", status: "read", error: null });
    const failed = parse(sandbox.statusBody({ messageId: "wamid.OUT2", status: "failed", errorTitle: "Undeliverable" })).events[0];
    expect(failed).toMatchObject({ status: "failed", error: "Undeliverable" });
  });

  it("skips a status word it does not know", () => {
    const body = JSON.parse(sandbox.statusBody({ messageId: "wamid.OUT3", status: "sent" })) as Record<string, any>;
    body.entry[0].changes[0].value.statuses[0].status = "teleported";
    expect(parseWebhook(body, now).events).toEqual([]);
  });

  it("reads nothing from a body that is not a WhatsApp delivery, and never throws", () => {
    for (const junk of [null, 7, "text", [], {}, { object: "page" }, { object: "whatsapp_business_account", entry: "x" }]) {
      expect(parseWebhook(junk, now).events).toEqual([]);
    }
    const noNumber = JSON.parse(sandbox.inboundBody()) as Record<string, any>;
    delete noNumber.entry[0].changes[0].value.metadata;
    expect(parseWebhook(noNumber, now).events).toEqual([]);
    const otherField = JSON.parse(sandbox.inboundBody()) as Record<string, any>;
    otherField.entry[0].changes[0].field = "account_update";
    expect(parseWebhook(otherField, now).events).toEqual([]);
  });

  it("reads several messages and reports from one delivery", () => {
    const body = JSON.parse(sandbox.inboundBody({ id: "wamid.M1" })) as Record<string, any>;
    const value = body.entry[0].changes[0].value;
    value.messages.push({ ...value.messages[0], id: "wamid.M2" });
    value.statuses = [{ id: "wamid.OUT9", status: "delivered", timestamp: "1" }];
    expect(parseWebhook(body, now).events.map((event) => event.type)).toEqual(["message", "message", "status"]);
  });
});

describe("WhatsAppClient", () => {
  it("reads a phone number with the token in a header and nowhere in the URL", async () => {
    const sandbox = createMetaSandbox();
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl: sandbox.fetch, origin: "http://meta.test" });
    await expect(client.getPhoneNumber(SANDBOX_PHONE_NUMBER_ID)).resolves.toEqual({
      displayPhone: "+62 812-0000-0001",
      verifiedName: "Sandbox Coffee",
    });
    const [call] = sandbox.calls;
    expect(call.url).toBe(`http://meta.test/v23.0/${SANDBOX_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`);
    expect(call.url).not.toContain(SANDBOX_ACCESS_TOKEN);
    expect(call.authorization).toBe(`Bearer ${SANDBOX_ACCESS_TOKEN}`);
  });

  it("sends a text in the shape Meta expects", async () => {
    const sandbox = createMetaSandbox();
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl: sandbox.fetch, origin: "http://meta.test" });
    const sent = await client.sendText(SANDBOX_PHONE_NUMBER_ID, "6281200000001", "Halo, kami buka jam 9.");
    expect(sent.messageId).toMatch(/^wamid\./);
    expect(sandbox.calls[0]).toMatchObject({
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "6281200000001",
        type: "text",
        text: { preview_url: false, body: "Halo, kami buka jam 9." },
      },
    });
    expect(sandbox.sent).toHaveLength(1);
  });

  it("refuses a token that cannot read the number, so a desk cannot claim a number it does not hold", async () => {
    const sandbox = createMetaSandbox();
    const stranger = new WhatsAppClient("EAAanotherdesktokenthatisnotvalid000000", { fetchImpl: sandbox.fetch, origin: "http://meta.test" });
    await expect(stranger.getPhoneNumber(SANDBOX_PHONE_NUMBER_ID)).rejects.toMatchObject({ code: "channel_forbidden" });
  });

  it("maps Meta's re-engagement refusal to the window-closed code", async () => {
    const sandbox = createMetaSandbox();
    sandbox.failNextSend({ status: 400, code: 131047, message: "Re-engagement message" });
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl: sandbox.fetch, origin: "http://meta.test" });
    await expect(client.sendText(SANDBOX_PHONE_NUMBER_ID, "6281200000001", "hi")).rejects.toMatchObject({
      code: WHATSAPP_WINDOW_CLOSED_CODE,
      status: 409,
    });
  });

  it("does not follow a redirect", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/steal" } });
    };
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl, origin: "http://meta.test" });
    await expect(client.getPhoneNumber(SANDBOX_PHONE_NUMBER_ID)).rejects.toMatchObject({ code: "channel_error" });
    expect(calls).toHaveLength(1);
  });

  it("times out instead of waiting forever", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl, origin: "http://meta.test", timeoutMs: 20 });
    await expect(client.getPhoneNumber(SANDBOX_PHONE_NUMBER_ID)).rejects.toMatchObject({ code: "channel_error", status: 504 });
  });

  it("never lets the token into an error message", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`socket hang up while sending Authorization: Bearer ${SANDBOX_ACCESS_TOKEN}`);
    };
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl, origin: "http://meta.test" });
    const error = await client.getPhoneNumber(SANDBOX_PHONE_NUMBER_ID).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(SANDBOX_ACCESS_TOKEN);
    expect(redactToken(`token ${SANDBOX_ACCESS_TOKEN} leaked`)).not.toContain(SANDBOX_ACCESS_TOKEN);
  });

  it("checks the values before a socket is opened", async () => {
    const sandbox = createMetaSandbox();
    const client = new WhatsAppClient(SANDBOX_ACCESS_TOKEN, { fetchImpl: sandbox.fetch, origin: "http://meta.test" });
    await expect(client.getPhoneNumber("../../me")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.sendText(SANDBOX_PHONE_NUMBER_ID, "not-a-number", "hi")).rejects.toMatchObject({ code: "invalid_request" });
    expect(() => new WhatsAppClient("short")).toThrow();
    expect(sandbox.calls).toHaveLength(0);
  });
});
