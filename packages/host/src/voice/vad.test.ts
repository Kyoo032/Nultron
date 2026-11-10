/**
 * The voice detector against the seven synthetic fixtures in `eval/voice/fixtures/` (24 kHz PCM16 mono, made
 * by the gateway's own speech model, no real person's voice) and against audio the tests make: silence, a
 * noise bed, a 100 Hz hum, a tone, a click.
 *
 * "Real" onset and end come from a second, independent measure of the original fixture (5 ms windows, bar at
 * 3% of the clip's loudest window, never below 0.003), so the VAD is not graded by its own numbers. The brief's
 * limits: `speech_start.atMs` within 150 ms of the onset, `speech_end.atMs` within 100 ms of the last sound.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TURN_TIMING } from "./turns";
import { createVad, VAD_DEFAULTS, type VadEvent } from "./vad";

const FIXTURE_DIR = new URL("../../eval/voice/fixtures/", import.meta.url);
const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const START_LIMIT_MS = 150;
const END_LIMIT_MS = 100;

/**
 * Name, length in seconds (as the fixtures README says) and how many utterances the defaults find, as a range.
 * "long" has two pauses the detector sees as 350 ms and 370 to 380 ms, longer than the 300 ms hangover. The
 * second one sits on the edge of a breath the speech model made, so whether it splits depends on where the 10 ms
 * window grid falls: 2 utterances on some offsets and 3 on others.
 */
const FIXTURES = [
  { name: "fact", seconds: 2.16, utterances: [1, 1] },
  { name: "smalltalk", seconds: 1.84, utterances: [1, 1] },
  { name: "task", seconds: 2.16, utterances: [1, 1] },
  { name: "unfinished", seconds: 1.28, utterances: [1, 1] },
  { name: "backchannel", seconds: 0.64, utterances: [1, 1] },
  { name: "stop", seconds: 1.52, utterances: [1, 1] },
  { name: "long", seconds: 9.76, utterances: [2, 3] },
] as const;
type FixtureName = (typeof FIXTURES)[number]["name"];

/** The PCM of a fixture, after checking its header says 24 kHz, mono, 16 bit. */
function loadFixture(name: FixtureName): Buffer {
  const file = readFileSync(new URL(`${name}.wav`, FIXTURE_DIR));
  expect(file.toString("ascii", 0, 4)).toBe("RIFF");
  expect(file.toString("ascii", 8, 12)).toBe("WAVE");
  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      expect(file.readUInt16LE(offset + 8)).toBe(1); // PCM
      expect(file.readUInt16LE(offset + 10)).toBe(1); // mono
      expect(file.readUInt32LE(offset + 12)).toBe(SAMPLE_RATE);
      expect(file.readUInt16LE(offset + 22)).toBe(16);
      formatOk = true;
    }
    if (id === "data") {
      expect(formatOk).toBe(true);
      return file.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${name}.wav`);
}

const FIXTURE_PCM = Object.fromEntries(FIXTURES.map((f) => [f.name, loadFixture(f.name)])) as Record<
  FixtureName,
  Buffer
>;

/** The real onset and last sound of a clip in ms, by an independent measure. */
function truthOf(pcm: Buffer): { onsetMs: number; endMs: number } {
  const window = SAMPLE_RATE / 200; // 5 ms
  const levels: number[] = [];
  for (let i = 0; i + window <= pcm.length / 2; i += window) {
    let sum = 0;
    for (let j = 0; j < window; j += 1) {
      sum += (pcm.readInt16LE((i + j) * 2) / 32768) ** 2;
    }
    levels.push(Math.sqrt(sum / window));
  }
  const bar = Math.max(0.003, 0.03 * Math.max(...levels));
  const first = levels.findIndex((level) => level > bar);
  let last = levels.length - 1;
  while (last > 0 && (levels[last] ?? 0) <= bar) {
    last -= 1;
  }
  return { onsetMs: first * 5, endMs: (last + 1) * 5 };
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round(ms * BYTES_PER_MS));
}

function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** Scales every sample and clips at the 16-bit range. */
function gain(pcm: Buffer, factor: number): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * factor))), i * 2);
  }
  return out;
}

/** Sample-wise sum of two clips, clipped, as long as the longer one. */
function mix(a: Buffer, b: Buffer): Buffer {
  const samples = Math.max(a.length, b.length) / 2;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const sum = (i * 2 < a.length ? a.readInt16LE(i * 2) : 0) + (i * 2 < b.length ? b.readInt16LE(i * 2) : 0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i * 2);
  }
  return out;
}

/** A seeded generator, so a noise test fails the same way every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise with the given RMS (0..1). */
function noise(ms: number, rms: number, seed = 1): Buffer {
  const next = random(seed);
  const samples = Math.round(ms * (SAMPLE_RATE / 1000));
  const out = Buffer.alloc(samples * 2);
  const amplitude = rms * Math.sqrt(3); // uniform noise in [-a, a] has RMS a / sqrt(3)
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.round((next() * 2 - 1) * amplitude * 32768), i * 2);
  }
  return out;
}

/** A sine with the given RMS (0..1). */
function tone(ms: number, hz: number, rms: number): Buffer {
  const samples = Math.round(ms * (SAMPLE_RATE / 1000));
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * rms * Math.SQRT2 * 32768), i * 2);
  }
  return out;
}

function feed(pcm: Buffer, chunkBytes = 1920, options: Parameters<typeof createVad>[0] = {}) {
  const vad = createVad(options);
  const events: VadEvent[] = [];
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    events.push(...vad.push(pcm.subarray(i, i + chunkBytes)));
  }
  return { vad, events };
}

type Utterance = { startMs: number; endMs: number };

/** Pairs the events into utterances; fails the test if they do not alternate start, end. */
function utterances(events: readonly VadEvent[]): Utterance[] {
  const out: Utterance[] = [];
  let open: number | null = null;
  for (const event of events) {
    if (event.type === "speech_start") {
      expect(open).toBeNull();
      open = event.atMs;
    } else {
      expect(open).not.toBeNull();
      expect(event.atMs - (open ?? 0)).toBe(event.speechMs);
      out.push({ startMs: open ?? 0, endMs: event.atMs });
      open = null;
    }
  }
  expect(open).toBeNull();
  return out;
}

/** Fails unless the first start and the last end are within the limits of where the clip really sits. */
function expectOnsetAndEnd(events: readonly VadEvent[], name: FixtureName, offsetMs: number): Utterance[] {
  const found = utterances(events);
  const truth = truthOf(FIXTURE_PCM[name]);
  expect(found.length).toBeGreaterThan(0);
  const first = found[0] as Utterance;
  const last = found[found.length - 1] as Utterance;
  expect(Math.abs(first.startMs - (offsetMs + truth.onsetMs)), `${name} onset`).toBeLessThanOrEqual(START_LIMIT_MS);
  expect(Math.abs(last.endMs - (offsetMs + truth.endMs)), `${name} end`).toBeLessThanOrEqual(END_LIMIT_MS);
  return found;
}

describe("the fixtures", () => {
  it.each(FIXTURES)("$name is $seconds s of 24 kHz mono PCM16", ({ name, seconds }) => {
    expect(FIXTURE_PCM[name].length / BYTES_PER_MS / 1000).toBeCloseTo(seconds, 3);
  });
});

describe("each fixture on its own", () => {
  // Alone: the clip as it is (it opens with about 80 ms of silence) and 500 ms of silence after, which an end needs.
  it.each(FIXTURES)("$name alone: one start, the end 300 ms after the last sound", ({ name, utterances: count }) => {
    const { events, vad } = feed(concat(FIXTURE_PCM[name], silence(500)));
    expect(expectOnsetAndEnd(events, name, 0).length).toBeGreaterThanOrEqual(count[0]);
    expect(expectOnsetAndEnd(events, name, 0).length).toBeLessThanOrEqual(count[1]);
    expect(vad.speaking).toBe(false);
  });

  // Padded: 1 s of silence before and 1 s after, and the same with 1037 ms before so the clip does not sit on a window edge.
  it.each(FIXTURES.flatMap((f) => [1000, 1037].map((lead) => ({ ...f, lead }))))(
    "$name padded with $lead ms before and 1000 ms after: one pass, onset and end in range",
    ({ name, lead, utterances: count }) => {
      const { events } = feed(concat(silence(lead), FIXTURE_PCM[name], silence(1000)));
      const found = expectOnsetAndEnd(events, name, lead);
      expect(found.length).toBeGreaterThanOrEqual(count[0]);
      expect(found.length).toBeLessThanOrEqual(count[1]);
    },
  );

  it.each(FIXTURES.flatMap((f) => [0.2, 2].map((factor) => ({ ...f, factor }))))(
    "$name at $factor x gain (clipped when loud) is found in range",
    ({ name, factor }) => {
      const { events } = feed(concat(silence(1000), gain(FIXTURE_PCM[name], factor), silence(1000)));
      expectOnsetAndEnd(events, name, 1000);
    },
  );

  it("finds every fixture whatever the chunk size the audio arrives in", () => {
    for (const { name } of FIXTURES) {
      const pcm = concat(silence(300), FIXTURE_PCM[name], silence(500));
      const reference = feed(pcm, pcm.length).events;
      for (const chunk of [1, 2, 7, 479, 481, 960, 1920, 4001]) {
        expect(feed(pcm, chunk).events, `${name} in ${chunk}-byte chunks`).toEqual(reference);
      }
    }
  });
});

describe("a room that is not silent", () => {
  it.each(FIXTURES)("$name over low noise (RMS 0.006) is found in range", ({ name }) => {
    const clip = concat(silence(1000), FIXTURE_PCM[name], silence(1000));
    const { events } = feed(mix(clip, noise(clip.length / BYTES_PER_MS, 0.006)));
    expectOnsetAndEnd(events, name, 1000);
  });

  it.each(FIXTURES)("$name over a 100 Hz hum (RMS 0.01) turned on with the stream is found in range", ({ name }) => {
    const clip = concat(silence(500), FIXTURE_PCM[name], silence(1000));
    const { events } = feed(mix(clip, tone(clip.length / BYTES_PER_MS, 100, 0.01)));
    expectOnsetAndEnd(events, name, 500);
  });

  it.each(FIXTURES)("$name over a loud 100 Hz hum (RMS 0.02) is found in range", ({ name }) => {
    // The hum is 2.5 s old when the person starts, which is how a room with a fan sounds.
    const clip = concat(silence(2500), FIXTURE_PCM[name], silence(1000));
    const { events } = feed(mix(clip, tone(clip.length / BYTES_PER_MS, 100, 0.02)));
    expectOnsetAndEnd(events, name, 2500);
  });

  it("learns a hum that was turned off, so the next word is heard at the normal bar", () => {
    const hum = tone(3000, 100, 0.02);
    const clip = concat(hum, silence(1500), gain(FIXTURE_PCM.backchannel, 0.2), silence(1000));
    const { events } = feed(clip);
    const found = utterances(events);
    expect(found).toHaveLength(1);
    const truth = truthOf(FIXTURE_PCM.backchannel);
    expect(Math.abs((found[0]?.startMs ?? 0) - (4500 + truth.onsetMs))).toBeLessThanOrEqual(START_LIMIT_MS);
  });

  it("hears a quiet speaker over low noise at 0.2 x gain", () => {
    const clip = concat(silence(1000), gain(FIXTURE_PCM.fact, 0.2), silence(1000));
    const { events } = feed(mix(clip, noise(clip.length / BYTES_PER_MS, 0.004, 3)));
    expectOnsetAndEnd(events, "fact", 1000);
  });
});

describe("what is not speech", () => {
  it("pure silence gives nothing, and silenceMs is the time fed", () => {
    const { vad, events } = feed(silence(10_000));
    expect(events).toEqual([]);
    expect(vad.speaking).toBe(false);
    expect(vad.nowMs).toBe(10_000);
    expect(vad.silenceMs).toBe(10_000);
  });

  it.each([0.002, 0.004, 0.008, 0.012])("steady low noise at RMS %f for 10 s gives nothing", (rms) => {
    expect(feed(noise(10_000, rms, 9)).events).toEqual([]);
  });

  it("a DC offset on the microphone is not speech", () => {
    const dc = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 24_000; i += 1) {
      dc.writeInt16LE(3000, i * 2); // about 0.09 of full scale, flat
    }
    expect(feed(dc).events).toEqual([]);
  });

  // Decided and documented: a steady sound that is on when the stream opens is taken as the room (the first
  // 50 ms set the floor, which is capped at 0.03), so it starts nothing at all while it stays under 0.09 RMS.
  it.each([
    [440, 0.02],
    [440, 0.05],
    [100, 0.06],
    [3000, 0.05],
  ])("a steady %i Hz tone at RMS %f from the first sample gives nothing", (hz, rms) => {
    expect(feed(tone(8000, hz, rms)).events).toEqual([]);
  });

  // Decided and documented: a steady sound that starts later is counted as speech until it has been steady for
  // steadyMs, then it ends where the steady run began and is learned. One start, one end, no flapping after.
  it("a steady tone that starts after 2 s gives one start and one end, then stays quiet", () => {
    const { events, vad } = feed(concat(silence(2000), tone(8000, 440, 0.2)));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const [start, end] = events;
    expect(start?.atMs).toBe(2000);
    expect(end?.atMs).toBeLessThan(2000 + 1500);
    expect(vad.speaking).toBe(false);
  });

  it("a loud steady tone from the first sample, above the floor cap, gives one start and one end, then nothing", () => {
    const { events } = feed(tone(8000, 440, 0.2));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    expect(events[1]?.atMs).toBe(0);
  });

  it("steadyMs: 0 turns the steady-sound rule off, and the tone stays speech", () => {
    const { events, vad } = feed(concat(silence(2000), tone(8000, 440, 0.2)), 1920, { steadyMs: 0 });
    expect(events.map((e) => e.type)).toEqual(["speech_start"]);
    expect(vad.speaking).toBe(true);
  });

  it("a click starts nothing", () => {
    const click = concat(silence(1000), tone(5, 3000, 0.4), silence(1000));
    const { events, vad } = feed(click);
    expect(events).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it("a key press (two knocks 70 ms apart) starts nothing", () => {
    expect(
      feed(concat(silence(1000), noise(25, 0.3, 5), silence(70), noise(30, 0.2, 6), silence(1000))).events,
    ).toEqual([]);
  });

  it.each([0, 3, 7, 13, 19])("a 90 ms cough starting %i ms into a window starts nothing", (offset) => {
    const cough = concat(silence(1000 + offset), noise(90, 0.25, 7), silence(1000));
    expect(feed(cough).events).toEqual([]);
  });

  it("a click just before a word does not change where the word starts", () => {
    const clip = concat(silence(500), tone(5, 3000, 0.4), silence(400), FIXTURE_PCM.fact, silence(800));
    const { events } = feed(clip);
    const found = expectOnsetAndEnd(events, "fact", 900);
    expect(found).toHaveLength(1);
  });

  it("a burst as long as minSpeechMs is speech", () => {
    const { events } = feed(concat(silence(1000), noise(250, 0.25, 11), silence(1000)));
    expect(utterances(events)).toHaveLength(1);
  });
});

describe("two utterances", () => {
  it.each([400, 1500])("fact and task %i ms apart are two utterances, each in range", (gap) => {
    const first = FIXTURE_PCM.fact;
    const secondOffset = 500 + first.length / BYTES_PER_MS + gap;
    const clip = concat(silence(500), first, silence(gap), FIXTURE_PCM.task, silence(1000));
    const found = utterances(feed(clip).events);
    expect(found).toHaveLength(2);
    const a = truthOf(first);
    const b = truthOf(FIXTURE_PCM.task);
    expect(Math.abs((found[0]?.startMs ?? 0) - (500 + a.onsetMs))).toBeLessThanOrEqual(START_LIMIT_MS);
    expect(Math.abs((found[0]?.endMs ?? 0) - (500 + a.endMs))).toBeLessThanOrEqual(END_LIMIT_MS);
    expect(Math.abs((found[1]?.startMs ?? 0) - (secondOffset + b.onsetMs))).toBeLessThanOrEqual(START_LIMIT_MS);
    expect(Math.abs((found[1]?.endMs ?? 0) - (secondOffset + b.endMs))).toBeLessThanOrEqual(END_LIMIT_MS);
  });

  it("a pause shorter than the hangover is one utterance", () => {
    // 150 ms of silence plus the 15 ms the first clip ends early and the 90 ms the second opens late: 255 ms.
    const clip = concat(silence(500), FIXTURE_PCM.fact, silence(150), FIXTURE_PCM.task, silence(1000));
    expect(utterances(feed(clip).events)).toHaveLength(1);
  });
});

describe("30 s of stream", () => {
  // Two rounds of the six short fixtures with 600 ms between them, then silence up to 30 s: 12 utterances.
  const order: FixtureName[] = ["fact", "smalltalk", "task", "unfinished", "backchannel", "stop"];
  const schedule: { name: FixtureName; offsetMs: number }[] = [];
  const parts: Buffer[] = [silence(600)];
  let cursor = 600;
  for (let round = 0; round < 2; round += 1) {
    for (const name of order) {
      schedule.push({ name, offsetMs: cursor });
      parts.push(FIXTURE_PCM[name], silence(600));
      cursor += FIXTURE_PCM[name].length / BYTES_PER_MS + 600;
    }
  }
  parts.push(silence(Math.max(1000, 30_000 - cursor)));
  const stream = concat(...parts);

  it("is at least 30 s long", () => {
    expect(stream.length / BYTES_PER_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("finds all twelve utterances with the same accuracy at the end as at the start, in 1920-byte frames", () => {
    const vad = createVad();
    const events: VadEvent[] = [];
    let fedBytes = 0;
    for (let i = 0; i < stream.length; i += 1920) {
      const chunk = stream.subarray(i, i + 1920);
      events.push(...vad.push(chunk));
      fedBytes += chunk.length;
      expect(vad.nowMs).toBe(Math.floor(fedBytes / 2 / 24)); // never drifts from the sample count
    }
    const found = utterances(events);
    expect(found).toHaveLength(schedule.length);
    for (const [index, { name, offsetMs }] of schedule.entries()) {
      const truth = truthOf(FIXTURE_PCM[name]);
      expect(
        Math.abs((found[index]?.startMs ?? 0) - (offsetMs + truth.onsetMs)),
        `${index} ${name} onset`,
      ).toBeLessThanOrEqual(START_LIMIT_MS);
      expect(
        Math.abs((found[index]?.endMs ?? 0) - (offsetMs + truth.endMs)),
        `${index} ${name} end`,
      ).toBeLessThanOrEqual(END_LIMIT_MS);
    }
    expect(vad.nowMs).toBe(Math.floor(stream.length / BYTES_PER_MS));
  });

  it("gives the same events and the same time in 7-byte chunks", () => {
    const reference = feed(stream, stream.length);
    const small = feed(stream, 7);
    expect(small.events).toEqual(reference.events);
    expect(small.vad.nowMs).toBe(reference.vad.nowMs);
    expect(small.vad.silenceMs).toBe(reference.vad.silenceMs);
  });
});

describe("chunk size", () => {
  it("gives the same events whatever the chunk size, including 1 byte, 7 bytes and one whole buffer", () => {
    const clip = concat(silence(500), FIXTURE_PCM.smalltalk, silence(400), FIXTURE_PCM.stop, silence(1000));
    const reference = feed(clip, clip.length).events;
    expect(reference.length).toBeGreaterThan(0);
    for (const chunk of [1, 3, 7, 47, 480, 481, 1000, 1920, 3841, clip.length]) {
      expect(feed(clip, chunk).events, `chunk ${chunk}`).toEqual(reference);
    }
  });

  it("does not hold the caller's buffer: overwriting a chunk after push changes nothing", () => {
    const clip = concat(silence(300), FIXTURE_PCM.unfinished, silence(500));
    const reference = feed(clip, clip.length).events;
    const vad = createVad();
    const events: VadEvent[] = [];
    for (let i = 0; i < clip.length; i += 701) {
      const chunk = Buffer.from(clip.subarray(i, i + 701));
      events.push(...vad.push(chunk));
      chunk.fill(0x7f);
    }
    expect(events).toEqual(reference);
  });

  it("ignores an empty chunk", () => {
    const vad = createVad();
    expect(vad.push(Buffer.alloc(0))).toEqual([]);
    expect(vad.nowMs).toBe(0);
  });
});

describe("silenceMs, nowMs, speaking and reset", () => {
  it("starts at zero", () => {
    const vad = createVad();
    expect([vad.nowMs, vad.silenceMs, vad.speaking]).toEqual([0, 0, false]);
  });

  it("counts whole samples: 47 bytes of audio is 23 samples, under 1 ms; 48 bytes is 1 ms; an odd byte waits", () => {
    const vad = createVad();
    vad.push(Buffer.alloc(47));
    expect(vad.nowMs).toBe(0);
    vad.push(Buffer.alloc(1));
    expect(vad.nowMs).toBe(1);
    vad.push(Buffer.alloc(49)); // 48 bytes and one byte of the next sample
    expect(vad.nowMs).toBe(2);
    vad.push(Buffer.alloc(47));
    expect(vad.nowMs).toBe(3);
  });

  it("silenceMs counts from the last speech frame, is 0 while speaking, and is the time fed before any speech", () => {
    const vad = createVad();
    vad.push(silence(250));
    expect(vad.silenceMs).toBe(250);
    const events = vad.push(concat(FIXTURE_PCM.fact.subarray(0, 40 * BYTES_PER_MS * 25)));
    expect(events.map((e) => e.type)).toEqual(["speech_start"]);
    expect(vad.speaking).toBe(true);
    expect(vad.silenceMs).toBe(0);
    // Still speaking while the hangover runs: silenceMs stays 0 until speech_end.
    vad.push(silence(200));
    expect(vad.speaking).toBe(true);
    expect(vad.silenceMs).toBe(0);
    const ended = vad.push(silence(100));
    expect(ended).toHaveLength(1);
    expect(ended[0]?.type).toBe("speech_end");
    expect(vad.speaking).toBe(false);
    const endedAt = ended[0]?.atMs ?? 0;
    expect(endedAt).toBeCloseTo(250 + 1000, -1);
    expect(vad.silenceMs).toBe(vad.nowMs - endedAt);
    expect(vad.silenceMs).toBeGreaterThanOrEqual(VAD_DEFAULTS.hangoverMs);
    vad.push(silence(1000));
    expect(vad.silenceMs).toBe(vad.nowMs - endedAt);
  });

  it("speech_end reports the time of the last speech frame, and speechMs runs from the start", () => {
    const { events } = feed(concat(silence(1000), FIXTURE_PCM.backchannel, silence(1000)));
    const [start, end] = events;
    expect(start?.type).toBe("speech_start");
    expect(end?.type).toBe("speech_end");
    if (start?.type === "speech_start" && end?.type === "speech_end") {
      expect(end.speechMs).toBe(end.atMs - start.atMs);
    }
  });

  it("reset() clears time, state and the learned room, so the same audio gives the same events again", () => {
    const clip = concat(silence(400), FIXTURE_PCM.task, silence(800));
    const vad = createVad();
    const run = (): VadEvent[] => {
      const events: VadEvent[] = [];
      for (let i = 0; i < clip.length; i += 1920) {
        events.push(...vad.push(clip.subarray(i, i + 1920)));
      }
      return events;
    };
    const first = run();
    expect(first.length).toBe(2);
    // End mid-speech with a hum learned, then reset.
    vad.push(tone(2500, 100, 0.02));
    vad.push(FIXTURE_PCM.fact.subarray(0, 24_000));
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect([vad.nowMs, vad.silenceMs, vad.speaking]).toEqual([0, 0, false]);
    expect(run()).toEqual(first);
  });

  it("reset() drops a half-fed sample", () => {
    const vad = createVad();
    vad.push(Buffer.alloc(479));
    vad.reset();
    vad.push(Buffer.alloc(480));
    expect(vad.nowMs).toBe(10);
  });
});

describe("options", () => {
  it("VAD_DEFAULTS keeps its three keys, and the hangover does not exceed the early send", () => {
    expect(Object.keys(VAD_DEFAULTS)).toEqual(expect.arrayContaining(["threshold", "minSpeechMs", "hangoverMs"]));
    // The relay sends early on silenceMs, and silenceMs stays 0 until speech_end: the hangover must not be later.
    expect(VAD_DEFAULTS.hangoverMs).toBeLessThanOrEqual(TURN_TIMING.earlySendMs);
  });

  it("threshold is the absolute minimum: a bar above the fixture's loudness hears nothing", () => {
    const clip = concat(silence(500), FIXTURE_PCM.fact, silence(500));
    expect(feed(clip, 1920, { threshold: 0.9 }).events).toEqual([]);
  });

  it("minSpeechMs: a longer minimum drops the shortest fixture, a shorter one keeps a short burst", () => {
    const clip = concat(silence(500), FIXTURE_PCM.backchannel, silence(500));
    expect(feed(clip, 1920, { minSpeechMs: 800 }).events).toEqual([]);
    const burst = concat(silence(500), noise(50, 0.25, 4), silence(500));
    expect(feed(burst).events).toEqual([]);
    expect(utterances(feed(burst, 1920, { minSpeechMs: 30 }).events)).toHaveLength(1);
  });

  it("hangoverMs sets how long a pause may be inside one utterance", () => {
    const clip = concat(silence(500), FIXTURE_PCM.fact, silence(150), FIXTURE_PCM.task, silence(1000));
    expect(utterances(feed(clip, 1920, { hangoverMs: 100 }).events)).toHaveLength(2);
    expect(utterances(feed(clip, 1920, { hangoverMs: 300 }).events)).toHaveLength(1);
  });

  it("the fixtures bracket TURN_TIMING.interruptAfterMs: 'Iya' speaks under it and 'Stop, tunggu dulu.' over it", () => {
    const speechMsOf = (name: FixtureName): number => {
      const end = feed(concat(silence(500), FIXTURE_PCM[name], silence(1000))).events.find(
        (event) => event.type === "speech_end",
      );
      return end?.type === "speech_end" ? end.speechMs : Number.NaN;
    };
    expect(speechMsOf("backchannel")).toBeLessThan(TURN_TIMING.interruptAfterMs);
    expect(speechMsOf("stop")).toBeGreaterThanOrEqual(TURN_TIMING.interruptAfterMs);
  });

  it("an option left undefined takes the default", () => {
    const clip = concat(silence(500), FIXTURE_PCM.fact, silence(500));
    const a = feed(clip, 1920, { threshold: undefined, noiseRatio: undefined, steadyMs: undefined }).events;
    expect(a).toEqual(feed(clip).events);
  });
});

describe("long.wav and the early send", () => {
  /** A relay's view: how often silenceMs crosses the early-send mark while the person is still going. */
  function crossings(pcm: Buffer): { earlySends: number; endEvents: number; innerPausesMs: number[] } {
    const vad = createVad();
    let earlySends = 0;
    let endEvents = 0;
    let armed = false;
    let lastEnd = 0;
    const innerPausesMs: number[] = [];
    for (let i = 0; i < pcm.length; i += 1920) {
      for (const event of vad.push(pcm.subarray(i, i + 1920))) {
        if (event.type === "speech_start") {
          if (lastEnd > 0) {
            innerPausesMs.push(event.atMs - lastEnd);
          }
          armed = true;
        } else {
          endEvents += 1;
          lastEnd = event.atMs;
        }
      }
      if (armed && vad.silenceMs >= TURN_TIMING.earlySendMs) {
        earlySends += 1;
        armed = false;
      }
    }
    return { earlySends, endEvents, innerPausesMs };
  }

  it.each([0, 1, 4, 9, 37])(
    "finds one or two inner pauses of 300 to 400 ms (offset %i ms), each a false early send",
    (offset) => {
      // 9.76 s with inner pauses of 290, 385, 360 and 140 ms by the 5 ms measure at 0.01 RMS. The detector counts
      // some of the breath in them as sound, so it sees one or two gaps longer than the 300 ms hangover.
      const result = crossings(concat(silence(500 + offset), FIXTURE_PCM.long, silence(1500)));
      expect(result.endEvents).toBeGreaterThanOrEqual(2);
      expect(result.endEvents).toBeLessThanOrEqual(3);
      expect(result.innerPausesMs).toHaveLength(result.endEvents - 1);
      for (const pause of result.innerPausesMs) {
        expect(pause).toBeGreaterThanOrEqual(TURN_TIMING.earlySendMs);
        expect(pause).toBeLessThanOrEqual(400);
        expect(pause).toBeLessThan(TURN_TIMING.endSilenceMs);
      }
      // One early send per inner gap and one at the real end.
      expect(result.earlySends).toBe(result.endEvents);
    },
  );

  it("with a hangover of 400 ms the whole sentence is one utterance", () => {
    const { events } = feed(concat(silence(500), FIXTURE_PCM.long, silence(1500)), 1920, { hangoverMs: 400 });
    expect(utterances(events)).toHaveLength(1);
  });
});
