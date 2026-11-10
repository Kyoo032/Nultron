/**
 * The client as a browser on loopback would be, against the fake host: which headers it sends, which cookies it
 * keeps, what the socket handshake carries, and how it reads the host's refusals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { H1Refused, createVoiceClient, errorCodeOf, errorMessageOf, isFrame } from "./client";
import { realClock } from "./clock";
import { type FakeBehavior, type FakeHost, startFakeHost } from "./fake-host";

const hosts: FakeHost[] = [];

async function boot(behavior: Partial<FakeBehavior> = {}) {
  const host = await startFakeHost({ clock: realClock, behavior });
  hosts.push(host);
  return { host, client: createVoiceClient({ base: host.base, clock: realClock, locale: "id" }) };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

describe("what the client sends, as a browser on loopback does", () => {
  it("puts Origin, equal to the base URL, on every request, reads included", async () => {
    const { host, client } = await boot();
    await client.settings();
    const thread = await client.createThread();
    const info = await client.startSession(thread);
    const session = await client.connect(info);
    await session.end();
    await client.readMessages(thread);
    await client.deleteThread(thread);

    expect(host.requests.length).toBeGreaterThan(5);
    for (const request of host.requests) {
      expect(request.origin, `${request.method} ${request.path}`).toBe(host.base);
    }
  });

  it("keeps the cookies the host hands out and echoes the CSRF token on a mutating call", async () => {
    const { host, client } = await boot();
    await client.settings();
    await client.createThread();
    await client.createThread();

    const posts = host.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts.every((request) => request.csrfOk)).toBe(true);
    // The first GET set the cookies, so every later request carried the session cookie.
    expect(host.requests[0]?.hadCookie).toBe(false);
    expect(host.requests.slice(1).every((request) => request.hadCookie)).toBe(true);
  });

  it("primes the CSRF cookie with one cheap GET when its first call is a mutation", async () => {
    const { host, client } = await boot();
    await client.http.post("/api/v1/threads", { agentId: "agent-1" });
    const calls = host.requests.map((request) => `${request.method} ${request.path}`);
    expect(calls.slice(0, 2)).toEqual(["GET /api/v1/ping", "POST /api/v1/threads"]);
    expect(host.requests.find((request) => request.method === "POST")?.csrfOk).toBe(true);
  });

  it("opens the socket with the same Origin and the session cookie", async () => {
    const { host, client } = await boot();
    await client.settings();
    const info = await client.startSession(await client.createThread());
    const session = await client.connect(info);
    expect(host.upgrades).toEqual([{ origin: host.base, accepted: true }]);
    expect(session.find(isFrame("ready"))).toBeDefined();
    await session.end();
  });

  it("tries the handshake with no Origin and with a foreign one, and is refused both times", async () => {
    const { client } = await boot();
    await client.settings();
    const info = await client.startSession(await client.createThread());
    const without = await client.probeUpgrade(info, null);
    const foreign = await client.probeUpgrade(info, "https://evil.example");
    expect(without).toMatchObject({ outcome: "refused", status: 403 });
    expect(foreign).toMatchObject({ outcome: "refused", status: 403 });
    await client.endSession(info.sessionId);
  });

  it("sees an upgrade that is accepted without an Origin", async () => {
    const { client } = await boot({ acceptsWithoutOrigin: true });
    await client.settings();
    const info = await client.startSession(await client.createThread());
    const without = await client.probeUpgrade(info, null);
    expect(without.outcome).toBe("accepted");
    await client.endSession(info.sessionId);
  });

  it("fails to connect to a session that does not exist, with the status", async () => {
    const { client } = await boot();
    await client.settings();
    await expect(
      client.connect({ sessionId: "vs_missing0000", threadId: "t", model: "m", streamPath: "/api/v1/voice/sessions/vs_missing0000/stream", endsAt: 0 }),
    ).rejects.toThrow(/refused: HTTP 404/);
  });
});

describe("how it reads H1", () => {
  it("returns the session on 201", async () => {
    const { client } = await boot();
    await client.settings();
    const info = await client.startSession(await client.createThread(), "push_to_talk");
    expect(info.sessionId).toMatch(/^vs_/);
    expect(info.streamPath).toBe(`/api/v1/voice/sessions/${info.sessionId}/stream`);
    expect(info.model).toBe("fake-talker");
    await client.endSession(info.sessionId);
  });

  it("turns each refusal into an H1Refused with the host's own code", async () => {
    for (const [refuseH1, status, code] of [
      ["gateway_blocked", 403, "gateway_blocked"],
      ["voice_model_unavailable", 503, "voice_model_unavailable"],
      ["voice_session_limit", 429, "voice_session_limit"],
    ] as const) {
      const { client } = await boot({ refuseH1 });
      await client.settings();
      const thread = await client.createThread();
      const refusal = await client.startSession(thread).catch((error: unknown) => error);
      expect(refusal, refuseH1).toBeInstanceOf(H1Refused);
      expect(refusal).toMatchObject({ status, code });
    }
  });

  it("reads the error code from both answer shapes", () => {
    expect(errorCodeOf({ error: { code: "voice_disabled", message: "off" } })).toBe("voice_disabled");
    expect(errorCodeOf({ error: "gateway_blocked", status: "needs_key", message: "No key" })).toBe("gateway_blocked");
    expect(errorCodeOf({ nothing: 1 })).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
    expect(errorMessageOf({ error: "gateway_blocked", message: "No key" })).toBe("No key");
    expect(errorMessageOf({ error: { code: "x", message: "inner" } })).toBe("inner");
  });
});

describe("the settings read", () => {
  it("reports voice, the runtime and the desk's language", async () => {
    const { client } = await boot();
    expect(await client.settings()).toEqual({ voice: { enabled: true, model: "fake-talker" }, runtime: "ai", locale: "id" });
  });

  it("says voice is off when the desk says so", async () => {
    const { client } = await boot({ voiceEnabled: false });
    expect((await client.settings()).voice?.enabled).toBe(false);
  });
});
