import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomersError,
  WINDOW_CLOSED_CODE,
  connectWhatsApp,
  disconnectWhatsApp,
  loadConversation,
  loadConversations,
  loadSummary,
  markConversationRead,
  replyToConversation,
  setConversationState,
} from "./customers-client";

type Call = { input: string; init: RequestInit };

function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

function lastCall(calls: Call[]): Call {
  const call = calls.at(-1);
  if (!call) {
    throw new Error("no fetch call was made");
  }
  return call;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customers client", () => {
  it("posts the token as JSON and never puts it in the URL", async () => {
    const calls = stubFetch(200, { connected: true });
    await connectWhatsApp("105550000000001", "EAAsecrettokenvalue0123456789");
    const call = lastCall(calls);
    expect(call.input).toBe("/api/v1/customers/whatsapp");
    expect(call.input).not.toContain("EAAsecret");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      phoneNumberId: "105550000000001",
      accessToken: "EAAsecrettokenvalue0123456789",
    });
  });

  it("disconnects with DELETE", async () => {
    const calls = stubFetch(200, { connected: false });
    await disconnectWhatsApp();
    expect(lastCall(calls).init.method).toBe("DELETE");
  });

  it("sends the owner's local day start to the summary", async () => {
    const calls = stubFetch(200, { needsYou: 0 });
    await loadSummary(1788820000000);
    expect(lastCall(calls).input).toBe("/api/v1/customers/summary?since=1788820000000");
  });

  it("asks for a state and a search only when there is one", async () => {
    const calls = stubFetch(200, { conversations: [] });
    await loadConversations("all", "  ");
    expect(lastCall(calls).input).toBe("/api/v1/customers/conversations");
    await loadConversations("needs_you", " Dewi ");
    expect(lastCall(calls).input).toBe("/api/v1/customers/conversations?state=needs_you&q=Dewi");
  });

  it("treats a missing conversations array as an empty list", async () => {
    stubFetch(200, {});
    await expect(loadConversations("all", "")).resolves.toEqual([]);
  });

  it("escapes the conversation id it puts in a path", async () => {
    const calls = stubFetch(200, { conversation: {}, messages: [] });
    await loadConversation("a/b?c");
    expect(lastCall(calls).input).toBe("/api/v1/customers/conversations/a%2Fb%3Fc");
    await markConversationRead("a/b");
    expect(lastCall(calls).input).toBe("/api/v1/customers/conversations/a%2Fb/read");
  });

  it("posts a reply and a state change to their own routes", async () => {
    const calls = stubFetch(200, { message: { id: "m1" }, ok: true });
    await expect(replyToConversation("c1", "On our way")).resolves.toMatchObject({ id: "m1" });
    const reply = lastCall(calls);
    expect(reply.input).toBe("/api/v1/customers/conversations/c1/reply");
    expect(JSON.parse(String(reply.init.body))).toEqual({ text: "On our way" });
    await setConversationState("c1", "closed");
    const state = lastCall(calls);
    expect(state.input).toBe("/api/v1/customers/conversations/c1/state");
    expect(JSON.parse(String(state.init.body))).toEqual({ state: "closed" });
  });

  it("surfaces the host's error code so the page can explain a closed window", async () => {
    stubFetch(409, { error: { code: WINDOW_CLOSED_CODE, message: "WhatsApp only allows a free-form reply for 24 hours" } });
    const failure = await replyToConversation("c1", "hello").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CustomersError);
    expect((failure as CustomersError).code).toBe(WINDOW_CLOSED_CODE);
  });

  it("falls back to its own wording when the host sends no body", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 502 }));
    await expect(loadSummary(0)).rejects.toThrow(/today's numbers/);
  });
});
