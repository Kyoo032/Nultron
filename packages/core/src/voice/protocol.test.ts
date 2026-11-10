import { describe, expect, it } from "vitest";
import {
  parseVoiceBrowserFrame,
  parseVoiceHostFrame,
  VOICE_END_REASONS,
  VOICE_FRAME_MS,
  VOICE_LIMITS,
  VOICE_MAX_TEXT_FRAME_BYTES,
  VOICE_MODES,
  VOICE_REFUSALS,
  VOICE_STATES,
  VOICE_STREAM_PATH_PATTERN,
  type VoiceBrowserFrame,
  type VoiceHostFrame,
  voiceStreamPath,
} from "./protocol";

const roundTrip = <T>(parse: (raw: string) => T | null, frame: unknown): T | null => parse(JSON.stringify(frame));

describe("parseVoiceBrowserFrame", () => {
  const FRAMES: VoiceBrowserFrame[] = [
    { type: "barge_in" },
    { type: "played", ms: 1_250 },
    { type: "commit" },
    { type: "stop" },
    { type: "mode", value: "hands_free" },
    { type: "mode", value: "push_to_talk" },
  ];

  it.each(FRAMES)("round-trips %j", (frame) => {
    expect(roundTrip(parseVoiceBrowserFrame, frame)).toEqual(frame);
  });

  it("accepts mode only with a valid value", () => {
    expect(VOICE_MODES).toEqual(["hands_free", "push_to_talk"]);
    expect(roundTrip(parseVoiceBrowserFrame, { type: "mode" })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "mode", value: "loud" })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "mode", value: 1 })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "mode", value: null })).toBeNull();
  });

  it("floors a fractional played.ms", () => {
    expect(roundTrip(parseVoiceBrowserFrame, { type: "played", ms: 99.9 })).toEqual({ type: "played", ms: 99 });
    expect(roundTrip(parseVoiceBrowserFrame, { type: "played", ms: 0 })).toEqual({ type: "played", ms: 0 });
  });

  it("drops a negative, non-finite or non-number played.ms", () => {
    expect(roundTrip(parseVoiceBrowserFrame, { type: "played", ms: -1 })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "played", ms: "10" })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "played" })).toBeNull();
    // JSON has no Infinity or NaN: they serialise to null, which is not a number either.
    expect(parseVoiceBrowserFrame(JSON.stringify({ type: "played", ms: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseVoiceBrowserFrame(JSON.stringify({ type: "played", ms: Number.NaN }))).toBeNull();
    // A literal that overflows a double parses to Infinity.
    expect(parseVoiceBrowserFrame('{"type":"played","ms":1e999}')).toBeNull();
  });

  it("drops an oversize text frame", () => {
    const padded = JSON.stringify({ type: "commit", pad: "x".repeat(VOICE_MAX_TEXT_FRAME_BYTES) });
    expect(padded.length).toBeGreaterThan(VOICE_MAX_TEXT_FRAME_BYTES);
    expect(parseVoiceBrowserFrame(padded)).toBeNull();
    const atLimit = JSON.stringify({ type: "commit" }).padEnd(VOICE_MAX_TEXT_FRAME_BYTES, " ");
    expect(parseVoiceBrowserFrame(atLimit)).toEqual({ type: "commit" });
  });

  it("drops bad JSON, non-objects and unknown types", () => {
    expect(parseVoiceBrowserFrame("{not json")).toBeNull();
    expect(parseVoiceBrowserFrame("")).toBeNull();
    expect(parseVoiceBrowserFrame("null")).toBeNull();
    expect(parseVoiceBrowserFrame("42")).toBeNull();
    expect(parseVoiceBrowserFrame('"commit"')).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: "ready" })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, { type: 7 })).toBeNull();
    expect(roundTrip(parseVoiceBrowserFrame, {})).toBeNull();
  });
});

describe("parseVoiceHostFrame", () => {
  const FRAMES: VoiceHostFrame[] = [
    { type: "ready", sessionId: "sess-12345678", threadId: "thread-1", endsAt: 1_800_000_000_000 },
    ...VOICE_STATES.map((value) => ({ type: "state", value }) as const),
    { type: "caption", role: "user", id: "u1", text: "Halo", final: false },
    { type: "caption", role: "assistant", id: "a1", text: "Hai, ada yang bisa", final: true, interrupted: true },
    { type: "caption", role: "assistant", id: "a2", text: "Selesai.", final: true, interrupted: false },
    { type: "card", card: { prompt: "Send the invoice", summary: "Send invoice 12" } },
    { type: "stop_audio" },
    { type: "resume_audio" },
    { type: "saved" },
    { type: "metrics", speechEndToFirstAudioMs: 1_380, talkerFirstAudioMs: 900, transcribeMs: 420 },
    { type: "metrics", speechEndToFirstAudioMs: null, talkerFirstAudioMs: null, transcribeMs: null },
    ...VOICE_END_REASONS.map((reason) => ({ type: "ended", reason }) as const),
    { type: "ended", reason: "error", message: "The gateway went away." },
  ];

  it.each(FRAMES)("round-trips %j", (frame) => {
    expect(roundTrip(parseVoiceHostFrame, frame)).toEqual(frame);
  });

  it("keeps caption.interrupted only when it is a boolean", () => {
    const base = { type: "caption", role: "assistant", id: "a1", text: "Hi", final: true };
    expect(roundTrip(parseVoiceHostFrame, { ...base, interrupted: true })).toEqual({ ...base, interrupted: true });
    expect(roundTrip(parseVoiceHostFrame, base)).toEqual(base);
    const dropped = roundTrip(parseVoiceHostFrame, { ...base, interrupted: "yes" });
    expect(dropped).toEqual(base);
    expect(dropped).not.toHaveProperty("interrupted");
  });

  it("accepts each metrics field as a finite number or null, and nothing else", () => {
    const base = { type: "metrics", speechEndToFirstAudioMs: 1, talkerFirstAudioMs: 2, transcribeMs: 3 };
    expect(roundTrip(parseVoiceHostFrame, { ...base, transcribeMs: null })).toEqual({ ...base, transcribeMs: null });
    expect(roundTrip(parseVoiceHostFrame, { ...base, speechEndToFirstAudioMs: "1" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { ...base, talkerFirstAudioMs: undefined })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "metrics", speechEndToFirstAudioMs: 1, talkerFirstAudioMs: 2 })).toBeNull();
    expect(parseVoiceHostFrame('{"type":"metrics","speechEndToFirstAudioMs":1e999,"talkerFirstAudioMs":2,"transcribeMs":3}')).toBeNull();
  });

  it("drops malformed frames", () => {
    expect(roundTrip(parseVoiceHostFrame, { type: "ready", sessionId: "s", threadId: "t" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "state", value: "dreaming" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "caption", role: "system", id: "x", text: "t", final: true })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "caption", role: "user", id: "x", text: "t" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "card", card: { prompt: "p" } })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "card" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "ended", reason: "bored" })).toBeNull();
  });

  it("drops bad JSON, non-objects and unknown types", () => {
    expect(parseVoiceHostFrame("{not json")).toBeNull();
    expect(parseVoiceHostFrame("null")).toBeNull();
    expect(parseVoiceHostFrame("7")).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, { type: "commit" })).toBeNull();
    expect(roundTrip(parseVoiceHostFrame, {})).toBeNull();
  });
});

describe("voice stream path", () => {
  it("matches voiceStreamPath and captures the session id", () => {
    const id = "abcd1234_EFGH-5678";
    const match = VOICE_STREAM_PATH_PATTERN.exec(voiceStreamPath(id));
    expect(match?.[1]).toBe(id);
  });

  it("rejects ids the pattern does not allow", () => {
    expect(VOICE_STREAM_PATH_PATTERN.test(voiceStreamPath("short"))).toBe(false);
    expect(VOICE_STREAM_PATH_PATTERN.test(voiceStreamPath("a".repeat(65)))).toBe(false);
    expect(VOICE_STREAM_PATH_PATTERN.test("/api/v1/voice/sessions/abcd1234/stream/extra")).toBe(false);
    expect(VOICE_STREAM_PATH_PATTERN.test("/api/v1/voice/sessions/abcd1234/other")).toBe(false);
    expect(VOICE_STREAM_PATH_PATTERN.test("/api/v1/voice/sessions/ab/../cd/stream")).toBe(false);
  });
});

describe("constants", () => {
  it("pins the new values the lanes build on", () => {
    expect(VOICE_FRAME_MS).toBe(40);
    expect(VOICE_LIMITS.maxUtteranceMs).toBe(30_000);
    expect(VOICE_REFUSALS.gatewayBlocked).toEqual({ status: 403, code: "gateway_blocked" });
  });
});
