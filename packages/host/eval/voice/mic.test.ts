import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { FRAME_BYTES, FRAME_MS, loadFixture, silencePcm } from "./audio";
import { realClock } from "./clock";
import { createMic } from "./mic";
import { manualClock } from "./test-helpers";

describe("pacing", () => {
  it("sends 40 ms frames of 1,920 bytes at real-time rate, within a tolerance", async () => {
    const sent: Array<{ at: number; bytes: number }> = [];
    const mic = createMic({ clock: realClock, send: (frame) => sent.push({ at: performance.now(), bytes: frame.length }) });
    mic.start();
    await mic.silence(1_000);
    await mic.stop();

    const frames = sent.slice(0, 25);
    expect(frames).toHaveLength(25);
    expect(frames.every((frame) => frame.bytes === FRAME_BYTES)).toBe(true);
    const first = frames[0]?.at ?? 0;
    const last = frames[24]?.at ?? 0;
    // 24 intervals of 40 ms: the average interval is real time to within a few ms, whatever one timer tick did.
    expect((last - first) / 24).toBeGreaterThan(36);
    expect((last - first) / 24).toBeLessThan(44);
    // And no frame strays far from where a steady 40 ms clock would have put it.
    const worst = Math.max(...frames.map((frame, index) => Math.abs(frame.at - first - index * FRAME_MS)));
    expect(worst).toBeLessThan(80);
  });

  it("sends silence when nothing is queued, so the host never sees a gap", async () => {
    const frames: Buffer[] = [];
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: (frame) => frames.push(Buffer.from(frame)) });
    mic.start();
    await advance(400);
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.length === FRAME_BYTES && frame.every((byte) => byte === 0))).toBe(true);
    await mic.stop();
  });

  it("leaves frames exactly one 40 ms period apart on a steady clock", async () => {
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    await advance(1_000);
    expect(mic.sentAt.slice(0, 5)).toEqual([40, 80, 120, 160, 200]);
    expect(mic.framesSent).toBe(25);
    expect(mic.streamMs).toBe(1_000);
    expect(mic.maxLagMs).toBe(0);
    await mic.stop();
  });

  it("catches up after a stall by sending the late frames at once, and says how late it was", async () => {
    const { clock, advance, jump } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    await advance(200);
    expect(mic.framesSent).toBe(5);
    // The event loop was blocked: 400 ms pass with no tick, and the ten late frames then go out together.
    await jump(400);
    expect(mic.framesSent).toBe(15);
    expect(mic.sentAt.slice(5)).toEqual(Array.from({ length: 10 }, () => 600));
    // The first of them was due at 240 ms and left at 600.
    expect(mic.maxLagMs).toBe(360);
    await mic.stop();
  });

  it("stops sending once stopped", async () => {
    const { clock, advance } = manualClock();
    let count = 0;
    const mic = createMic({
      clock,
      send: () => {
        count += 1;
      },
    });
    mic.start();
    await advance(200);
    const stopping = mic.stop();
    await advance(400);
    await stopping;
    expect(count).toBeLessThanOrEqual(5);
  });

  it("stops and releases waiters when the socket closes under it", async () => {
    const { clock, advance } = manualClock();
    let calls = 0;
    const mic = createMic({
      clock,
      send: () => {
        calls += 1;
        if (calls === 3) {
          throw new Error("the socket is not open");
        }
      },
    });
    mic.start();
    const waiting = mic.silence(2_000);
    await advance(400);
    await waiting;
    expect(mic.failure?.message).toContain("not open");
    expect(mic.framesSent).toBe(2);
  });
});

describe("clips", () => {
  it("sends a queued clip's bytes unchanged, then pads with silence to a frame boundary", async () => {
    const frames: Buffer[] = [];
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: (frame) => frames.push(Buffer.from(frame)) });
    mic.start();
    await advance(80);
    const pcm = Buffer.alloc(FRAME_BYTES * 2 + 10, 7);
    const clip = mic.say(pcm);
    expect(clip).toMatchObject({ startFrame: 2, frames: 3, startMs: 80 });
    await advance(400);
    await clip.sent;
    expect(frames[2]?.every((byte) => byte === 7)).toBe(true);
    expect(frames[3]?.every((byte) => byte === 7)).toBe(true);
    expect(frames[4]?.subarray(0, 10).every((byte) => byte === 7)).toBe(true);
    expect(frames[4]?.subarray(10).every((byte) => byte === 0)).toBe(true);
    expect(frames[5]?.every((byte) => byte === 0)).toBe(true);
    await mic.stop();
  });

  it("starts a second clip behind the first, so the person's own pause is the silence queued between them", async () => {
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    const a = mic.say(Buffer.alloc(FRAME_BYTES * 2, 1));
    const gap = mic.say(silencePcm(400));
    const b = mic.say(Buffer.alloc(FRAME_BYTES, 1));
    expect(a.startFrame).toBe(0);
    expect(gap.startFrame).toBe(2);
    expect(b.startFrame).toBe(12);
    expect(b.startMs).toBe(480);
    await advance(1_000);
    await b.sent;
    await mic.stop();
  });

  it("waits `ms` of stream time after what is queued, and for a stream position", async () => {
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    mic.say(Buffer.alloc(FRAME_BYTES * 5));
    let done = false;
    void mic.silence(200).then(() => {
      done = true;
    });
    await advance(399);
    expect(done).toBe(false);
    await advance(1);
    expect(done).toBe(true);
    let reached = false;
    void mic.whenStreamReaches(1_000).then(() => {
      reached = true;
    });
    await advance(599);
    expect(reached).toBe(false);
    await advance(1);
    expect(reached).toBe(true);
    await mic.stop();
  });
});

describe("the latency clock", () => {
  it("puts the real end of speech on the client clock exactly, on a steady stream", async () => {
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    await advance(600);
    const task = loadFixture("task");
    const clip = mic.say(task.pcm);
    await advance(clip.frames * FRAME_MS);
    await clip.sent;
    const speechEnd = clip.startMs + task.marks.endMs;
    expect(speechEnd).toBe(2_680);
    expect(mic.clockAt(speechEnd)).toBe(2_680);
    expect(mic.clockAt(clip.startMs + task.marks.startMs)).toBe(690);
    await mic.stop();
  });

  it("measures from the end of speech, not from the end of the file", async () => {
    const { clock, advance } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    await advance(600);
    const task = loadFixture("task");
    const clip = mic.say(task.pcm);
    await advance(clip.frames * FRAME_MS);
    const firstAudioAt = 3_800;
    const endAt = mic.clockAt(clip.startMs + task.marks.endMs) ?? Number.NaN;
    const fileEndAt = clip.startMs + task.lengthMs;
    expect(firstAudioAt - endAt).toBe(1_120);
    // Counting from the end of the file would have shaved 80 ms off every latency.
    expect(firstAudioAt - fileEndAt).toBe(1_040);
    await mic.stop();
  });

  it("follows when the host really got the audio when the stream ran late", async () => {
    const { clock, advance, jump } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    mic.start();
    await advance(400);
    const clip = mic.say(Buffer.alloc(FRAME_BYTES * 10));
    // A stall: a second passes with no tick, then every late frame goes out together at 1,400 ms.
    await jump(1_000);
    await clip.sent;
    expect(mic.framesSent).toBe(35);
    // Stream position 800 ms was due at 800 ms but the host got it at 1,400 ms; that is the number that counts.
    expect(mic.clockAt(clip.startMs + 400)).toBe(1_400);
    expect(mic.maxLagMs).toBe(960);
    await mic.stop();
  });

  it("is null for a frame that has not been sent", () => {
    const { clock } = manualClock();
    const mic = createMic({ clock, send: () => undefined });
    expect(mic.clockAt(500)).toBeNull();
  });
});
