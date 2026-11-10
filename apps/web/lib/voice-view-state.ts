/**
 * Live voice, what the view shows, as a reducer: every frame the host sends and every local event
 * (the mic refused, the screen locked, the socket dropped) go in as actions, and the whole screen
 * comes out as one value. The view draws that value and decides nothing; a node test drives it.
 */

import type { VoiceCard, VoiceEndReason, VoiceHostFrame, VoiceMode, VoiceState } from "@agentforge/core/voice";
import type { MascotState } from "./mascot-states";

/** The ways a voice start or run fails before or outside what the host's `ended` frame says. Each has an `error.<code>` line. */
export const VOICE_ERROR_CODES = [
  "micDenied",
  "micMissing",
  "micBusy",
  "unsupported",
  "insecure",
  "connect",
  "thread",
  "voice_disabled",
  "gateway_blocked",
  "voice_session_limit",
  "voice_model_unavailable",
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

/** The most captions the view keeps. The thread under it holds the rest, as text. */
export const VOICE_MAX_CAPTIONS = 80;

export type VoiceCaption = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** False while the words are still being revised; the final caption replaces them in place. */
  readonly final: boolean;
  /** The person cut this reply short, and `text` is what they heard. */
  readonly interrupted: boolean;
};

export type VoiceCardView = VoiceCard & {
  /** The person tapped it and its prompt went to Chat. */
  readonly started: boolean;
};

/**
 * - `closed`: no voice view.
 * - `opening`: the view is up, the microphone, H1 and the socket are not all ready.
 * - `live`: the host said `ready`.
 * - `ended`: over, with `ended` (a reason) or `notice`/`error` saying why.
 */
export type VoicePhase = "closed" | "opening" | "live" | "ended";

export type VoiceViewState = {
  readonly phase: VoicePhase;
  readonly state: VoiceState;
  readonly mode: VoiceMode;
  readonly captions: readonly VoiceCaption[];
  readonly card: VoiceCardView | null;
  readonly endReason: VoiceEndReason | null;
  /** The host's own words for why it ended, when it sent any. */
  readonly endMessage: string | null;
  /** The screen locked or the app was left: voice stopped, and tapping to talk again is the way back. */
  readonly backgrounded: boolean;
  readonly error: VoiceErrorCode | null;
  /** Counts the host's `saved` frames: the transcript under the view reloads each time it changes. */
  readonly saved: number;
  readonly sessionId: string | null;
  /** The host's clock for when the session ends, from `ready`. */
  readonly endsAt: number | null;
};

export function initialVoiceViewState(mode: VoiceMode = "hands_free"): VoiceViewState {
  return {
    phase: "closed",
    state: "connecting",
    mode,
    captions: [],
    card: null,
    endReason: null,
    endMessage: null,
    backgrounded: false,
    error: null,
    saved: 0,
    sessionId: null,
    endsAt: null,
  };
}

export type VoiceViewAction =
  /** The view opens and a session is being set up. Clears whatever the last one left. */
  | { readonly type: "open" }
  /** The view closes. */
  | { readonly type: "close" }
  | { readonly type: "frame"; readonly frame: VoiceHostFrame }
  | { readonly type: "failed"; readonly code: VoiceErrorCode }
  /** The socket closed and the host never said why. */
  | { readonly type: "dropped" }
  | { readonly type: "backgrounded" }
  | { readonly type: "mode"; readonly value: VoiceMode }
  /** The person tapped the card and its prompt went to Chat. */
  | { readonly type: "card_started" };

/** What a person who talked and was heard has on screen: the captions, with a late or revised one handled. */
function applyCaption(
  captions: readonly VoiceCaption[],
  frame: Extract<VoiceHostFrame, { type: "caption" }>,
): readonly VoiceCaption[] {
  const next: VoiceCaption = {
    id: frame.id,
    role: frame.role,
    text: frame.text,
    final: frame.final,
    interrupted: frame.interrupted === true,
  };
  const at = captions.findIndex((caption) => caption.id === frame.id);
  if (at >= 0) {
    // Replaced where it stands. A caption that arrives late is placed by when its id first appeared,
    // and nothing already on screen moves.
    const copy = captions.slice();
    copy[at] = next;
    return copy;
  }
  const grown = [...captions, next];
  return grown.length > VOICE_MAX_CAPTIONS ? grown.slice(grown.length - VOICE_MAX_CAPTIONS) : grown;
}

function applyFrame(state: VoiceViewState, frame: VoiceHostFrame): VoiceViewState {
  switch (frame.type) {
    case "ready":
      return { ...state, phase: "live", sessionId: frame.sessionId, endsAt: frame.endsAt };
    case "state":
      return { ...state, phase: state.phase === "opening" ? "live" : state.phase, state: frame.value };
    case "caption":
      return { ...state, captions: applyCaption(state.captions, frame) };
    case "card":
      return { ...state, card: { ...frame.card, started: false } };
    case "saved":
      return { ...state, saved: state.saved + 1 };
    case "ended":
      return {
        ...state,
        phase: "ended",
        state: "listening",
        endReason: frame.reason,
        endMessage: frame.message ?? null,
      };
    // Audio frames, and the latency numbers the view has no use for.
    case "stop_audio":
    case "resume_audio":
    case "metrics":
      return state;
  }
}

export function voiceViewReducer(state: VoiceViewState, action: VoiceViewAction): VoiceViewState {
  switch (action.type) {
    case "open":
      return { ...initialVoiceViewState(state.mode), phase: "opening", saved: state.saved };
    case "close":
      return { ...initialVoiceViewState(state.mode), saved: state.saved };
    case "mode":
      return { ...state, mode: action.value };
    case "card_started":
      return state.card ? { ...state, card: { ...state.card, started: true } } : state;
    case "frame":
      // A session that has ended takes nothing more: a frame that was in flight when the socket closed
      // must not bring it back to life.
      if (state.phase === "closed" || state.phase === "ended") {
        return state;
      }
      return applyFrame(state, action.frame);
    case "failed":
      if (state.phase === "closed") {
        return state;
      }
      return { ...state, phase: "ended", state: "listening", error: action.code, backgrounded: false };
    case "dropped":
      if (state.phase === "closed" || state.phase === "ended") {
        return state;
      }
      return { ...state, phase: "ended", state: "listening", endReason: "dropped" };
    case "backgrounded":
      if (state.phase === "closed" || state.phase === "ended") {
        return state;
      }
      return { ...state, phase: "ended", state: "listening", backgrounded: true };
  }
}

/** The pose the desk buddy and the view's own character take for each host state. */
export function voiceMascot(phase: VoicePhase, state: VoiceState): { state: MascotState; busy: boolean } {
  if (phase !== "live") {
    return { state: "idle", busy: false };
  }
  switch (state) {
    case "connecting":
      return { state: "idle", busy: false };
    case "listening":
    case "hearing":
      // A working pose only loops while something is really going on, and here the desk is listening.
      return { state: "listening", busy: true };
    case "thinking":
      return { state: "thinking", busy: true };
    case "speaking":
      return { state: "answering", busy: true };
  }
}

/** The buddy's claim outranks Chat's own (`BUDDY_PRIORITY.job`, 60) while voice is open. */
export const VOICE_BUDDY_PRIORITY = 61;

/** The line under the character: which end reason or failure explains a screen that is not live. */
export type VoiceNotice =
  | { readonly kind: "error"; readonly code: VoiceErrorCode }
  | { readonly kind: "backgrounded" }
  | { readonly kind: "ended"; readonly reason: VoiceEndReason; readonly message: string | null };

export function voiceNotice(state: VoiceViewState): VoiceNotice | null {
  if (state.phase !== "ended") {
    return null;
  }
  if (state.error) {
    return { kind: "error", code: state.error };
  }
  if (state.backgrounded) {
    return { kind: "backgrounded" };
  }
  return { kind: "ended", reason: state.endReason ?? "dropped", message: state.endMessage };
}

/** An error after which asking again can work. The others (an old browser, an http page, voice off, no key) need a change first. */
export function voiceCanRetry(code: VoiceErrorCode): boolean {
  return !(code === "unsupported" || code === "insecure" || code === "voice_disabled" || code === "gateway_blocked");
}

/** The voice view is on screen: setting up, live, or showing why it stopped. */
export function voiceShown(state: VoiceViewState): boolean {
  return state.phase !== "closed";
}

/** A session is set up or running, so the microphone may be open. */
export function voiceRunning(state: VoiceViewState): boolean {
  return state.phase === "opening" || state.phase === "live";
}
