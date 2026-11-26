/**
 * The email webhook's contract (F5b): signature before parsing, the desk from the `to` address,
 * idempotent redelivery, the allowlist gate, the loop guards. Everything runs on a fake store,
 * so a path that reached the real database or a real mail server would fail loudly.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleEmailWebhook, verifyEmailSignature } from "./inbound";
import { EMAIL_SIGNATURE_HEADER, EMAIL_WEBHOOK_SECRET_ENV } from "./path";
import type { EmailSql, EmailStore } from "./store";
import type { HostRequest } from "../../types";

const SECRET = "test-webhook-secret";
const ENV = {
  [EMAIL_WEBHOOK_SECRET_ENV]: SECRET,
  AGENTFORGE_SERVER: "1",
} as NodeJS.ProcessEnv;

const sign = (raw: Uint8Array) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const bytes = (text: string) => new TextEncoder().encode(text);

function request(payload: unknown, secret = SECRET): HostRequest {
  const raw = bytes(JSON.stringify(payload));
  return {
    method: "POST",
    path: "/api/v1/channels/email/webhook",
    query: {},
    params: {},
    headers: { [EMAIL_SIGNATURE_HEADER]: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
    rawBody: raw,
  } as HostRequest;
}

function fakeStore(overrides: Partial<EmailStore> = {}): EmailStore & { seen: Set<string> } {
  const seen = new Set<string>();
  const store = {
    seen,
    findChannelByAddress: () => ({
      id: "c1",
      workspaceId: "w1",
      agentId: "a1",
      address: "agent@mail.example.com",
      unknownSenderPolicy: "ignore" as const,
      status: "active" as const,
      createdAt: 1,
    }),
    markInboundSeen: (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    unmarkInboundSeen: (id: string) => {
      seen.delete(id);
    },
    listAllowlist: () => [{ id: "s1", channelId: "c1", pattern: "@x.com", userId: null }],
    listChannels: () => [],
    getChannel: () => null,
    createChannel: () => {
      throw new Error("unused");
    },
    removeChannel: () => true,
    addAllowlistEntry: () => {
      throw new Error("unused");
    },
    removeAllowlistEntry: () => true,
    findThread: () => null,
    createThread: (channelId: string, threadId: string, rootMessageId: string, senderKey: string) => ({
      id: "et1",
      channelId,
      threadId,
      rootMessageId,
      senderKey,
    }),
    removeThread: () => undefined,
    dropWorkspace: () => undefined,
    ...overrides,
  } as EmailStore & { seen: Set<string> };
  return store;
}

const delivery = (over: Record<string, unknown> = {}) => ({
  provider_message_id: "pm-1",
  to: "agent@mail.example.com",
  headers: { from: "Someone <someone@x.com>", "message-id": "<m1@x.com>" },
  subject: "Hi",
  text: "Hello agent",
  ...over,
});

describe("verifyEmailSignature", () => {
  it("checks the signature before anything parses, and refuses a bad one", () => {
    const raw = bytes('{"to":"a@b.c"}');
    expect(verifyEmailSignature(raw, sign(raw), ENV)).toEqual({ ok: true });
    expect(verifyEmailSignature(raw, "sha256=00".repeat(1), ENV)).toMatchObject({ ok: false, status: 401 });
    expect(verifyEmailSignature(raw, undefined, ENV)).toMatchObject({ ok: false, status: 401 });
    expect(verifyEmailSignature(raw, sign(raw), { AGENTFORGE_SERVER: "1" } as NodeJS.ProcessEnv)).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});

describe("handleEmailWebhook", () => {
  beforeEach(() => {
    process.env.AGENTFORGE_SERVER = "1";
  });

  it("refuses a bad signature before the body is parsed", async () => {
    const raw = bytes("not even json {{{");
    const req = {
      method: "POST",
      path: "/api/v1/channels/email/webhook",
      query: {},
      params: {},
      headers: { [EMAIL_SIGNATURE_HEADER]: "sha256=bad" },
      rawBody: raw,
    } as HostRequest;
    const result = await handleEmailWebhook(req, { store: fakeStore(), env: ENV });
    expect(result.type).toBe("json");
    expect((result as { status: number }).status).toBe(401);
  });

  it("drops mail for an address no channel holds, and counts it", async () => {
    const result = await handleEmailWebhook(request(delivery({ to: "nobody@mail.example.com" })), {
      store: fakeStore(),
      env: ENV,
    });
    expect((result as { status: number }).status).toBe(200);
  });

  it("never answers an auto-reply (Auto-Submitted / Precedence)", async () => {
    const store = fakeStore();
    await handleEmailWebhook(request(delivery({ headers: { from: "a@x.com", "auto-submitted": "auto-replied" } })), {
      store,
      env: ENV,
    });
    // Skipped before the dedupe insert: an auto-reply is not even filed as seen.
    expect(store.seen.size).toBe(0);
  });

  it("refuses a redelivery by the dedupe primary key, before a run starts", async () => {
    const store = fakeStore();
    const deps = { store, env: ENV, runReply: async () => ({ kind: "answered" as const, text: "ok" }) };
    await handleEmailWebhook(request(delivery()), deps);
    await handleEmailWebhook(request(delivery()), deps);
    expect(store.seen.size).toBe(1);
  });

  it("does not process an unknown sender (policy ignore), and a refuse policy mails a refusal", async () => {
    const store = fakeStore({ listAllowlist: () => [] });
    await handleEmailWebhook(request(delivery()), {
      store,
      env: ENV,
      runReply: async () => ({ kind: "answered", text: "x" }),
    });

    const refused: string[] = [];
    const refuseStore = fakeStore({
      findChannelByAddress: () => ({
        id: "c1",
        workspaceId: "w1",
        agentId: "a1",
        address: "agent@mail.example.com",
        unknownSenderPolicy: "refuse" as const,
        status: "active" as const,
        createdAt: 1,
      }),
      listAllowlist: () => [],
    });
    const mailer = { send: async (m: { to: string }) => void refused.push(m.to) };
    await handleEmailWebhook(request(delivery({ provider_message_id: "pm-2" })), {
      store: refuseStore,
      env: ENV,
      mailer,
      sendReply: async (args) => args.mailer.send(args),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refused).toEqual(["someone@x.com"]);
  });

  it("runs the reply and mails it back in-thread for an allowlisted sender", async () => {
    const sent: Array<{ to: string; inReplyTo?: string; text: string }> = [];
    const store = fakeStore();
    const db = {
      prepare: () => ({
        get: () => ({ id: "w1", organizationId: "o1", tenantId: "t1", userId: "u1", role: "owner" }),
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    } as unknown as EmailSql;
    await handleEmailWebhook(request(delivery()), {
      store,
      env: ENV,
      db,
      mailer: { send: async (m) => void sent.push(m as { to: string; text: string }) },
      sendReply: async (args) => {
        sent.push(args);
        await args.mailer.send(args);
      },
      runReply: async () => ({ kind: "answered", text: "The answer." }),
      openThread: async () => ({ id: "thread-1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent[0]?.to).toBe("someone@x.com");
    expect(sent[0]?.inReplyTo).toBe("<m1@x.com>");
  });
});
