import { describe, expect, it } from "vitest";
import { CaptureCore, VOICE_LEVEL_WINDOW_MS } from "./voice-capture-core";
import { bytesToInt16 } from "./voice-pcm";

const QUANTUM = 128;

/** One second of a 440 Hz sine at `rate`, fed to the core in render-quantum chunks. */
function feedOneSecond(rate: number, amplitude = 0.5) {
  const core = new CaptureCore(rate);
  const frames: ArrayBuffer[] = [];
  const levels: number[] = [];
  const total = rate;
  for (let at = 0; at < total; at += QUANTUM) {
    const chunk = new Float32Array(Math.min(QUANTUM, total - at));
    for (let i = 0; i < chunk.length; i += 1) {
      chunk[i] = amplitude * Math.sin((2 * Math.PI * 440 * (at + i)) / rate);
    }
    const out = core.process(chunk);
    frames.push(...out.frames);
    levels.push(...out.levels);
  }
  return { core, frames, levels };
}

describe("the capture core", () => {
  it("makes 25 frames and 50 loudness windows from one second at 48 kHz", () => {
    const { frames, levels } = feedOneSecond(48_000);
    expect(frames).toHaveLength(25);
    expect(frames.every((frame) => frame.byteLength === 1920)).toBe(true);
    expect(levels).toHaveLength(50);
    expect(VOICE_LEVEL_WINDOW_MS).toBe(20);
  });

  it("measures the level of the signal, not of the int16 steps", () => {
    const { levels } = feedOneSecond(48_000, 0.5);
    for (const level of levels.slice(2)) {
      expect(level).toBeCloseTo(0.5 / Math.SQRT2, 1);
    }
  });

  it("still frames exactly when the context runs at 44.1 kHz", () => {
    const { frames, core } = feedOneSecond(44_100);
    expect(frames.length).toBeGreaterThanOrEqual(24);
    expect(frames.length).toBeLessThanOrEqual(25);
    expect(frames.every((frame) => frame.byteLength === 1920)).toBe(true);
    // Whatever is left is under a frame, and flush pads it to a whole one.
    const rest = core.flush();
    expect(rest === null || rest.byteLength === 1920).toBe(true);
  });

  it("works at 24 kHz without converting anything", () => {
    const { frames } = feedOneSecond(24_000);
    expect(frames).toHaveLength(25);
    const first = bytesToInt16(frames[0] as ArrayBuffer);
    expect(first[0]).toBe(0);
    // 440 Hz at 24 kHz: sample 1 is 0.5 x sin(2 pi 440 / 24000), in int16.
    expect(first[1]).toBe(Math.round(0.5 * Math.sin((2 * Math.PI * 440) / 24_000) * 32767));
  });

  it("clips a signal that is too loud, so the level may pass 1 but the samples never wrap", () => {
    const core = new CaptureCore(24_000);
    const out = core.process(new Float32Array(960).fill(3));
    const samples = bytesToInt16(out.frames[0] as ArrayBuffer);
    expect(Math.min(...Array.from(samples))).toBe(32767);
    expect(Math.max(...Array.from(samples))).toBe(32767);
  });

  it("flushes a partial frame padded to a whole one, then has nothing left", () => {
    const core = new CaptureCore(24_000);
    core.process(new Float32Array(100).fill(0.1));
    expect(core.flush()?.byteLength).toBe(1920);
    expect(core.flush()).toBeNull();
  });

  it("forgets what it held on reset", () => {
    const core = new CaptureCore(24_000);
    core.process(new Float32Array(100).fill(0.1));
    core.reset();
    expect(core.flush()).toBeNull();
  });
});
