/**
 * The customer inbox, driven through `dispatch` in server mode on a real database, against the
 * in-memory Meta sandbox: connect a number → a signed message arrives → the owner reads it, replies
 * and sees the delivery report → another company never sees any of it.
 *
 * Through `dispatch` rather than by calling the handlers, because most of what has to be true is not
 * in a handler: the webhook is exempt from the session gate and the other routes are not, the desk a
 * webhook writes to comes from the number and never from the payload, and a signature is checked
 * before anything is read. Nothing here talks to Meta: `globalThis.fetch` is the sandbox's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-customers-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "5b1e9d3c7a2f4086b1d9e5c3a7f20468d1b9e5c3a7f2046851d9e3c7a5b20f4c";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import { WHATSAPP_WEBHOOK_PATH } from "@agentforge/core/inbox";
import { dispatch } from "../router";
import { createSession } from "../auth/session";
import { createMemorySessionStore, type SessionStore } from "../auth/session-store";
import { isSessionExemptPath } from "../auth/routes";
import {
  SANDBOX_ACCESS_TOKEN,
  SANDBOX_APP_SECRET,
  SANDBOX_PHONE_NUMBER_ID,
  SANDBOX_VERIFY_TOKEN,
  createMetaSandbox,
  type MetaSandbox,
} from "../inbox/__fixtures__/meta-api";
import { WHATSAPP_APP_SECRET_ENV, WHATSAPP_SIGNATURE_HEADER, WHATSAPP_VERIFY_TOKEN_ENV } from "../inbox/webhook-path";
import type { HostJsonResult, HostRequest, HostResult } from "../types";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const COMPANY_A = { tenantId: "cust-tenant-a", orgId: "cust-org-a", userId: "cust-owner-a" };
const COMPANY_B = { tenantId: "cust-tenant-b", orgId: "cust-org-b", userId: "cust-owner-b" };
const MEMBER_OF_A = { ...COMPANY_A, userId: "cust-member-a" };
const OTHER_NUMBER_ID = "105550000000002";
const HOUR = 3_600_000;

let sessions: SessionStore;
let sandbox: MetaSandbox;
const cookies: Record<"a" | "b" | "member", string> = { a: "", b: "", member: "" };
const realFetch = globalThis.fetch;

type Who = "a" | "b" | "member" | "nobody";

function json(result: HostResult): HostJsonResult {
  if (result.type !== "json") {
    throw new Error(`expected a json result, got ${result.type}`);
  }
  return result;
}

function bodyOf(result: HostResult): Record<string, any> {
  return json(result).body as Record<string, any>;
}

function errorCode(result: HostResult): string {
  return (bodyOf(result).error as { code: string }).code;
}

async function call(
  who: Who,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<HostResult> {
  const request: HostRequest = {
    method,
    path,
    query: options.query ?? {},
    params: {},
    headers: who === "nobody" ? {} : { cookie: cookies[who] },
    body: options.body,
  };
  return dispatch(request, { serverMode: true, sessionStore: sessions, now: () => T0 });
}

/**
 * What Meta's servers send: no cookie, the raw bytes, and a signature header. Pass `null` to send no
 * signature header at all (an omitted argument signs the body, like Meta does).
 */
async function deliver(
  raw: string,
  signature: string | null = sandbox.signature(raw),
): Promise<HostResult> {
  return dispatch(
    {
      method: "POST",
      path: WHATSAPP_WEBHOOK_PATH,
      query: {},
      params: {},
      headers: signature === null ? {} : { [WHATSAPP_SIGNATURE_HEADER]: signature },
      rawBody: new TextEncoder().encode(raw),
    },
    { serverMode: true, sessionStore: sessions, now: () => T0 },
  );
}

async function connect(who: Who = "a", numberId = SANDBOX_PHONE_NUMBER_ID, token = SANDBOX_ACCESS_TOKEN) {
  return call(who, "POST", "/api/v1/customers/whatsapp", { body: { phoneNumberId: numberId, accessToken: token } });
}

async function conversationsOf(who: Who): Promise<Array<Record<string, any>>> {
  return bodyOf(await call(who, "GET", "/api/v1/customers/conversations")).conversations;
}

function rowCount(table: string): number {
  return 0 + Number((globalThis as any).__sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
}

beforeAll(async () => {
  const { db, ensurePortalOwner, sql } = await import("@agentforge/db");
  (globalThis as any).__sql = sql;
  await ensurePortalOwner(db, { ...COMPANY_A, role: "owner" });
  await ensurePortalOwner(db, { ...COMPANY_B, role: "owner" });
  await ensurePortalOwner(db, { ...MEMBER_OF_A, role: "member" });
  sessions = createMemorySessionStore();
  for (const [key, identity] of [
    ["a", COMPANY_A],
    ["b", COMPANY_B],
    ["member", MEMBER_OF_A],
  ] as const) {
    const session = createSession({ ...identity, now: T0 });
    await sessions.create(session);
    cookies[key] = `__Host-agentforge_session=${session.id}`;
  }
});

beforeEach(async () => {
  process.env.AGENTFORGE_SERVER = "1";
  process.env[WHATSAPP_APP_SECRET_ENV] = SANDBOX_APP_SECRET;
  process.env[WHATSAPP_VERIFY_TOKEN_ENV] = SANDBOX_VERIFY_TOKEN;
  sandbox = createMetaSandbox({
    numbers: [
      { id: SANDBOX_PHONE_NUMBER_ID, displayPhone: "+62 812-0000-0001", verifiedName: "Company A Coffee" },
      { id: OTHER_NUMBER_ID, displayPhone: "+62 812-0000-0002", verifiedName: "Company B Books" },
    ],
  });
  globalThis.fetch = sandbox.fetch;
  // Each case starts with no numbers and no saved tokens.
  await call("a", "DELETE", "/api/v1/customers/whatsapp");
  await call("b", "DELETE", "/api/v1/customers/whatsapp");
  (globalThis as any).__sql.prepare("DELETE FROM channel_endpoints").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AGENTFORGE_SERVER;
  delete process.env[WHATSAPP_APP_SECRET_ENV];
  delete process.env[WHATSAPP_VERIFY_TOKEN_ENV];
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("what the session gate lets through", () => {
  it("exempts the webhook's two methods on one literal path, and nothing else near it", () => {
    expect(isSessionExemptPath("GET", WHATSAPP_WEBHOOK_PATH)).toBe(true);
    expect(isSessionExemptPath("POST", WHATSAPP_WEBHOOK_PATH)).toBe(true);
    expect(isSessionExemptPath("DELETE", WHATSAPP_WEBHOOK_PATH)).toBe(false);
    expect(isSessionExemptPath("POST", `${WHATSAPP_WEBHOOK_PATH}/extra`)).toBe(false);
    expect(isSessionExemptPath("POST", "/api/v1/channels/whatsapp")).toBe(false);
    for (const path of [
      "/api/v1/customers/whatsapp",
      "/api/v1/customers/summary",
      "/api/v1/customers/conversations",
      "/api/v1/customers/conversations/x/reply",
    ]) {
      expect(isSessionExemptPath("GET", path)).toBe(false);
      expect(isSessionExemptPath("POST", path)).toBe(false);
    }
  });

  it("refuses every owner route without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/customers/whatsapp"],
      ["POST", "/api/v1/customers/whatsapp"],
      ["DELETE", "/api/v1/customers/whatsapp"],
      ["GET", "/api/v1/customers/summary"],
      ["GET", "/api/v1/customers/conversations"],
      ["GET", "/api/v1/customers/conversations/x"],
      ["POST", "/api/v1/customers/conversations/x/reply"],
    ] as const) {
      expect(json(await call("nobody", method, path)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("the webhook handshake", () => {
  const handshake = async (token: string, challenge = "1158201444") =>
    dispatch(
      {
        method: "GET",
        path: WHATSAPP_WEBHOOK_PATH,
        query: { "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": challenge },
        params: {},
        headers: {},
      },
      { serverMode: true, sessionStore: sessions, now: () => T0 },
    );

  it("echoes the challenge as plain text to Meta, who has no session", async () => {
    const result = await handshake(SANDBOX_VERIFY_TOKEN);
    expect(result).toMatchObject({ type: "bytes", status: 200, contentType: "text/plain; charset=utf-8" });
    expect(new TextDecoder().decode((result as { bytes: Uint8Array }).bytes)).toBe("1158201444");
  });

  it("refuses a wrong verify token, and answers 503 when the server has none", async () => {
    expect(json(await handshake("guess")).status).toBe(403);
    delete process.env[WHATSAPP_VERIFY_TOKEN_ENV];
    expect(json(await handshake(SANDBOX_VERIFY_TOKEN)).status).toBe(503);
  });
});

describe("who may deliver to the webhook", () => {
  const raw = () => sandbox.inboundBody({ text: "Ada kopi?" });

  it("refuses an unsigned delivery and a wrongly signed one, and stores nothing", async () => {
    await connect();
    expect(json(await deliver(raw(), null)).status).toBe(401);
    expect(json(await deliver(raw(), `sha256=${"0".repeat(64)}`)).status).toBe(401);
    const tampered = raw();
    expect(json(await deliver(tampered.replace("Ada kopi?", "Ada kopi!"), sandbox.signature(tampered))).status).toBe(401);
    expect(await conversationsOf("a")).toEqual([]);
  });

  it("checks the signature before it reads the body: unsigned garbage is a 401, not a 400", async () => {
    expect(json(await deliver("this is not json", null)).status).toBe(401);
    expect(json(await deliver("this is not json")).status).toBe(400);
  });

  it("refuses everything, loudly, when the server has no app secret", async () => {
    await connect();
    delete process.env[WHATSAPP_APP_SECRET_ENV];
    const result = await deliver(raw());
    expect(json(result).status).toBe(503);
    expect(errorCode(result)).toBe("whatsapp_not_configured");
    expect(await conversationsOf("a")).toEqual([]);
  });

  it("accepts a signed delivery for a number nobody has connected with a 200, and writes nothing", async () => {
    const result = await deliver(raw());
    expect(json(result).status).toBe(200);
    expect(bodyOf(result)).toMatchObject({ messages: 0, unknownNumber: 1 });
    expect(rowCount("customer_messages")).toBe(0);
  });
});

describe("connecting a number", () => {
  it("proves the token reaches the number, saves it, and never gives it back", async () => {
    const result = await connect();
    expect(json(result).status).toBe(200);
    expect(bodyOf(result)).toMatchObject({
      connected: true,
      webhookReady: true,
      phoneNumberId: SANDBOX_PHONE_NUMBER_ID,
      displayPhone: "+62 812-0000-0001",
      verifiedName: "Company A Coffee",
      pinnedOrigin: true,
    });
    expect(bodyOf(result).fingerprint).toMatch(/^sha256:/);
    const everything = JSON.stringify([
      bodyOf(result),
      bodyOf(await call("a", "GET", "/api/v1/customers/whatsapp")),
      bodyOf(await call("a", "GET", "/api/v1/settings")),
    ]);
    expect(everything).not.toContain(SANDBOX_ACCESS_TOKEN);
    expect(sandbox.calls[0].authorization).toBe(`Bearer ${SANDBOX_ACCESS_TOKEN}`);
  });

  it("writes nothing when the token is wrong or does not reach that number", async () => {
    const result = await connect("a", SANDBOX_PHONE_NUMBER_ID, "EAAnotthetokenmetaknowsabout000000000");
    expect(json(result).status).toBe(400);
    expect(errorCode(result)).toBe("channel_forbidden");
    expect(bodyOf(await call("a", "GET", "/api/v1/customers/whatsapp"))).toMatchObject({ connected: false });
    expect(rowCount("channel_endpoints")).toBe(0);
    expect(json(await connect("a", "not a number id")).status).toBe(400);
  });

  it("gives a number to one company: another cannot take it over, even holding a valid token", async () => {
    expect(json(await connect("a")).status).toBe(200);
    const result = await connect("b");
    expect(json(result).status).toBe(409);
    expect(errorCode(result)).toBe("channel_conflict");
    expect(bodyOf(await call("b", "GET", "/api/v1/customers/whatsapp"))).toMatchObject({ connected: false });
    // And the original owner's number still receives.
    const delivery = await deliver(sandbox.inboundBody({ from: "6281200000001" }));
    expect(bodyOf(delivery)).toMatchObject({ messages: 1 });
    expect(await conversationsOf("a")).toHaveLength(1);
    expect(await conversationsOf("b")).toEqual([]);
  });

  it("is the owner's to change: a member of the desk can read but not connect or disconnect", async () => {
    expect(json(await connect("member")).status).toBe(403);
    await connect("a");
    expect(json(await call("member", "DELETE", "/api/v1/customers/whatsapp")).status).toBe(403);
    expect(bodyOf(await call("member", "GET", "/api/v1/customers/whatsapp"))).toMatchObject({ connected: true });
    expect(bodyOf(await call("a", "GET", "/api/v1/customers/whatsapp"))).toMatchObject({ connected: true });
  });

  it("stops receiving on disconnect but keeps the conversations", async () => {
    await connect();
    await deliver(sandbox.inboundBody({}));
    const result = await call("a", "DELETE", "/api/v1/customers/whatsapp");
    expect(bodyOf(result)).toMatchObject({ connected: false, fingerprint: null });
    const after = await deliver(sandbox.inboundBody({ from: "6281200000009" }));
    expect(bodyOf(after)).toMatchObject({ messages: 0, unknownNumber: 1 });
    expect(await conversationsOf("a")).toHaveLength(1);
  });
});

describe("a customer writes and the owner answers", () => {
  async function receive(text = "Ada kopi?", extra: Parameters<MetaSandbox["inboundBody"]>[0] = {}) {
    const result = await deliver(sandbox.inboundBody({ text, ...extra }));
    expect(json(result).status).toBe(200);
    const [conversation] = await conversationsOf("a");
    return conversation as Record<string, any>;
  }

  it("shows the message to the owner, unread, with the reply window open", async () => {
    await connect();
    const conversation = await receive("Ada kopi?", { name: "Dewi" });
    expect(conversation).toMatchObject({
      contactName: "Dewi",
      contactId: "6281200000001",
      state: "needs_you",
      unreadCount: 1,
      lastMessagePreview: "Ada kopi?",
    });
    expect(conversation.window.open).toBe(true);
    const summary = bodyOf(await call("a", "GET", "/api/v1/customers/summary", { query: { since: String(Date.now() - HOUR) } }));
    expect(summary).toMatchObject({ needsYou: 1, unread: 1, receivedToday: 1, sentToday: 0 });
  });

  it("stores a redelivered message once", async () => {
    await connect();
    const raw = sandbox.inboundBody({ id: "wamid.SAMEONE" });
    expect(bodyOf(await deliver(raw))).toMatchObject({ messages: 1, duplicates: 0 });
    expect(bodyOf(await deliver(raw))).toMatchObject({ messages: 0, duplicates: 1 });
    const [conversation] = await conversationsOf("a");
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages).toHaveLength(1);
    expect(conversation.unreadCount).toBe(1);
  });

  it("shows an image as a fixed label, never the sender's own caption", async () => {
    await connect();
    const conversation = await receive("", { type: "image" });
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages[0]).toMatchObject({ kind: "unsupported", text: "[image]" });
    expect(JSON.stringify(thread)).not.toContain("caption");
  });

  it("clears the unread count when the owner opens it", async () => {
    await connect();
    const conversation = await receive();
    expect(json(await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/read`)).status).toBe(200);
    expect((await conversationsOf("a"))[0].unreadCount).toBe(0);
  });

  it("sends the reply through Meta, files it, and follows the delivery reports", async () => {
    await connect();
    const conversation = await receive("Ada kopi?");
    const reply = await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/reply`, {
      body: { text: "  Ada, buka jam 9.  " },
    });
    expect(json(reply).status).toBe(200);
    const message = bodyOf(reply).message;
    expect(message).toMatchObject({ direction: "out", sentBy: "owner", delivery: "sent", text: "Ada, buka jam 9." });
    expect(sandbox.sent).toEqual([
      expect.objectContaining({ phoneNumberId: SANDBOX_PHONE_NUMBER_ID, to: "6281200000001", text: "Ada, buka jam 9." }),
    ]);
    expect((await conversationsOf("a"))[0]).toMatchObject({ state: "with_you", unreadCount: 0, lastMessageDirection: "out" });

    const metaId = sandbox.sent[0].id;
    const delivered = await deliver(sandbox.statusBody({ messageId: metaId, status: "delivered" }));
    expect(bodyOf(delivered)).toMatchObject({ statuses: 1 });
    await deliver(sandbox.statusBody({ messageId: metaId, status: "read" }));
    await deliver(sandbox.statusBody({ messageId: metaId, status: "sent" }));
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages.at(-1)).toMatchObject({ delivery: "read" });
  });

  it("does not send outside the 24-hour window, and says why", async () => {
    await connect();
    const conversation = await receive("old question", { at: Date.now() - 25 * HOUR });
    expect(conversation.window.open).toBe(false);
    const reply = await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/reply`, {
      body: { text: "sorry for the wait" },
    });
    expect(json(reply).status).toBe(409);
    expect(errorCode(reply)).toBe("window_closed");
    expect(sandbox.sent).toEqual([]);
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages).toHaveLength(1);
  });

  it("shows a send Meta refused as failed, and leaves the conversation waiting", async () => {
    await connect();
    const conversation = await receive();
    sandbox.failNextSend({ status: 400, code: 131047, message: "Re-engagement message" });
    const reply = await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/reply`, {
      body: { text: "hello" },
    });
    expect(json(reply).status).toBe(409);
    expect(errorCode(reply)).toBe("window_closed");
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages.at(-1)).toMatchObject({ direction: "out", delivery: "failed" });
    expect(thread.conversation).toMatchObject({ state: "needs_you", unreadCount: 1 });
  });

  it("refuses an empty or oversized reply before anything is stored", async () => {
    await connect();
    const conversation = await receive();
    for (const text of ["", "   ", "x".repeat(4097), undefined]) {
      const reply = await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/reply`, { body: { text } });
      expect(json(reply).status).toBe(400);
    }
    const thread = bodyOf(await call("a", "GET", `/api/v1/customers/conversations/${conversation.id}`));
    expect(thread.messages).toHaveLength(1);
  });

  it("will not reply once the number is disconnected", async () => {
    await connect();
    const conversation = await receive();
    await call("a", "DELETE", "/api/v1/customers/whatsapp");
    const reply = await call("a", "POST", `/api/v1/customers/conversations/${conversation.id}/reply`, {
      body: { text: "hello" },
    });
    expect(json(reply).status).toBe(409);
    expect(errorCode(reply)).toBe("channel_not_connected");
    expect(sandbox.sent).toEqual([]);
  });

  it("lets the owner mark a conversation done, and reopens it when the customer writes again", async () => {
    await connect();
    const conversation = await receive();
    const path = `/api/v1/customers/conversations/${conversation.id}/state`;
    expect(json(await call("a", "POST", path, { body: { state: "closed" } })).status).toBe(200);
    expect((await conversationsOf("a"))[0].state).toBe("closed");
    expect(json(await call("a", "POST", path, { body: { state: "auto" } })).status).toBe(400);
    await receive("masih ada?", {});
    expect((await conversationsOf("a"))[0].state).toBe("needs_you");
  });

  it("filters the list by state and by search", async () => {
    await connect();
    await receive("Ada kopi?", { from: "6281200000001", name: "Dewi" });
    await receive("Ada teh?", { from: "6281200000002", name: "Budi" });
    const budi = (await conversationsOf("a")).find((row) => row.contactName === "Budi") as Record<string, any>;
    await call("a", "POST", `/api/v1/customers/conversations/${budi.id}/state`, { body: { state: "closed" } });
    const list = async (query: Record<string, string>) =>
      bodyOf(await call("a", "GET", "/api/v1/customers/conversations", { query })).conversations.map((row: any) => row.contactName);
    expect(await list({ state: "closed" })).toEqual(["Budi"]);
    expect(await list({ state: "needs_you" })).toEqual(["Dewi"]);
    expect(await list({ q: "dew" })).toEqual(["Dewi"]);
    expect(await list({ q: "0002" })).toEqual(["Budi"]);
  });
});

describe("two companies on one server", () => {
  it("routes each company's customers to that company alone", async () => {
    await connect("a", SANDBOX_PHONE_NUMBER_ID);
    await connect("b", OTHER_NUMBER_ID);
    await deliver(sandbox.inboundBody({ phoneNumberId: SANDBOX_PHONE_NUMBER_ID, from: "6281200000001", text: "for A" }));
    await deliver(sandbox.inboundBody({ phoneNumberId: OTHER_NUMBER_ID, from: "6281200000005", text: "for B" }));

    const forA = await conversationsOf("a");
    const forB = await conversationsOf("b");
    expect(forA.map((row) => row.lastMessagePreview)).toEqual(["for A"]);
    expect(forB.map((row) => row.lastMessagePreview)).toEqual(["for B"]);
  });

  it("answers another company's conversation id as not found, on every route", async () => {
    await connect("a");
    await deliver(sandbox.inboundBody({ text: "private to A" }));
    const [conversation] = await conversationsOf("a");
    const base = `/api/v1/customers/conversations/${conversation.id}`;

    expect(json(await call("b", "GET", base)).status).toBe(404);
    expect(json(await call("b", "POST", `${base}/read`)).status).toBe(404);
    expect(json(await call("b", "POST", `${base}/state`, { body: { state: "closed" } })).status).toBe(404);
    expect(json(await call("b", "POST", `${base}/reply`, { body: { text: "hi" } })).status).toBe(404);
    // A made-up id reads exactly the same, so existence is not confirmed across companies.
    expect(json(await call("b", "GET", "/api/v1/customers/conversations/does-not-exist")).status).toBe(404);
    expect(sandbox.sent).toEqual([]);
    // And A's conversation is untouched.
    expect((await conversationsOf("a"))[0]).toMatchObject({ state: "needs_you", unreadCount: 1 });
  });

  it("never lets a payload name the desk it writes to", async () => {
    await connect("a");
    const forged = JSON.parse(sandbox.inboundBody({ text: "forged" })) as Record<string, any>;
    const value = forged.entry[0].changes[0].value;
    // Fields no part of the parser reads must change nothing about where the message lands.
    value.workspace_id = "someone-elses-desk";
    value.metadata.workspaceId = "someone-elses-desk";
    value.metadata.tenant_id = COMPANY_B.tenantId;
    forged.workspaceId = "someone-elses-desk";
    await deliver(JSON.stringify(forged));
    expect(await conversationsOf("a")).toHaveLength(1);
    expect(await conversationsOf("b")).toEqual([]);
  });
});
