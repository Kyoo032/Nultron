/**
 * Host voice detection over 16-bit PCM mono at 24 kHz (plan W2). The host finds the start and the
 * end of speech itself because the gateway offers no realtime socket for this account. Lane D owns
 * this file. The signatures are the contract; this is a plain working version a later worker tunes.
 * Time comes from the sample count, never a clock.
 */
import { VOICE_BYTES_PER_SAMPLE, VOICE_SAMPLE_RATE } from "@agentforge/core/voice";

export type VadEvent =
  | { readonly type: "speech_start"; readonly atMs: number }
  | { readonly type: "speech_end"; readonly atMs: number; readonly speechMs: number };

export type VadOptions = {
  /** RMS level (0..1) above which a frame counts as speech. */
  readonly threshold: number;
  /** Speech this long starts an utterance. */
  readonly minSpeechMs: number;
  /** Silence this long ends it. `speech_end.atMs` is the time of the last speech frame. */
  readonly hangoverMs: number;
};

export type Vad = {
  /** Feed PCM in any chunk size. Returns the events this chunk caused, in order. */
  push(pcm: Buffer): VadEvent[];
  readonly speaking: boolean;
  /** Milliseconds of audio since the last speech frame, 0 while speaking. */
  readonly silenceMs: number;
  /** Milliseconds of audio fed so far. */
  readonly nowMs: number;
  reset(): void;
};

export const VAD_DEFAULTS: VadOptions = { threshold: 0.015, minSpeechMs: 120, hangoverMs: 200 };

/** One analysis window. */
const WINDOW_MS = 20;
const WINDOW_SAMPLES = (VOICE_SAMPLE_RATE * WINDOW_MS) / 1000;
const WINDOW_BYTES = WINDOW_SAMPLES * VOICE_BYTES_PER_SAMPLE;

export function createVad(options: Partial<VadOptions> = {}): Vad {
  const threshold = options.threshold ?? VAD_DEFAULTS.threshold;
  const minSpeechMs = options.minSpeechMs ?? VAD_DEFAULTS.minSpeechMs;
  const hangoverMs = options.hangoverMs ?? VAD_DEFAULTS.hangoverMs;

  let carry: Buffer = Buffer.alloc(0);
  let windows = 0;
  let speaking = false;
  /** End time of the most recent speech window, or null before any. */
  let lastSpeechEndMs: number | null = null;
  /** Start time and length of the run of speech windows that has not yet become an utterance. */
  let pendingStartMs = 0;
  let pendingMs = 0;
  /** Start of the utterance in progress. */
  let utteranceStartMs = 0;

  function reset(): void {
    carry = Buffer.alloc(0);
    windows = 0;
    speaking = false;
    lastSpeechEndMs = null;
    pendingStartMs = 0;
    pendingMs = 0;
    utteranceStartMs = 0;
  }

  function push(pcm: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    // An odd trailing byte is half a sample: it waits in the carry for its other half.
    const data = carry.length === 0 ? pcm : Buffer.concat([carry, pcm]);
    let offset = 0;
    while (data.length - offset >= WINDOW_BYTES) {
      const startMs = windows * WINDOW_MS;
      const endMs = startMs + WINDOW_MS;
      windows += 1;
      const loud = rms(data, offset) > threshold;
      offset += WINDOW_BYTES;

      if (loud) {
        lastSpeechEndMs = endMs;
        if (!speaking) {
          if (pendingMs === 0) {
            pendingStartMs = startMs;
          }
          pendingMs += WINDOW_MS;
          if (pendingMs >= minSpeechMs) {
            speaking = true;
            utteranceStartMs = pendingStartMs;
            events.push({ type: "speech_start", atMs: pendingStartMs });
          }
        }
        continue;
      }

      if (speaking) {
        if (endMs - (lastSpeechEndMs ?? endMs) >= hangoverMs) {
          const atMs = lastSpeechEndMs ?? endMs;
          speaking = false;
          pendingMs = 0;
          events.push({ type: "speech_end", atMs, speechMs: atMs - utteranceStartMs });
        }
      } else {
        // A speech run shorter than `minSpeechMs` that silence interrupts is a click, not a start.
        pendingMs = 0;
      }
    }
    // `Buffer.from` copies, so the carry never aliases the caller's chunk.
    carry = Buffer.from(data.subarray(offset));
    return events;
  }

  return {
    push,
    get speaking() {
      return speaking;
    },
    get silenceMs() {
      return speaking ? 0 : windows * WINDOW_MS - (lastSpeechEndMs ?? 0);
    },
    get nowMs() {
      return windows * WINDOW_MS;
    },
    reset,
  };
}

/** RMS of one window of 16-bit little-endian samples, scaled to 0..1. */
function rms(buffer: Buffer, offset: number): number {
  let sum = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i += 1) {
    const sample = buffer.readInt16LE(offset + i * VOICE_BYTES_PER_SAMPLE) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / WINDOW_SAMPLES);
}
