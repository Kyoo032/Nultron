import { describe, expect, it } from "vitest";
import { mapVoiceMicError, voiceRefusalCode } from "./voice-errors";
import { openVoiceSession, voiceSocketUrl } from "./voice-session-api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const created = {
  sessionId: "sess-abcdef12",
  threadId: "thread-1",
  model: "qwen",
  streamPath: "/api/v1/voice/sessions/sess-abcdef12/stream",
  endsAt: 1_700_000_000_000,
};

describe("the socket address", () => {
  it("is ws: for an http: page", () => {
    expect(voiceSocketUrl({ protocol: "http:", host: "127.0.0.1:3000" }, created.streamPath)).toBe(
      "ws://127.0.0.1:3000/api/v1/voice/sessions/sess-abcdef12/stream",
    );
  });

  it("is wss: for an https: page", () => {
    expect(voiceSocketUrl({ protocol: "https:", host: "desk.example.com" }, created.streamPath)).toBe(
      "wss://desk.example.com/api/v1/voice/sessions/sess-abcdef12/stream",
    );
  });

  it("keeps the page's own host, so the port is the page's port", () => {
    expect(voiceSocketUrl({ protocol: "http:", host: "localhost:5173" }, "/x")).toBe("ws://localhost:5173/x");
  });

  it("never lets a path name another origin", () => {
    expect(voiceSocketUrl({ protocol: "https:", host: "desk.example.com" }, "//evil.example/stream")).toBe(
      "wss://desk.example.com/evil.example/stream",
    );
    expect(voiceSocketUrl({ protocol: "https:", host: "desk.example.com" }, "api/v1/x")).toBe(
      "wss://desk.example.com/api/v1/x",
    );
  });
});

describe("H1, making a session", () => {
  it("posts the thread, through the transport, and returns the session", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await openVoiceSession("thread-1", "hands_free", async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return jsonResponse(201, created);
    });
    expect(result).toEqual({ ok: true, session: created });
    expect(calls[0]?.url).toBe("/api/v1/voice/sessions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ threadId: "thread-1" });
  });

  it("sends the mode only when it is not the default", async () => {
    let body = "";
    await openVoiceSession("thread-1", "push_to_talk", async (_url, init) => {
      body = String(init?.body);
      return jsonResponse(201, created);
    });
    expect(JSON.parse(body)).toEqual({ threadId: "thread-1", mode: "push_to_talk" });
  });

  it.each([
    ["voice_disabled", 403],
    ["voice_session_limit", 429],
    ["voice_model_unavailable", 503],
  ])("reads the usual envelope: `%s`", async (code, status) => {
    const result = await openVoiceSession("t", "hands_free", async () =>
      jsonResponse(status, { error: { code, message: "no" } }),
    );
    expect(result).toEqual({ ok: false, code });
  });

  it("reads the gateway gate's own flat body: `gateway_blocked`", async () => {
    const result = await openVoiceSession("t", "hands_free", async () =>
      jsonResponse(403, { error: "gateway_blocked", status: "invalid", message: "Key rejected" }),
    );
    expect(result).toEqual({ ok: false, code: "gateway_blocked" });
  });

  it("calls anything else a failure to connect", async () => {
    expect(
      await openVoiceSession("t", "hands_free", async () => jsonResponse(500, { error: { code: "boom" } })),
    ).toEqual({ ok: false, code: "connect" });
    expect(await openVoiceSession("t", "hands_free", async () => new Response("<html>", { status: 502 }))).toEqual({
      ok: false,
      code: "connect",
    });
    expect(
      await openVoiceSession("t", "hands_free", async () => {
        throw new TypeError("network down");
      }),
    ).toEqual({ ok: false, code: "connect" });
  });

  it("calls a 201 with a body that is not a session a failure to connect", async () => {
    expect(await openVoiceSession("t", "hands_free", async () => jsonResponse(201, { sessionId: "x" }))).toEqual({
      ok: false,
      code: "connect",
    });
  });
});

describe("a refusal, in either shape", () => {
  it("is read from `error.code` and from a flat `error` string", () => {
    expect(voiceRefusalCode({ error: { code: "voice_disabled" } })).toBe("voice_disabled");
    expect(voiceRefusalCode({ error: "gateway_blocked" })).toBe("gateway_blocked");
  });

  it("is `connect` for a code it does not know, and for a body that is not an object", () => {
    expect(voiceRefusalCode({ error: { code: "teapot" } })).toBe("connect");
    expect(voiceRefusalCode({ error: "teapot" })).toBe("connect");
    expect(voiceRefusalCode(null)).toBe("connect");
    expect(voiceRefusalCode("gateway_blocked")).toBe("connect");
  });
});

describe("the microphone's refusals", () => {
  it("maps each name the brief lists", () => {
    expect(mapVoiceMicError({ name: "NotAllowedError" })).toBe("micDenied");
    expect(mapVoiceMicError({ name: "NotFoundError" })).toBe("micMissing");
    expect(mapVoiceMicError({ name: "NotReadableError" })).toBe("micBusy");
  });

  it("maps the older and neighbouring names the meeting recorder already knows", () => {
    expect(mapVoiceMicError({ name: "PermissionDeniedError" })).toBe("micDenied");
    expect(mapVoiceMicError({ name: "SecurityError" })).toBe("micDenied");
    expect(mapVoiceMicError({ name: "DevicesNotFoundError" })).toBe("micMissing");
    expect(mapVoiceMicError({ name: "OverconstrainedError" })).toBe("micMissing");
  });

  it("calls any other failure to start the microphone busy", () => {
    expect(mapVoiceMicError(new Error("odd"))).toBe("micBusy");
    expect(mapVoiceMicError(undefined)).toBe("micBusy");
  });
});
