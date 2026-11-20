import { VOICE_END_REASONS, VOICE_STATES, type VoiceHostFrame } from "@agentforge/core/voice";
import { describe, expect, it } from "vitest";
import {
  initialVoiceViewState,
  VOICE_ERROR_CODES,
  VOICE_MAX_CAPTIONS,
  voiceCanRetry,
  voiceMascot,
  voiceNotice,
  voiceRunning,
  voiceShown,
  voiceViewReducer,
  type VoiceViewAction,
  type VoiceViewState,
} from "./voice-view-state";

function run(actions: readonly VoiceViewAction[], from: VoiceViewState = initialVoiceViewState()): VoiceViewState {
  return actions.reduce(voiceViewReducer, from);
}

const frame = (value: VoiceHostFrame): VoiceViewAction => ({ type: "frame", frame: value });

const ready = frame({ type: "ready", sessionId: "sess-1234", threadId: "t1", endsAt: 99 });

function live(): VoiceViewState {
  return run([{ type: "open" }, ready]);
}

describe("opening", () => {
  it("starts closed, in hands-free", () => {
    const state = initialVoiceViewState();
    expect(state.phase).toBe("closed");
    expect(state.mode).toBe("hands_free");
    expect(voiceShown(state)).toBe(false);
  });

  it("opens into `connecting`, with the view shown and the session running", () => {
    const state = run([{ type: "open" }]);
    expect(state.phase).toBe("opening");
    expect(state.state).toBe("connecting");
    expect(voiceShown(state)).toBe(true);
    expect(voiceRunning(state)).toBe(true);
  });

  it("goes live on `ready` and keeps the host's session and clock", () => {
    const state = live();
    expect(state.phase).toBe("live");
    expect(state.sessionId).toBe("sess-1234");
    expect(state.endsAt).toBe(99);
  });

  it("opening again clears what the last session left, and keeps the mode and the saved count", () => {
    const first = run([
      { type: "open" },
      ready,
      frame({ type: "caption", role: "user", id: "u1", text: "hi", final: true }),
      frame({ type: "saved" }),
      { type: "mode", value: "push_to_talk" },
      frame({ type: "ended", reason: "idle" }),
    ]);
    const again = voiceViewReducer(first, { type: "open" });
    expect(again.captions).toEqual([]);
    expect(again.endReason).toBeNull();
    expect(again.phase).toBe("opening");
    expect(again.mode).toBe("push_to_talk");
    expect(again.saved).toBe(1);
  });

  it("closing returns to nothing, and keeps the saved count so a reload is not repeated", () => {
    const closed = voiceViewReducer(run([{ type: "open" }, ready, frame({ type: "saved" })]), { type: "close" });
    expect(closed.phase).toBe("closed");
    expect(closed.saved).toBe(1);
    expect(closed.captions).toEqual([]);
  });
});

describe("every host frame", () => {
  it.each(VOICE_STATES)("`state: %s` is shown", (value) => {
    const state = voiceViewReducer(live(), { type: "frame", frame: { type: "state", value } });
    expect(state.state).toBe(value);
    expect(state.phase).toBe("live");
  });

  it("a state frame before `ready` also makes the view live", () => {
    const state = run([{ type: "open" }, frame({ type: "state", value: "listening" })]);
    expect(state.phase).toBe("live");
  });

  it("`saved` is counted, so the transcript reloads each time", () => {
    const state = run([{ type: "open" }, ready, frame({ type: "saved" }), frame({ type: "saved" })]);
    expect(state.saved).toBe(2);
  });

  it("`card` shows the card, not yet started, and a newer card replaces it", () => {
    const state = run([
      { type: "open" },
      ready,
      frame({ type: "card", card: { prompt: "make the deck", summary: "Make the deck" } }),
    ]);
    expect(state.card).toEqual({ prompt: "make the deck", summary: "Make the deck", started: false });
    const newer = voiceViewReducer(state, {
      type: "frame",
      frame: { type: "card", card: { prompt: "send it", summary: "Send it" } },
    });
    expect(newer.card?.summary).toBe("Send it");
  });

  it("`card_started` marks the card as run", () => {
    const state = run([
      { type: "open" },
      ready,
      frame({ type: "card", card: { prompt: "p", summary: "s" } }),
      { type: "card_started" },
    ]);
    expect(state.card?.started).toBe(true);
  });

  it("`card_started` with no card changes nothing", () => {
    const before = live();
    expect(voiceViewReducer(before, { type: "card_started" })).toBe(before);
  });

  it.each(["stop_audio", "resume_audio"] as const)("`%s` is for the audio, and leaves the screen as it is", (type) => {
    const before = live();
    expect(voiceViewReducer(before, { type: "frame", frame: { type } })).toBe(before);
  });

  it("`metrics` is ignored by the view", () => {
    const before = live();
    const after = voiceViewReducer(before, {
      type: "frame",
      frame: { type: "metrics", speechEndToFirstAudioMs: 900, talkerFirstAudioMs: 700, transcribeMs: 120 },
    });
    expect(after).toBe(before);
  });

  it.each(VOICE_END_REASONS)("`ended: %s` ends the session with that reason", (reason) => {
    const state = voiceViewReducer(live(), { type: "frame", frame: { type: "ended", reason } });
    expect(state.phase).toBe("ended");
    expect(state.endReason).toBe(reason);
    expect(voiceRunning(state)).toBe(false);
    expect(voiceShown(state)).toBe(true);
    expect(voiceNotice(state)).toEqual({ kind: "ended", reason, message: null });
  });

  it("`ended` keeps the host's message, when it sent one", () => {
    const state = voiceViewReducer(live(), {
      type: "frame",
      frame: { type: "ended", reason: "error", message: "the model stopped" },
    });
    expect(voiceNotice(state)).toEqual({ kind: "ended", reason: "error", message: "the model stopped" });
  });

  it("takes nothing after the session has ended: a late frame cannot bring it back", () => {
    const ended = voiceViewReducer(live(), { type: "frame", frame: { type: "ended", reason: "replaced" } });
    const late = run(
      [frame({ type: "state", value: "speaking" }), frame({ type: "saved" }), { type: "dropped" }],
      ended,
    );
    expect(late).toEqual(ended);
  });

  it("takes nothing while closed", () => {
    const closed = initialVoiceViewState();
    expect(voiceViewReducer(closed, frame({ type: "state", value: "speaking" }))).toBe(closed);
    expect(voiceViewReducer(closed, { type: "failed", code: "connect" })).toBe(closed);
    expect(voiceViewReducer(closed, { type: "backgrounded" })).toBe(closed);
  });
});

describe("captions", () => {
  const caption = (
    role: "user" | "assistant",
    id: string,
    text: string,
    final: boolean,
    interrupted?: boolean,
  ): VoiceViewAction =>
    frame({ type: "caption", role, id, text, final, ...(interrupted === undefined ? {} : { interrupted }) });

  it("replaces a partial caption in place by its id, with the final", () => {
    const state = run([
      { type: "open" },
      ready,
      caption("assistant", "a1", "Sure, the", false),
      caption("assistant", "a1", "Sure, the report is", false),
      caption("assistant", "a1", "Sure, the report is ready.", true),
    ]);
    expect(state.captions).toHaveLength(1);
    expect(state.captions[0]).toMatchObject({ id: "a1", text: "Sure, the report is ready.", final: true });
  });

  it("puts the person's late words above the reply of their own turn, and revises nothing already on screen", () => {
    // The agent's reply starts before the person's own words have been transcribed: seen live, 3 to 5 s later.
    const state = run([
      { type: "open" },
      ready,
      caption("assistant", "a1", "It is Tuesday.", false),
      caption("user", "u1", "what day is it", true),
      caption("assistant", "a1", "It is Tuesday.", true),
    ]);
    expect(state.captions.map((entry) => entry.id)).toEqual(["u1", "a1"]);
    expect(state.captions[1]?.final).toBe(true);
  });

  it("puts the words above the acknowledgement of their turn, and above only their own turn's reply", () => {
    const state = run([
      { type: "open" },
      ready,
      caption("user", "u1", "one", true),
      caption("assistant", "a1", "uno", true),
      caption("assistant", "ack2", "Sebentar", true),
      caption("assistant", "a2", "dos", true),
      caption("user", "u2", "two", true),
    ]);
    expect(state.captions.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "ack2", "a2"]);
  });

  it("puts the words of a cut turn above its cut reply, after the next turn has begun", () => {
    const state = run([
      { type: "open" },
      ready,
      caption("assistant", "a1", "Halo, saya", true, true),
      caption("user", "u2", "stop", true),
      caption("assistant", "a2", "Baik", false),
      caption("user", "u1", "halo apa kabar", true),
    ]);
    expect(state.captions.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("appends a caption whose id carries no turn, or whose turn has no reply yet", () => {
    const state = run([
      { type: "open" },
      ready,
      caption("assistant", "a1", "reply", true),
      caption("user", "voice-x", "no turn number", true),
      caption("user", "u3", "no reply yet", true),
    ]);
    expect(state.captions.map((entry) => entry.id)).toEqual(["a1", "voice-x", "u3"]);
  });

  it("keeps a later turn after an earlier one, whatever order their revisions arrive in", () => {
    const state = run([
      { type: "open" },
      ready,
      caption("user", "u1", "one", false),
      caption("assistant", "a1", "uno", true),
      caption("user", "u2", "two", true),
      caption("user", "u1", "one!", true),
    ]);
    expect(state.captions.map((entry) => `${entry.id}:${entry.text}`)).toEqual(["u1:one!", "a1:uno", "u2:two"]);
  });

  it("marks a reply the person cut short, with what they heard", () => {
    const state = run([{ type: "open" }, ready, caption("assistant", "a1", "Sure, the rep", true, true)]);
    expect(state.captions[0]).toMatchObject({ text: "Sure, the rep", interrupted: true });
  });

  it("is not interrupted unless the host said so", () => {
    const state = run([{ type: "open" }, ready, caption("assistant", "a1", "Done.", true)]);
    expect(state.captions[0]?.interrupted).toBe(false);
  });

  it("keeps only the most recent captions", () => {
    const actions: VoiceViewAction[] = [{ type: "open" }, ready];
    for (let i = 0; i < VOICE_MAX_CAPTIONS + 5; i += 1) {
      actions.push(caption("user", `u${i}`, `line ${i}`, true));
    }
    const state = run(actions);
    expect(state.captions).toHaveLength(VOICE_MAX_CAPTIONS);
    expect(state.captions[0]?.id).toBe("u5");
  });
});

describe("failures", () => {
  it.each(VOICE_ERROR_CODES)("`failed: %s` ends the session with that error", (code) => {
    const state = run([{ type: "open" }, { type: "failed", code }]);
    expect(state.phase).toBe("ended");
    expect(state.error).toBe(code);
    expect(voiceNotice(state)).toEqual({ kind: "error", code });
  });

  it("has an error for every way the brief lists, and for both shapes of refusal", () => {
    expect([...VOICE_ERROR_CODES].sort()).toEqual(
      [
        "connect",
        "gateway_blocked",
        "insecure",
        "micBusy",
        "micDenied",
        "micMissing",
        "thread",
        "unsupported",
        "voice_disabled",
        "voice_model_unavailable",
        "voice_session_limit",
      ].sort(),
    );
  });

  it("offers to try again for what can change, and not for what cannot", () => {
    expect(voiceCanRetry("micDenied")).toBe(true);
    expect(voiceCanRetry("connect")).toBe(true);
    expect(voiceCanRetry("voice_session_limit")).toBe(true);
    expect(voiceCanRetry("unsupported")).toBe(false);
    expect(voiceCanRetry("insecure")).toBe(false);
    expect(voiceCanRetry("voice_disabled")).toBe(false);
    expect(voiceCanRetry("gateway_blocked")).toBe(false);
  });

  it("a socket that closes without a word is `dropped`", () => {
    const state = voiceViewReducer(live(), { type: "dropped" });
    expect(state.phase).toBe("ended");
    expect(voiceNotice(state)).toEqual({ kind: "ended", reason: "dropped", message: null });
  });

  it("a locked screen or a hidden tab on a phone is `backgrounded`, not an error", () => {
    const state = voiceViewReducer(live(), { type: "backgrounded" });
    expect(state.phase).toBe("ended");
    expect(state.backgrounded).toBe(true);
    expect(voiceNotice(state)).toEqual({ kind: "backgrounded" });
  });

  it("an error wins over a stale end reason in what is shown", () => {
    const state = run([{ type: "open" }, ready, { type: "failed", code: "micBusy" }]);
    expect(voiceNotice(state)?.kind).toBe("error");
  });

  it("has no notice while live", () => {
    expect(voiceNotice(live())).toBeNull();
  });
});

describe("the mode", () => {
  it("holds the person's choice", () => {
    expect(run([{ type: "mode", value: "push_to_talk" }]).mode).toBe("push_to_talk");
  });
});

describe("the mascot", () => {
  it("maps connecting to idle, listening and hearing to listening, thinking to thinking, speaking to answering", () => {
    expect(voiceMascot("live", "connecting")).toEqual({ state: "idle", busy: false });
    expect(voiceMascot("live", "listening")).toEqual({ state: "listening", busy: true });
    expect(voiceMascot("live", "hearing")).toEqual({ state: "listening", busy: true });
    expect(voiceMascot("live", "thinking")).toEqual({ state: "thinking", busy: true });
    expect(voiceMascot("live", "speaking")).toEqual({ state: "answering", busy: true });
  });

  it("is idle and not busy until the session is live, and after it", () => {
    expect(voiceMascot("opening", "speaking")).toEqual({ state: "idle", busy: false });
    expect(voiceMascot("ended", "speaking")).toEqual({ state: "idle", busy: false });
    expect(voiceMascot("closed", "speaking")).toEqual({ state: "idle", busy: false });
  });
});
