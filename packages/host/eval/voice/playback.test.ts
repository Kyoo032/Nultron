import { describe, expect, it } from "vitest";
import { BYTES_PER_MS } from "./audio";
import { createPlayback } from "./playback";

const bytes = (ms: number): number => ms * BYTES_PER_MS;

describe("what the person has heard", () => {
  it("plays received audio at real time, from the first chunk", () => {
    const playback = createPlayback();
    playback.onAudio(bytes(1_000), 100);
    expect(playback.playedMs(100)).toBe(0);
    expect(playback.playedMs(400)).toBe(300);
    expect(playback.bufferedMs(400)).toBe(700);
    expect(playback.receivedMs).toBe(1_000);
  });

  it("stops counting when the queue runs dry", () => {
    const playback = createPlayback();
    playback.onAudio(bytes(500), 0);
    expect(playback.playedMs(5_000)).toBe(500);
    expect(playback.bufferedMs(5_000)).toBe(0);
  });

  it("holds audio that arrives faster than real time and plays it out in order", () => {
    const playback = createPlayback();
    playback.onAudio(bytes(2_000), 0);
    playback.onAudio(bytes(2_000), 100);
    expect(playback.playedMs(1_000)).toBe(1_000);
    expect(playback.bufferedMs(1_000)).toBe(3_000);
  });

  it("freezes on a pause and carries on after a resume", () => {
    const playback = createPlayback();
    playback.onAudio(bytes(4_000), 0);
    playback.pause(600);
    expect(playback.paused).toBe(true);
    expect(playback.playedMs(2_000)).toBe(600);
    playback.resume(2_000);
    expect(playback.playedMs(2_500)).toBe(1_100);
  });

  it("drops the queue on stop, reports what was heard, and starts the next reply from zero", () => {
    const playback = createPlayback();
    playback.onAudio(bytes(4_000), 0);
    playback.pause(500);
    expect(playback.stop(1_200)).toBe(500);
    expect(playback.bufferedMs(1_200)).toBe(0);
    expect(playback.playedMs(1_200)).toBe(0);
    expect(playback.paused).toBe(false);
    playback.onAudio(bytes(1_000), 2_000);
    expect(playback.playedMs(2_300)).toBe(300);
  });

  it("is a pure function of the times it is given", () => {
    const a = createPlayback();
    const b = createPlayback();
    for (const playback of [a, b]) {
      playback.onAudio(bytes(900), 10);
      playback.pause(310);
      playback.resume(410);
    }
    expect(a.playedMs(1_000)).toBe(b.playedMs(1_000));
    expect(a.playedMs(1_000)).toBe(890);
  });
});
