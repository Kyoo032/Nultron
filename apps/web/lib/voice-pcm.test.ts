import { describe, expect, it } from "vitest";
import {
  bytesToInt16,
  floatToInt16,
  int16ToBytes,
  int16ToFloat,
  PcmFramer,
  Resampler,
  rms,
  VOICE_FRAME_BYTES,
  VOICE_FRAME_SAMPLES,
} from "./voice-pcm";

function sine(count: number, rate: number, hz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

function zeroCrossings(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] as number) < 0 !== (samples[i] as number) < 0) {
      crossings += 1;
    }
  }
  return crossings;
}

describe("the frame size", () => {
  it("is 40 ms of 24 kHz int16: 960 samples, 1,920 bytes", () => {
    expect(VOICE_FRAME_SAMPLES).toBe(960);
    expect(VOICE_FRAME_BYTES).toBe(1920);
  });
});

describe("float to int16", () => {
  it("maps silence and both full-scale ends", () => {
    expect(Array.from(floatToInt16([0, 1, -1]))).toEqual([0, 32767, -32768]);
  });

  it("rounds a half-scale sample to the nearest step", () => {
    expect(Array.from(floatToInt16([0.5, -0.5]))).toEqual([16384, -16384]);
  });

  it("clips what is past full scale instead of wrapping it around", () => {
    expect(Array.from(floatToInt16([1.5, -3, 100, Infinity, -Infinity]))).toEqual([
      32767, -32768, 32767, 32767, -32768,
    ]);
  });

  it("turns NaN into silence", () => {
    expect(Array.from(floatToInt16([Number.NaN, 0.25]))).toEqual([0, 8192]);
  });

  it("comes back within one step through int16 to float", () => {
    const original = [0, 0.1, -0.1, 0.9, -0.9];
    const back = int16ToFloat(floatToInt16(original));
    original.forEach((value, i) => {
      expect(Math.abs((back[i] as number) - value)).toBeLessThan(1 / 16384);
    });
  });
});

describe("little-endian bytes", () => {
  it("writes the low byte first", () => {
    expect(Array.from(new Uint8Array(int16ToBytes(Int16Array.of(0x0102, -2))))).toEqual([0x02, 0x01, 0xfe, 0xff]);
  });

  it("reads them back, and drops a trailing odd byte", () => {
    const bytes = new Uint8Array([0x02, 0x01, 0xfe, 0xff, 0x7f]).buffer;
    expect(Array.from(bytesToInt16(bytes))).toEqual([0x0102, -2]);
  });
});

describe("rms", () => {
  it("is 0 for nothing and for silence, and 1 for full-scale DC", () => {
    expect(rms([])).toBe(0);
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(new Float32Array(10).fill(1))).toBe(1);
  });

  it("is the amplitude over root two for a sine", () => {
    expect(rms(sine(4800, 48_000, 1000, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });
});

describe("the resampler", () => {
  it("returns the same samples when the rates already match", () => {
    const input = Float32Array.of(0.1, -0.2, 0.3);
    const out = new Resampler(24_000).process(input);
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(out).not.toBe(input);
  });

  it("takes 48 kHz to 24 kHz: half the samples, the level held", () => {
    const out = new Resampler(48_000).process(new Float32Array(4800).fill(0.5));
    expect(out.length).toBe(2400);
    expect(Math.max(...Array.from(out))).toBeCloseTo(0.5, 6);
    expect(Math.min(...Array.from(out))).toBeCloseTo(0.5, 6);
  });

  it("takes 44.1 kHz to 24 kHz: the right count for a ratio that is not a whole number", () => {
    const out = new Resampler(44_100).process(new Float32Array(44_100).fill(0.25));
    expect(Math.abs(out.length - 24_000)).toBeLessThanOrEqual(1);
    for (const sample of Array.from(out)) {
      expect(sample).toBeCloseTo(0.25, 5);
    }
  });

  it.each([48_000, 44_100])("keeps a 1 kHz tone at 1 kHz and about the same height from %i Hz", (rate) => {
    const out = new Resampler(rate).process(sine(rate / 2, rate, 1000));
    // 0.5 s of 1 kHz: 500 cycles, 1,000 zero crossings.
    expect(Math.abs(zeroCrossings(out) - 1000)).toBeLessThanOrEqual(2);
    const peak = Math.max(...Array.from(out.slice(100)));
    expect(peak).toBeGreaterThan(0.48);
    expect(peak).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("gives the same samples in render-quantum chunks as in one call", () => {
    const input = sine(44_100, 44_100, 440);
    const whole = new Resampler(44_100).process(input);
    const chunked = new Resampler(44_100);
    const parts: Float32Array[] = [];
    for (let at = 0; at < input.length; at += 128) {
      parts.push(chunked.process(input.subarray(at, at + 128)));
    }
    const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 1) {
      expect(joined[i]).toBeCloseTo(whole[i] as number, 5);
    }
  });

  it("refuses a rate that is not a positive number", () => {
    expect(() => new Resampler(0)).toThrow(RangeError);
  });
});

describe("the framer", () => {
  function frameSamples(frame: ArrayBuffer): Int16Array {
    return bytesToInt16(frame);
  }

  it("returns nothing until a whole 40 ms has arrived", () => {
    const framer = new PcmFramer();
    expect(framer.push(new Int16Array(959))).toEqual([]);
    expect(framer.pending).toBe(959);
  });

  it("returns frames of exactly 1,920 bytes and carries the remainder over", () => {
    const framer = new PcmFramer();
    const ramp = Int16Array.from({ length: 1000 }, (_, i) => i);
    const first = framer.push(ramp);
    expect(first).toHaveLength(1);
    expect(first[0]?.byteLength).toBe(1920);
    expect(framer.pending).toBe(40);

    const second = framer.push(Int16Array.from({ length: 920 }, (_, i) => 1000 + i));
    expect(second).toHaveLength(1);
    expect(second[0]?.byteLength).toBe(1920);
    expect(framer.pending).toBe(0);
    // The remainder came first in the second frame: the stream is unbroken across the call boundary.
    const joined = frameSamples(second[0] as ArrayBuffer);
    expect(joined[0]).toBe(960);
    expect(joined[959]).toBe(1919);
  });

  it("cuts one long run into as many whole frames as it holds", () => {
    const framer = new PcmFramer();
    const frames = framer.push(new Int16Array(960 * 3 + 5));
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.byteLength === 1920)).toBe(true);
    expect(framer.pending).toBe(5);
  });

  it("gives the same frames from many small pushes as from one", () => {
    const run = Int16Array.from({ length: 2000 }, (_, i) => (i * 7) % 3000);
    const whole = new PcmFramer().push(run);
    const small = new PcmFramer();
    const pieces: ArrayBuffer[] = [];
    for (let at = 0; at < run.length; at += 100) {
      pieces.push(...small.push(run.subarray(at, at + 100)));
    }
    expect(pieces).toHaveLength(whole.length);
    pieces.forEach((frame, i) => {
      expect(Array.from(new Uint8Array(frame))).toEqual(Array.from(new Uint8Array(whole[i] as ArrayBuffer)));
    });
    expect(small.pending).toBe(80);
  });

  it("flushes what is left, padded with silence to a whole frame", () => {
    const framer = new PcmFramer();
    framer.push(Int16Array.of(5, 6, 7));
    const frame = framer.flush();
    expect(frame?.byteLength).toBe(1920);
    const samples = frameSamples(frame as ArrayBuffer);
    expect(Array.from(samples.slice(0, 4))).toEqual([5, 6, 7, 0]);
    expect(samples[959]).toBe(0);
    expect(framer.pending).toBe(0);
    expect(framer.flush()).toBeNull();
  });
});
