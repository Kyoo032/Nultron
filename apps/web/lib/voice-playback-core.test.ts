import { describe, expect, it } from "vitest";
import { PlaybackQueue } from "./voice-playback-core";

const QUANTUM = 128;

/** `count` samples of an increasing ramp, so order is checkable. */
function ramp(count: number, from = 1): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => (from + i) / 1_000_000);
}

/** Renders until the queue stops giving audio or `limit` quanta have run; returns the audio that came out. */
function drain(queue: PlaybackQueue, limit = 10_000): number[] {
  const heard: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    const out = new Float32Array(QUANTUM);
    const produced = queue.render(out);
    heard.push(...Array.from(out.slice(0, produced)));
    if (produced === 0) {
      break;
    }
  }
  return heard;
}

describe("the playback clock", () => {
  it("counts the milliseconds of audio that reached the output", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(2400));
    expect(queue.playedMs).toBe(0);
    expect(queue.queuedMs).toBe(100);
    drain(queue);
    expect(queue.playedMs).toBeCloseTo(100, 6);
    expect(queue.queuedSamples).toBe(0);
    expect(queue.playing).toBe(false);
  });

  it("plays what arrived in the order it arrived, across chunks, with no gap", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(300, 1));
    queue.enqueue(ramp(300, 301));
    queue.enqueue(ramp(300, 601));
    const heard = drain(queue);
    expect(heard).toHaveLength(900);
    heard.forEach((sample, i) => {
      expect(sample).toBeCloseTo((i + 1) / 1_000_000, 9);
    });
  });

  it("keeps order when the buffer has to grow and wrap", () => {
    const queue = new PlaybackQueue();
    // Past the starting capacity, with part of it already played so the ring has wrapped.
    queue.enqueue(ramp(90_000, 1));
    const first = new Float32Array(50_000);
    queue.render(first);
    queue.enqueue(ramp(60_000, 90_001));
    const rest = drain(queue, 100_000);
    expect(rest).toHaveLength(100_000);
    expect(rest[0]).toBeCloseTo(50_001 / 1_000_000, 7);
    expect(rest[99_999]).toBeCloseTo(150_000 / 1_000_000, 7);
    expect(queue.playedMs).toBeCloseTo((150_000 / 24_000) * 1000, 3);
  });

  it("holds the audio and the count while paused, and carries on from the same sample on resume", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(2400));
    queue.render(new Float32Array(480));
    expect(queue.playedMs).toBeCloseTo(20, 6);

    queue.pause();
    expect(queue.playing).toBe(false);
    const silent = new Float32Array(QUANTUM).fill(1);
    expect(queue.render(silent)).toBe(0);
    expect(Array.from(silent).every((sample) => sample === 0)).toBe(true);
    expect(queue.playedMs).toBeCloseTo(20, 6);
    expect(queue.queuedSamples).toBe(1920);

    queue.resume();
    expect(queue.playing).toBe(true);
    const next = new Float32Array(1);
    queue.render(next);
    expect(next[0]).toBeCloseTo(481 / 1_000_000, 9);
    drain(queue);
    expect(queue.playedMs).toBeCloseTo(100, 6);
  });

  it("drops everything queued at once, and what was played stays counted", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(2400));
    queue.render(new Float32Array(480));
    expect(queue.drop()).toBe(1920);
    expect(queue.queuedSamples).toBe(0);
    expect(queue.playing).toBe(false);
    expect(queue.playedMs).toBeCloseTo(20, 6);
    expect(queue.render(new Float32Array(QUANTUM))).toBe(0);
    // Audio that arrives after a drop plays from its own start.
    queue.enqueue(ramp(10, 7000));
    const out = new Float32Array(1);
    queue.render(out);
    expect(out[0]).toBeCloseTo(7000 / 1_000_000, 9);
  });

  it("does not count silence: an underrun plays what it has and the clock stops there", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(100));
    const out = new Float32Array(QUANTUM).fill(1);
    expect(queue.render(out)).toBe(100);
    expect(out[99]).toBeGreaterThan(0);
    expect(out[100]).toBe(0);
    expect(queue.playedMs).toBeCloseTo((100 / 24_000) * 1000, 6);
    // Many quanta of nothing leave the count where it was.
    for (let i = 0; i < 20; i += 1) {
      queue.render(new Float32Array(QUANTUM));
    }
    expect(queue.playedMs).toBeCloseTo((100 / 24_000) * 1000, 6);
  });

  it("counts the whole agent turn across a gap: an acknowledgement, a pause, then the answer", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(4800)); // 200 ms acknowledgement
    drain(queue);
    for (let i = 0; i < 50; i += 1) {
      queue.render(new Float32Array(QUANTUM)); // the agent is thinking: silence
    }
    queue.enqueue(ramp(7200)); // 300 ms answer
    drain(queue);
    expect(queue.playedMs).toBeCloseTo(500, 6);
  });

  it("starts the count again at the next turn when `listening` arrives with nothing queued", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(2400));
    drain(queue);
    expect(queue.playedMs).toBeCloseTo(100, 6);
    queue.endTurn();
    expect(queue.playedMs).toBe(0);
  });

  it("keeps counting the tail still queued when `listening` arrives, and restarts once it has played", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(4800)); // the host has sent 200 ms
    queue.render(new Float32Array(1200)); // 50 ms of it has played
    queue.endTurn();
    // A person who cuts in now has heard 50 ms of this turn, not 0.
    expect(queue.playedMs).toBeCloseTo(50, 6);
    drain(queue);
    // The tail played out, and the next turn counts from zero.
    expect(queue.playedMs).toBe(0);
    queue.enqueue(ramp(480));
    drain(queue);
    expect(queue.playedMs).toBeCloseTo(20, 6);
  });

  it("restarts when the next turn's audio arrives after a tail was dropped", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(4800));
    queue.render(new Float32Array(1200));
    queue.endTurn();
    queue.drop();
    // Still readable right after the drop, which is when `played` is reported.
    expect(queue.playedMs).toBeCloseTo(50, 6);
    queue.enqueue(ramp(240));
    expect(queue.playedMs).toBe(0);
  });

  it("clears everything for a new session", () => {
    const queue = new PlaybackQueue();
    queue.enqueue(ramp(2400));
    queue.render(new Float32Array(480));
    queue.pause();
    queue.clear();
    expect(queue.playedMs).toBe(0);
    expect(queue.queuedSamples).toBe(0);
    expect(queue.paused).toBe(false);
  });

  describe("on an output that does not run at 24 kHz", () => {
    it("plays a second of audio as 48,000 output samples and counts a second heard", () => {
      const queue = new PlaybackQueue(48_000);
      queue.enqueue(ramp(24_000));
      const heard = drain(queue, 1000);
      expect(heard.length).toBe(48_000);
      expect(queue.playedMs).toBeCloseTo(1000, 1);
    });

    it("fills between samples by interpolating, so a ramp stays a ramp", () => {
      const queue = new PlaybackQueue(48_000);
      queue.enqueue(ramp(100));
      const heard = drain(queue);
      for (let i = 1; i < heard.length - 2; i += 1) {
        expect(heard[i] as number).toBeGreaterThanOrEqual(heard[i - 1] as number);
      }
    });

    it("counts only what was played when paused partway", () => {
      const queue = new PlaybackQueue(48_000);
      queue.enqueue(ramp(24_000));
      queue.render(new Float32Array(4800)); // 100 ms of output, 100 ms of audio
      queue.pause();
      expect(queue.playedMs).toBeCloseTo(100, 1);
    });
  });

  it("refuses an output rate that is not a positive number", () => {
    expect(() => new PlaybackQueue(0)).toThrow(RangeError);
  });
});
