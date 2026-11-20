import { describe, expect, it } from "vitest";
import { BARGE_SUSTAIN_MS, BargeDetector } from "./voice-barge-detector";

const WINDOW_MS = 20;

/** Feeds `count` windows of one level and returns the window numbers (0-based, from this call) that fired. */
function feed(detector: BargeDetector, level: number, count: number): number[] {
  const fired: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (detector.push(level, WINDOW_MS)) {
      fired.push(i);
    }
  }
  return fired;
}

/** A quiet room, long enough for the floor to be learned. */
function quietRoom(level = 0.002): BargeDetector {
  const detector = new BargeDetector();
  feed(detector, level, 40);
  return detector;
}

describe("cutting in, the local guess", () => {
  it("sustains for 120 ms", () => {
    expect(BARGE_SUSTAIN_MS).toBe(120);
  });

  it("fires once when speech rises over the room's floor and stays", () => {
    const detector = quietRoom();
    const fired = feed(detector, 0.1, 10);
    // Six windows of 20 ms is the first moment 120 ms has been sustained.
    expect(fired).toEqual([5]);
    expect(detector.speaking).toBe(true);
  });

  it("does not fire again while the same speech goes on", () => {
    const detector = quietRoom();
    expect(feed(detector, 0.1, 10)).toHaveLength(1);
    expect(feed(detector, 0.12, 100)).toEqual([]);
  });

  it("fires again for the next burst, once the first has been quiet long enough to end", () => {
    const detector = quietRoom();
    expect(feed(detector, 0.1, 10)).toHaveLength(1);
    feed(detector, 0.002, 20); // 400 ms of quiet
    expect(detector.speaking).toBe(false);
    expect(feed(detector, 0.1, 10)).toHaveLength(1);
  });

  it("is not tripped by silence", () => {
    const detector = new BargeDetector();
    expect(feed(detector, 0, 500)).toEqual([]);
    expect(detector.speaking).toBe(false);
  });

  it("is not tripped by a click: a few milliseconds of loud in a quiet room", () => {
    const detector = quietRoom();
    expect(feed(detector, 0.6, 1)).toEqual([]);
    expect(feed(detector, 0.002, 30)).toEqual([]);
    expect(feed(detector, 0.6, 2)).toEqual([]);
    expect(feed(detector, 0.002, 30)).toEqual([]);
    expect(detector.speaking).toBe(false);
  });

  it("is not tripped by steady noise, however loud, that was there from the start", () => {
    const detector = new BargeDetector();
    // A fan at -26 dBFS: well over the fixed minimum, but the room's own floor.
    expect(feed(detector, 0.05, 500)).toEqual([]);
    expect(detector.floor).toBeCloseTo(0.05, 2);
    expect(detector.threshold).toBeGreaterThan(0.1);
  });

  it("is not tripped by noise too quiet to be speech, whatever the floor", () => {
    const detector = new BargeDetector();
    expect(feed(detector, 0.0005, 100)).toEqual([]);
    expect(feed(detector, 0.01, 100)).toEqual([]);
  });

  it("raises the bar for a noisy room and still hears speech over it", () => {
    const detector = new BargeDetector();
    feed(detector, 0.03, 100);
    expect(feed(detector, 0.06, 20)).toEqual([]); // twice the noise is not speech
    expect(feed(detector, 0.4, 10)).toHaveLength(1);
  });

  it("keeps counting through the gaps between syllables", () => {
    const detector = quietRoom();
    let fired = 0;
    for (let syllable = 0; syllable < 4; syllable += 1) {
      fired += feed(detector, 0.1, 3).length; // 60 ms of voice
      fired += feed(detector, 0.002, 1).length; // 20 ms between
    }
    expect(fired).toBe(1);
  });

  it("learns nothing from windows with no signal, and treats NaN as quiet", () => {
    const detector = quietRoom();
    expect(detector.push(Number.NaN, WINDOW_MS)).toBe(false);
    expect(detector.push(-1, WINDOW_MS)).toBe(false);
  });

  it("starts over on reset", () => {
    const detector = quietRoom();
    feed(detector, 0.1, 10);
    detector.reset();
    expect(detector.speaking).toBe(false);
    expect(detector.floor).toBe(0);
  });
});
