/**
 * Host voice detection over 16-bit PCM mono at 24 kHz (plan W2). The host finds the start and the
 * end of speech itself because the gateway offers no realtime socket for this account. Lane D owns
 * this file. Time comes from the sample count, never a clock.
 *
 * The contract:
 * - Input is little-endian signed 16-bit PCM, mono, 24 kHz, in any chunk size (1 byte works; an odd
 *   trailing byte waits for its other half). The events are the same whatever the chunk size.
 * - The audio is cut into 10 ms windows, and each window gets one level: its RMS with the mean removed
 *   (a DC offset on the microphone is not speech).
 * - `speech_start.atMs` is the start of the first window of the run that became speech, so it is up to
 *   `minSpeechMs` earlier than the moment the event is returned. `speech_end.atMs` is the end of the last
 *   window that still counted as speech, and the event is returned `hangoverMs` later.
 * - The speech threshold rides above the room. The noise floor is learned from quiet windows only (it
 *   falls fast, rises slowly, and is capped), and speech needs `max(threshold, floor * noiseRatio)` to
 *   start and `releaseRatio` of that to carry on. `threshold` is the absolute minimum: a quiet room never
 *   gets a lower bar than that, and a loud room gets a higher one.
 * - A run of loud windows shorter than `minSpeechMs` (a click, a key press, a short cough) starts nothing.
 *   Quiet gaps of up to 40 ms inside a run do not break it.
 * - A steady sound (a fan, a hum, a tone: the level stays within a ratio of 1.8 for `steadyMs`) is not
 *   speech. If one is already counted as speech, the utterance ends where the steady run began and the
 *   level becomes the new floor. So a steady sound above the absolute minimum that is on when the stream
 *   opens gives one `speech_start` and one `speech_end` (with a `speechMs` below `steadyMs`) in the first
 *   `steadyMs` and then nothing: no flapping. A steady sound below the absolute minimum gives nothing.
 * - `hangoverMs` must not exceed `TURN_TIMING.earlySendMs`. The relay reads `silenceMs` to send early,
 *   and `silenceMs` is 0 until `speech_end` has fired.
 */
import { VOICE_BYTES_PER_SAMPLE, VOICE_SAMPLE_RATE } from "@agentforge/core/voice";

export type VadEvent =
  | { readonly type: "speech_start"; readonly atMs: number }
  | { readonly type: "speech_end"; readonly atMs: number; readonly speechMs: number };

export type VadOptions = {
  /**
   * The absolute minimum RMS level (0..1) for a window to count as speech. In a quiet room this is the bar;
   * in a noisy one the learned noise floor lifts the bar above it.
   */
  readonly threshold: number;
  /** Speech this long starts an utterance. */
  readonly minSpeechMs: number;
  /** Silence this long ends it. `speech_end.atMs` is the time of the last speech frame. */
  readonly hangoverMs: number;
  /** Speech must be this many times the noise floor to start (default 3). */
  readonly noiseRatio?: number;
  /** Once speaking, a window carries on while it is above this share of the start bar (default 0.5). */
  readonly releaseRatio?: number;
  /** About how long a rise in the room's level takes to be learned, in ms (default 1000). */
  readonly floorRiseMs?: number;
  /** A steady sound this long is the room, not speech, in ms (default 1500; 0 turns the rule off). */
  readonly steadyMs?: number;
};

export type Vad = {
  /** Feed PCM in any chunk size. Returns the events this chunk caused, in order. */
  push(pcm: Buffer): VadEvent[];
  readonly speaking: boolean;
  /** Milliseconds of audio since the last speech frame, 0 while speaking. */
  readonly silenceMs: number;
  /**
   * Where the last speech window ended, in ms of audio fed: 0 before any. While speaking it is within one window of
   * `nowMs`, and it stays put through the hangover, so `lastSpeechMs - speech_start.atMs` is the speech so far, not
   * the speech plus the quiet the detector is still waiting out.
   */
  readonly lastSpeechMs: number;
  /** Milliseconds of audio fed so far. */
  readonly nowMs: number;
  reset(): void;
};

const RESOLVED_DEFAULTS = {
  threshold: 0.01,
  minSpeechMs: 120,
  hangoverMs: 300,
  noiseRatio: 3,
  releaseRatio: 0.5,
  floorRiseMs: 1_000,
  steadyMs: 1_500,
} satisfies Required<VadOptions>;

export const VAD_DEFAULTS: VadOptions = RESOLVED_DEFAULTS;

/** One analysis window. */
const WINDOW_MS = 10;
const WINDOW_SAMPLES = (VOICE_SAMPLE_RATE * WINDOW_MS) / 1000;
const WINDOW_BYTES = WINDOW_SAMPLES * VOICE_BYTES_PER_SAMPLE;
const SAMPLES_PER_MS = VOICE_SAMPLE_RATE / 1000;

/** Quiet gap inside a run of loud windows that does not break the run. */
const PENDING_BRIDGE_MS = 40;
/** How much of the gap to a lower window the floor closes per window: it falls fast. */
const FLOOR_FALL = 0.25;
/** The slow rise of the floor stops here. A steady sound can still set it higher. */
const MAX_FLOOR = 0.03;
/** A level that stays within this ratio (max over min) for `steadyMs` is steady. */
const STEADY_RATIO = 1.8;
/** How far before the first loud window the start of an utterance may be moved back, in windows. */
const BACKDATE_WINDOWS = 30;
/** A quiet gap this long (a stop consonant's closure) does not stop that move back, in windows. */
const BACKDATE_BRIDGE_WINDOWS = 8;
/** The first windows of a stream are taken as the room: the floor starts at their minimum. */
const CALIBRATION_WINDOWS = 5;

export function createVad(options: Partial<VadOptions> = {}): Vad {
  const threshold = options.threshold ?? RESOLVED_DEFAULTS.threshold;
  const minSpeechMs = options.minSpeechMs ?? RESOLVED_DEFAULTS.minSpeechMs;
  const hangoverMs = options.hangoverMs ?? RESOLVED_DEFAULTS.hangoverMs;
  const noiseRatio = options.noiseRatio ?? RESOLVED_DEFAULTS.noiseRatio;
  const releaseRatio = options.releaseRatio ?? RESOLVED_DEFAULTS.releaseRatio;
  const floorRise = WINDOW_MS / Math.max(WINDOW_MS, options.floorRiseMs ?? RESOLVED_DEFAULTS.floorRiseMs);
  const steadyWindows = Math.round((options.steadyMs ?? RESOLVED_DEFAULTS.steadyMs) / WINDOW_MS);

  /** The window being filled when a chunk ends mid-window. */
  const partial = Buffer.alloc(WINDOW_BYTES);
  let partialLength = 0;
  let totalBytes = 0;
  let windows = 0;
  let speaking = false;
  /** End time of the last window that counted as speech; 0 before any. */
  let lastSpeechEndMs = 0;
  /** Start of the utterance in progress. */
  let utteranceStartMs = 0;
  /** The run of loud windows that has not yet become an utterance. */
  let pendingStartMs = 0;
  let pendingLoudMs = 0;
  let pendingGapMs = 0;
  /** The learned level of the room. */
  let floor = 0;
  let floorSeeded = false;
  /** The most recent window levels: the steady-sound rule and the move back of a start read them. */
  const ring = new Float64Array(Math.max(1, steadyWindows, BACKDATE_WINDOWS + 1));
  let ringPos = 0;
  let ringFill = 0;

  function reset(): void {
    partialLength = 0;
    totalBytes = 0;
    windows = 0;
    speaking = false;
    lastSpeechEndMs = 0;
    utteranceStartMs = 0;
    pendingStartMs = 0;
    pendingLoudMs = 0;
    pendingGapMs = 0;
    floor = 0;
    floorSeeded = false;
    ring.fill(0);
    ringPos = 0;
    ringFill = 0;
  }

  function learnFloor(level: number): void {
    if (!floorSeeded) {
      floor = level;
      floorSeeded = true;
    } else if (level < floor) {
      floor += (level - floor) * FLOOR_FALL;
    } else if (floor < MAX_FLOOR) {
      floor = Math.min(MAX_FLOOR, floor + (level - floor) * floorRise);
    }
  }

  /** The level of the window `ago` windows before the one just stored (0 is that one). */
  function levelAgo(ago: number): number {
    return ring[(ringPos - 1 - ago + ring.length * 2) % ring.length] ?? 0;
  }

  /**
   * Where an utterance that was confirmed on this window really began: the run of windows just before the
   * first loud one that were still above the carry-on bar (a soft "s" or "t" that never reached the start bar).
   */
  function backdate(firstLoudMs: number, holdBar: number): number {
    let ago = windows - firstLoudMs / WINDOW_MS;
    let gap = 0;
    let moved = 0;
    let best = 0;
    while (moved < BACKDATE_WINDOWS && ago < ringFill) {
      if (levelAgo(ago) > holdBar) {
        gap = 0;
        best = moved + 1;
      } else {
        gap += 1;
        if (gap > BACKDATE_BRIDGE_WINDOWS) {
          break;
        }
      }
      ago += 1;
      moved += 1;
    }
    return firstLoudMs - best * WINDOW_MS;
  }

  /** True, with the level and the start of the run, when the last `steadyMs` of windows is one steady sound. */
  function steadySound(): { level: number; sinceMs: number } | null {
    if (steadyWindows <= 0 || ringFill < steadyWindows) {
      return null;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let sum = 0;
    for (let ago = 0; ago < steadyWindows; ago += 1) {
      const level = levelAgo(ago);
      min = Math.min(min, level);
      max = Math.max(max, level);
      sum += level;
    }
    if (!(min > 0) || max > min * STEADY_RATIO) {
      return null;
    }
    return { level: sum / steadyWindows, sinceMs: windows * WINDOW_MS - steadyWindows * WINDOW_MS };
  }

  function onWindow(level: number, events: VadEvent[]): void {
    const startMs = windows * WINDOW_MS;
    const endMs = startMs + WINDOW_MS;
    windows += 1;
    ring[ringPos] = level;
    ringPos = (ringPos + 1) % ring.length;
    ringFill = Math.min(ring.length, ringFill + 1);

    if (windows <= CALIBRATION_WINDOWS) {
      floor = Math.min(MAX_FLOOR, windows === 1 ? level : Math.min(floor, level));
      floorSeeded = true;
      return;
    }

    const startBar = Math.max(threshold, floor * noiseRatio);
    if (speaking) {
      if (level > startBar * releaseRatio) {
        lastSpeechEndMs = endMs;
      } else if (endMs - lastSpeechEndMs >= hangoverMs) {
        speaking = false;
        events.push({ type: "speech_end", atMs: lastSpeechEndMs, speechMs: lastSpeechEndMs - utteranceStartMs });
      }
    } else if (level > startBar) {
      if (pendingLoudMs === 0) {
        pendingStartMs = startMs;
      }
      pendingLoudMs += WINDOW_MS;
      pendingGapMs = 0;
      if (pendingLoudMs >= minSpeechMs) {
        speaking = true;
        pendingLoudMs = 0;
        utteranceStartMs = Math.max(lastSpeechEndMs, backdate(pendingStartMs, startBar * releaseRatio));
        lastSpeechEndMs = endMs;
        events.push({ type: "speech_start", atMs: utteranceStartMs });
      }
    } else if (pendingLoudMs > 0) {
      pendingGapMs += WINDOW_MS;
      if (pendingGapMs > PENDING_BRIDGE_MS) {
        // A run shorter than `minSpeechMs` that silence interrupts is a click, not a start.
        pendingLoudMs = 0;
        pendingGapMs = 0;
      }
    } else {
      learnFloor(level);
    }

    if (speaking || pendingLoudMs > 0) {
      const steady = steadySound();
      if (steady) {
        floor = steady.level;
        floorSeeded = true;
        pendingLoudMs = 0;
        pendingGapMs = 0;
        if (speaking) {
          speaking = false;
          const atMs = Math.max(utteranceStartMs, steady.sinceMs);
          lastSpeechEndMs = atMs;
          events.push({ type: "speech_end", atMs, speechMs: atMs - utteranceStartMs });
        }
      }
    }
  }

  function push(pcm: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    const usable = pcm.length;
    totalBytes += usable;
    let offset = 0;
    // First top up a window left half full by the previous chunk.
    if (partialLength > 0) {
      const take = Math.min(WINDOW_BYTES - partialLength, usable);
      pcm.copy(partial, partialLength, 0, take);
      partialLength += take;
      offset = take;
      if (partialLength < WINDOW_BYTES) {
        return events;
      }
      onWindow(windowLevel(partial, 0), events);
      partialLength = 0;
    }
    // Whole windows are read straight from the caller's buffer.
    while (usable - offset >= WINDOW_BYTES) {
      onWindow(windowLevel(pcm, offset), events);
      offset += WINDOW_BYTES;
    }
    if (offset < usable) {
      // The rest is copied, so the caller's buffer is never held.
      pcm.copy(partial, 0, offset, usable);
      partialLength = usable - offset;
    }
    return events;
  }

  function nowMs(): number {
    // Whole samples only: an odd trailing byte is half a sample and does not count yet.
    return Math.floor(Math.floor(totalBytes / VOICE_BYTES_PER_SAMPLE) / SAMPLES_PER_MS);
  }

  return {
    push,
    get speaking() {
      return speaking;
    },
    get silenceMs() {
      return speaking ? 0 : Math.max(0, nowMs() - lastSpeechEndMs);
    },
    get lastSpeechMs() {
      return lastSpeechEndMs;
    },
    get nowMs() {
      return nowMs();
    },
    reset,
  };
}

/** The level of one window of 16-bit little-endian samples: RMS with the mean removed, scaled to 0..1. */
function windowLevel(buffer: Buffer, offset: number): number {
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i += 1) {
    const sample = buffer.readInt16LE(offset + i * VOICE_BYTES_PER_SAMPLE) / 32768;
    sum += sample;
    sumSquares += sample * sample;
  }
  const mean = sum / WINDOW_SAMPLES;
  const variance = sumSquares / WINDOW_SAMPLES - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}
