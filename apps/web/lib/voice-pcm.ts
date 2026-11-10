/**
 * Live voice: the PCM the wire carries, and the three small tools that make it (docs/internal/maps/voice-mode.md).
 *
 * The wire is 16-bit little-endian PCM, mono, 24 kHz, in frames of exactly `VOICE_FRAME_MS` (40 ms,
 * 1,920 bytes) from the browser. A microphone does not run at 24 kHz and gives floats, so this file
 * holds the float to int16 step, the resampler and the framer. No React, no DOM type, no state but each
 * class's own, so the same code runs in the capture worklet and under the node test setup.
 */

import { VOICE_BYTES_PER_SAMPLE, VOICE_FRAME_MS, VOICE_SAMPLE_RATE } from "@agentforge/core/voice";

/** Samples in one browser frame: 24,000 x 40 / 1000. */
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
/** Bytes in one browser frame, the size the host expects: 1,920. */
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * VOICE_BYTES_PER_SAMPLE;

/**
 * Float samples (nominally -1 to 1) to int16. Anything past full scale is clipped, not wrapped, and a
 * NaN becomes silence. Negative full scale is -32768 and positive is 32767, as a recorder writes them.
 */
export function floatToInt16(input: ArrayLike<number>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] as number;
    if (Number.isNaN(sample)) {
      out[i] = 0;
    } else if (sample >= 1) {
      out[i] = 32767;
    } else if (sample <= -1) {
      out[i] = -32768;
    } else {
      out[i] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
    }
  }
  return out;
}

/** Int16 samples to floats in [-1, 1). The inverse of `floatToInt16`, up to rounding. */
export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = (input[i] as number) / 32768;
  }
  return out;
}

/** The little-endian bytes of some samples, on any platform. */
export function int16ToBytes(samples: Int16Array): ArrayBuffer {
  const out = new ArrayBuffer(samples.length * VOICE_BYTES_PER_SAMPLE);
  const view = new DataView(out);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * VOICE_BYTES_PER_SAMPLE, samples[i] as number, true);
  }
  return out;
}

/**
 * Little-endian bytes to samples. A trailing odd byte is dropped: the host sends whole samples, and
 * half of one is not audio.
 */
export function bytesToInt16(bytes: ArrayBuffer): Int16Array {
  const count = Math.floor(bytes.byteLength / VOICE_BYTES_PER_SAMPLE);
  const out = new Int16Array(count);
  const view = new DataView(bytes);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * VOICE_BYTES_PER_SAMPLE, true);
  }
  return out;
}

/** The root mean square of some float samples, 0 for none. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] as number;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Streaming sample-rate conversion by area averaging: each output sample is the mean of the input
 * across its own slice of time, with the edge samples weighted by how much of them falls inside. That
 * is a box filter, so it also takes the energy above the new Nyquist out before it can fold back into
 * the speech band, and it works for any ratio (48,000 to 24,000 is two inputs per output, 44,100 to
 * 24,000 is 1.8375). State carries across calls, so chunks of any size give the same samples as one
 * long call. Going up (an input slower than the output) holds each sample; capture never does.
 */
export class Resampler {
  /** Input samples per output sample. */
  private readonly ratio: number;
  /** How much of the current output sample has been filled, in input samples. */
  private phase = 0;
  private sum = 0;

  constructor(
    readonly inRate: number,
    readonly outRate: number = VOICE_SAMPLE_RATE,
  ) {
    if (!(inRate > 0) || !(outRate > 0)) {
      throw new RangeError("sample rates must be positive");
    }
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) {
      return input.slice();
    }
    const out = new Float32Array(Math.ceil((input.length + this.phase) / this.ratio) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i] as number;
      let left = 1;
      while (left > 1e-9) {
        const room = this.ratio - this.phase;
        if (left < room - 1e-9) {
          this.sum += sample * left;
          this.phase += left;
          left = 0;
        } else {
          this.sum += sample * room;
          out[written] = this.sum / this.ratio;
          written += 1;
          left -= room;
          this.sum = 0;
          this.phase = 0;
        }
      }
    }
    return out.slice(0, written);
  }

  reset(): void {
    this.phase = 0;
    this.sum = 0;
  }
}

/**
 * Cuts a run of int16 samples into frames of exactly `VOICE_FRAME_SAMPLES` and carries the remainder
 * to the next call. Every frame it returns is `VOICE_FRAME_BYTES` long and little-endian.
 */
export class PcmFramer {
  private readonly held = new Int16Array(VOICE_FRAME_SAMPLES);
  private fill = 0;

  /** Samples waiting for the rest of their frame. */
  get pending(): number {
    return this.fill;
  }

  push(samples: Int16Array): ArrayBuffer[] {
    const frames: ArrayBuffer[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(VOICE_FRAME_SAMPLES - this.fill, samples.length - offset);
      this.held.set(samples.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === VOICE_FRAME_SAMPLES) {
        frames.push(int16ToBytes(this.held));
        this.fill = 0;
      }
    }
    return frames;
  }

  /** The remainder, padded with silence to a whole frame, or null when nothing is waiting. */
  flush(): ArrayBuffer | null {
    if (this.fill === 0) {
      return null;
    }
    this.held.fill(0, this.fill);
    const frame = int16ToBytes(this.held);
    this.fill = 0;
    return frame;
  }

  reset(): void {
    this.fill = 0;
  }
}
