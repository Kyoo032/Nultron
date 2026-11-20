import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BYTES_PER_MS,
  FIXTURE_DIR,
  FIXTURE_NAMES,
  FRAME_BYTES,
  type FixtureName,
  findSpeechMarks,
  loadFixture,
  loadFixtures,
  padToFrames,
  pcmMs,
  readWavPcm,
  silencePcm,
  splitFrames,
} from "./audio";

/** The speech start and end the host's own detector finds in each clip, measured on these exact bytes. */
const MARKS: Record<FixtureName, { startMs: number; endMs: number; lengthMs: number }> = {
  fact: { startMs: 90, endMs: 2_140, lengthMs: 2_160 },
  smalltalk: { startMs: 80, endMs: 1_820, lengthMs: 1_840 },
  task: { startMs: 90, endMs: 2_080, lengthMs: 2_160 },
  unfinished: { startMs: 80, endMs: 1_260, lengthMs: 1_280 },
  backchannel: { startMs: 80, endMs: 620, lengthMs: 640 },
  stop: { startMs: 80, endMs: 1_500, lengthMs: 1_520 },
  long: { startMs: 80, endMs: 9_760, lengthMs: 9_760 },
};

function wav(pcm: Buffer, options: { rate?: number; channels?: number; bits?: number } = {}): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(options.channels ?? 1, 22);
  header.writeUInt32LE(options.rate ?? 24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(options.bits ?? 16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("the end-of-speech finder", () => {
  for (const name of FIXTURE_NAMES) {
    it(`finds where ${name}.wav starts and really ends`, () => {
      const fixture = loadFixture(name);
      const expected = MARKS[name];
      expect(fixture.lengthMs).toBeCloseTo(expected.lengthMs, 0);
      expect(Math.abs(fixture.marks.startMs - expected.startMs)).toBeLessThanOrEqual(30);
      expect(Math.abs(fixture.marks.endMs - expected.endMs)).toBeLessThanOrEqual(30);
      // The end of speech is never past the end of the clip.
      expect(fixture.marks.endMs).toBeLessThanOrEqual(fixture.lengthMs + 1);
    });
  }

  it("is the end of speech and not the end of the file where they differ", () => {
    // task.wav carries 80 ms of quiet after its last sound: using the file's length would add that to every latency.
    const task = loadFixture("task");
    expect(task.lengthMs - task.marks.endMs).toBeGreaterThanOrEqual(50);
  });

  it("sees the clause pauses of long.wav as more than one utterance but one end", () => {
    const long = loadFixture("long");
    expect(long.marks.utterances).toBeGreaterThanOrEqual(2);
    expect(long.marks.endMs).toBeGreaterThan(9_700);
  });

  it("finds speech in a synthetic burst and refuses a clip with none", () => {
    const burst = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 4_800; i += 1) {
      burst.writeInt16LE(Math.round(8_000 * Math.sin((i / 24_000) * 2 * Math.PI * 440)), (12_000 + i) * 2);
    }
    const marks = findSpeechMarks(burst);
    expect(marks.startMs).toBeGreaterThanOrEqual(480);
    expect(marks.endMs).toBeGreaterThan(680);
    expect(marks.endMs).toBeLessThanOrEqual(720);
    expect(() => findSpeechMarks(silencePcm(1_000))).toThrow(/no complete speech/);
  });
});

describe("the fixtures", () => {
  it("are all seven, padded to whole 40 ms frames", () => {
    const fixtures = loadFixtures();
    expect(Object.keys(fixtures).sort()).toEqual([...FIXTURE_NAMES].sort());
    for (const fixture of Object.values(fixtures)) {
      expect(fixture.pcm.length % FRAME_BYTES).toBe(0);
      expect(fixture.pcm.length).toBeGreaterThanOrEqual(fixture.lengthMs * BYTES_PER_MS);
    }
  });

  it("are read from the wav files without being changed", () => {
    for (const name of FIXTURE_NAMES) {
      const pcm = readWavPcm(readFileSync(join(FIXTURE_DIR, `${name}.wav`)), name);
      const fixture = loadFixture(name);
      expect(fixture.pcm.subarray(0, pcm.length).equals(pcm)).toBe(true);
    }
  });
});

describe("wav reading", () => {
  it("returns the samples of a 24 kHz mono 16-bit file", () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    expect(readWavPcm(wav(pcm)).equals(pcm)).toBe(true);
  });

  it("refuses any other format, with the format in the message", () => {
    expect(() => readWavPcm(wav(Buffer.alloc(8), { rate: 16_000 }), "x.wav")).toThrow(/x\.wav is 16000 Hz/);
    expect(() => readWavPcm(wav(Buffer.alloc(8), { channels: 2 }))).toThrow(/2 channel/);
    expect(() => readWavPcm(wav(Buffer.alloc(8), { bits: 8 }))).toThrow(/8-bit/);
    expect(() => readWavPcm(Buffer.from("not a wav file at all"))).toThrow(/not a RIFF/);
  });

  it("skips chunks it does not know and finds the data", () => {
    const pcm = Buffer.from([9, 0, 8, 0]);
    const plain = wav(pcm);
    const list = Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([4, 0, 0, 0]), Buffer.from("abcd", "ascii")]);
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    expect(readWavPcm(withList).equals(pcm)).toBe(true);
  });
});

describe("framing", () => {
  it("cuts audio into 1,920-byte frames and pads the last with silence", () => {
    const pcm = Buffer.alloc(FRAME_BYTES * 2 + 10, 7);
    const frames = splitFrames(pcm);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.length === FRAME_BYTES)).toBe(true);
    expect(frames[2]?.subarray(0, 10).every((byte) => byte === 7)).toBe(true);
    expect(frames[2]?.subarray(10).every((byte) => byte === 0)).toBe(true);
  });

  it("leaves a whole number of frames alone", () => {
    const pcm = Buffer.alloc(FRAME_BYTES * 3, 1);
    expect(padToFrames(pcm)).toBe(pcm);
    expect(FRAME_BYTES).toBe(1_920);
  });

  it("counts milliseconds from bytes", () => {
    expect(pcmMs(silencePcm(250))).toBe(250);
    expect(silencePcm(40).length).toBe(FRAME_BYTES);
  });
});
