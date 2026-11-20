/**
 * Live voice, why it did not start: the microphone's refusals and the host's H1 refusals, both turned
 * into one `VoiceErrorCode` that has an `error.<code>` line in `locales/<lang>/voice.json`.
 */

import { VOICE_REFUSALS } from "@agentforge/core/voice";
import { mapUserMediaError } from "./meeting-recorder-media";
import type { VoiceErrorCode } from "./voice-view-state";

/** The copy key of a failure. */
export function voiceErrorKey(code: VoiceErrorCode): string {
  return `voice.error.${code}`;
}

/**
 * What `getUserMedia` threw. The meeting recorder's mapping is reused for a blocked microphone and a
 * missing one; a microphone that exists and is allowed but would not start (`NotReadableError`, and
 * the older `TrackStartError`) is what another app holding it looks like, and it is also what any
 * other failure to start one is called, since that is the nearest thing a person can act on.
 */
export function mapVoiceMicError(error: unknown): VoiceErrorCode {
  switch (mapUserMediaError(error)) {
    case "permission_denied":
      return "micDenied";
    case "no_device":
      return "micMissing";
    default:
      return "micBusy";
  }
}

const REFUSAL_CODES: ReadonlySet<string> = new Set(Object.values(VOICE_REFUSALS).map((refusal) => refusal.code));

/**
 * A refused H1. The host answers in two shapes: the usual envelope `{ error: { code, message } }`
 * for `voice_disabled`, `voice_session_limit` and `voice_model_unavailable`, and, when the gateway
 * gate is closed, the gate's own flat body `{ error: "gateway_blocked", status, message }`. Both are
 * read here. Anything else, including a body that is not JSON, is a failure to connect.
 */
export function voiceRefusalCode(body: unknown): VoiceErrorCode {
  if (!body || typeof body !== "object") {
    return "connect";
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") {
    return REFUSAL_CODES.has(error) ? (error as VoiceErrorCode) : "connect";
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && REFUSAL_CODES.has(code)) {
      return code as VoiceErrorCode;
    }
  }
  return "connect";
}
