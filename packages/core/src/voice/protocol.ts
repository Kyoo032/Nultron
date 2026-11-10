/**
 * Live voice in Chat (docs/internal/voice-mode-plan.md, week one). The one shape the browser, the
 * host relay and the tests share.
 *
 * Audio travels as binary WebSocket frames of 16-bit little-endian PCM, mono, at 24 kHz: the
 * OpenAI Realtime default, so the host passes it to the gateway without resampling. Everything
 * else is a JSON text frame from the two unions below, parsed at the boundary on both sides.
 */

export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_CHANNELS = 1;
export const VOICE_BYTES_PER_SAMPLE = 2;

/** Largest binary frame either side accepts: one second of audio. The browser sends ~40 ms frames. */
export const VOICE_MAX_AUDIO_FRAME_BYTES = VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE;
/** Largest JSON frame the host accepts from the browser. */
export const VOICE_MAX_TEXT_FRAME_BYTES = 4 * 1024;

/** Host-side limits. A session ends at the first one it reaches, by the host's own clock. */
export const VOICE_LIMITS = {
  /** Longest session, from H1. */
  maxSessionMs: 15 * 60 * 1000,
  /** No audio and no frame from the browser for this long ends the session. */
  idleMs: 2 * 60 * 1000,
  /** H1 to the socket being opened. A session nobody connects to is dropped. */
  connectMs: 30 * 1000,
  /** Open sessions per desk owner. One person talks in one place at a time. */
  maxOpenPerOwner: 1,
  /** Open sessions in the whole process, the hosted box's guard. */
  maxOpenPerProcess: 8,
} as const;

/**
 * What the agent is doing, as the voice view and the mascot show it.
 *
 * - `connecting`: H1 answered, the gateway socket is not ready yet.
 * - `listening`: waiting for the person.
 * - `hearing`: the person is speaking (the gateway reported speech).
 * - `thinking`: the turn is finished and an answer is being made (a reply, or `ask_nultron`).
 * - `speaking`: the agent's audio is going out.
 */
export const VOICE_STATES = ["connecting", "listening", "hearing", "thinking", "speaking"] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export const VOICE_END_REASONS = ["user", "max_length", "idle", "dropped", "error", "replaced"] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

/** A write or paid step the voice tool will not run on its own. The person taps it in the voice view. */
export type VoiceCard = {
  /** The text the tap sends as a normal Chat turn (H5). */
  readonly prompt: string;
  /** One line the card shows. */
  readonly summary: string;
};

/** JSON frames from the host to the browser. */
export type VoiceHostFrame =
  | { readonly type: "ready"; readonly sessionId: string; readonly threadId: string; readonly endsAt: number }
  | { readonly type: "state"; readonly value: VoiceState }
  | {
      readonly type: "caption";
      readonly role: "user" | "assistant";
      /** Stable per utterance, so a partial caption is replaced in place by its final one. */
      readonly id: string;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: "card"; readonly card: VoiceCard }
  /** Drop every queued agent sample now: a real interruption. */
  | { readonly type: "stop_audio" }
  /** A backchannel ("iya", "hmm"): resume the audio the browser paused. */
  | { readonly type: "resume_audio" }
  /** A turn was saved to the thread, so the transcript under the voice view can reload. */
  | { readonly type: "saved" }
  | { readonly type: "ended"; readonly reason: VoiceEndReason; readonly message?: string };

/** JSON frames from the browser to the host. */
export type VoiceBrowserFrame =
  /** The browser heard the person over the agent and paused playback locally. */
  | { readonly type: "barge_in" }
  /** How many ms of the current agent reply the person actually heard. Sent after a pause or a stop. */
  | { readonly type: "played"; readonly ms: number }
  /** Push-to-talk released: treat what was said as a finished turn. */
  | { readonly type: "commit" }
  | { readonly type: "stop" };

/** Parses one text frame from the browser. Anything else is null, and the host drops it. */
export function parseVoiceBrowserFrame(raw: string): VoiceBrowserFrame | null {
  if (raw.length > VOICE_MAX_TEXT_FRAME_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const frame = value as { type?: unknown; ms?: unknown };
  switch (frame.type) {
    case "barge_in":
    case "commit":
    case "stop":
      return { type: frame.type };
    case "played":
      return typeof frame.ms === "number" && Number.isFinite(frame.ms) && frame.ms >= 0
        ? { type: "played", ms: Math.floor(frame.ms) }
        : null;
    default:
      return null;
  }
}

/** Parses one text frame from the host. Used by the browser. Unknown frames are null. */
export function parseVoiceHostFrame(raw: string): VoiceHostFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      return typeof frame.sessionId === "string" && typeof frame.threadId === "string" && typeof frame.endsAt === "number"
        ? { type: "ready", sessionId: frame.sessionId, threadId: frame.threadId, endsAt: frame.endsAt }
        : null;
    case "state":
      return VOICE_STATES.includes(frame.value as VoiceState) ? { type: "state", value: frame.value as VoiceState } : null;
    case "caption":
      return (frame.role === "user" || frame.role === "assistant") &&
        typeof frame.id === "string" &&
        typeof frame.text === "string" &&
        typeof frame.final === "boolean"
        ? { type: "caption", role: frame.role, id: frame.id, text: frame.text, final: frame.final }
        : null;
    case "card": {
      const card = frame.card as { prompt?: unknown; summary?: unknown } | undefined;
      return card && typeof card.prompt === "string" && typeof card.summary === "string"
        ? { type: "card", card: { prompt: card.prompt, summary: card.summary } }
        : null;
    }
    case "stop_audio":
    case "resume_audio":
    case "saved":
      return { type: frame.type };
    case "ended":
      return VOICE_END_REASONS.includes(frame.reason as VoiceEndReason)
        ? {
            type: "ended",
            reason: frame.reason as VoiceEndReason,
            ...(typeof frame.message === "string" ? { message: frame.message } : {}),
          }
        : null;
    default:
      return null;
  }
}

/** H1 `POST /api/v1/voice/sessions` body. `threadId` is the Chat thread the turns are saved to. */
export type VoiceSessionRequest = { readonly threadId: string };

/** H1 success, `201`. The browser then opens `streamPath` as a WebSocket on the same origin. */
export type VoiceSessionCreated = {
  readonly sessionId: string;
  readonly threadId: string;
  readonly model: string;
  readonly streamPath: string;
  readonly endsAt: number;
};

/** H1 refusals, as the `error.code` of the usual envelope. */
export const VOICE_REFUSALS = {
  disabled: { status: 403, code: "voice_disabled" },
  sessionLimit: { status: 429, code: "voice_session_limit" },
  modelUnavailable: { status: 503, code: "voice_model_unavailable" },
} as const;

/** `voice` in `GET /api/v1/settings`. The mic shows only when `enabled`. */
export type VoiceSettings = { readonly enabled: boolean; readonly model: string | null };

/** The path of H2 for one session. The host's upgrade handler matches exactly this shape. */
export function voiceStreamPath(sessionId: string): string {
  return `/api/v1/voice/sessions/${encodeURIComponent(sessionId)}/stream`;
}

export const VOICE_STREAM_PATH_PATTERN = /^\/api\/v1\/voice\/sessions\/([A-Za-z0-9_-]{8,64})\/stream$/;
