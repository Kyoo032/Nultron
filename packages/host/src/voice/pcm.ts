import { VOICE_BYTES_PER_SAMPLE, VOICE_SAMPLE_RATE } from "@agentforge/core/voice";

/** Bytes of one millisecond of 16-bit mono 24 kHz PCM. */
export const VOICE_BYTES_PER_MS = (VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE) / 1000;

export function pcmBytesForMs(ms: number): number {
  return Math.max(0, Math.round(ms * VOICE_BYTES_PER_MS));
}

export function pcmDurationMs(byteLength: number): number {
  if (byteLength <= 0) return 0;
  return (byteLength / VOICE_BYTES_PER_SAMPLE / VOICE_SAMPLE_RATE) * 1000;
}

/** More than three seconds of audio for each second of wall time, and only once a second has passed. */
export function audioFasterThanRealtime(bytesInWindow: number, windowMs: number): boolean {
  if (windowMs < 1000) return false;
  return pcmDurationMs(bytesInWindow) > 3 * windowMs;
}

/** A few seconds of agent audio stuck in the socket buffer. Past this the listener has gone. */
export const VOICE_OUTBOUND_BACKLOG_BYTES = 3 * VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE;

export function outboundBacklogTooHigh(bufferedAmount: number): boolean {
  return bufferedAmount > VOICE_OUTBOUND_BACKLOG_BYTES;
}
