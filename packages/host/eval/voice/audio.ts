/**
 * The audio side of the voice eval: the seven fixture clips, where speech really starts and ends in
 * each, and the 40 ms framing a browser in hands-free sends.
 *
 * The end of speech comes from `createVad` (`packages/host/src/voice/vad.ts`), the same detector the
 * host uses, run over the clip with silence after it. It is never the end of the file: a clip carries up
 * to a few tens of milliseconds of quiet after its last sound, and the latency the person feels starts
 * at the last sound.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOICE_BYTES_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FRAME_MS,
  VOICE_SAMPLE_RATE,
} from "@agentforge/core/voice";
import { createVad } from "../../src/voice/vad";

export const FRAME_MS = VOICE_FRAME_MS;
export const BYTES_PER_MS = (VOICE_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE) / 1000;
/** One 40 ms frame: 1,920 bytes. */
export const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "fixtures");

/** The seven clips. The texts are in `fixtures/README.md`; `text` here is only for matching captions. */
export const FIXTURE_NAMES = ["fact", "smalltalk", "task", "unfinished", "backchannel", "stop", "long"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const FIXTURE_TEXT: Readonly<Record<FixtureName, string>> = {
  fact: "Berapa total penjualan saya bulan lalu?",
  smalltalk: "Halo, apa kabar hari ini?",
  task: "Tolong buatkan deck dari riset kemarin.",
  unfinished: "Saya mau pesan yang",
  backchannel: "Iya",
  stop: "Stop, tunggu dulu.",
  long: "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan jadwal, bisa bantu saya cek apa saja yang perlu diubah?",
};

/** Pure silence of `ms` milliseconds, rounded down to whole samples. */
export function silencePcm(ms: number): Buffer {
  return Buffer.alloc(Math.floor(ms * (VOICE_SAMPLE_RATE / 1000)) * VOICE_BYTES_PER_SAMPLE);
}

/** How long a PCM buffer is, in ms. */
export function pcmMs(pcm: Buffer): number {
  return pcm.length / BYTES_PER_MS;
}

/** `pcm` followed by enough silence to fill its last 40 ms frame, so a clip always ends on a frame boundary. */
export function padToFrames(pcm: Buffer): Buffer {
  const rest = pcm.length % FRAME_BYTES;
  return rest === 0 ? pcm : Buffer.concat([pcm, Buffer.alloc(FRAME_BYTES - rest)]);
}

/** Cuts PCM into 1,920-byte frames. The last one is padded with silence. */
export function splitFrames(pcm: Buffer): Buffer[] {
  const padded = padToFrames(pcm);
  const frames: Buffer[] = [];
  for (let at = 0; at < padded.length; at += FRAME_BYTES) {
    frames.push(padded.subarray(at, at + FRAME_BYTES));
  }
  return frames;
}

/** The PCM of a 16-bit mono 24 kHz WAV. Anything else is an error: the fixtures must be exactly that. */
export function readWavPcm(file: Buffer, label = "wav"): Buffer {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${label} is not a RIFF/WAVE file`);
  }
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= file.length) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        tag: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        rate: file.readUInt32LE(body + 4),
        bits: file.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) {
        throw new Error(`${label} has a data chunk before its fmt chunk`);
      }
      if (
        format.tag !== 1 ||
        format.channels !== VOICE_CHANNELS ||
        format.rate !== VOICE_SAMPLE_RATE ||
        format.bits !== VOICE_BYTES_PER_SAMPLE * 8
      ) {
        throw new Error(
          `${label} is ${format.rate} Hz, ${format.channels} channel(s), ${format.bits}-bit (tag ${format.tag}); the voice protocol is 24000 Hz mono 16-bit PCM`,
        );
      }
      const end = Math.min(file.length, body + size);
      return file.subarray(body, end - ((end - body) % VOICE_BYTES_PER_SAMPLE));
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${label} has no data chunk`);
}

export type SpeechMarks = {
  /** Start of the first speech, in ms from the start of the clip. */
  readonly startMs: number;
  /** End of the last speech: the real end of what the person said, in ms from the start of the clip. */
  readonly endMs: number;
  /** How many separate utterances the detector saw (a clip with clause pauses can be more than one). */
  readonly utterances: number;
};

/** Silence fed after the clip so the detector's hangover can fire. */
const TAIL_SILENCE_MS = 1_000;

/**
 * Where speech starts and really ends in `pcm`, by the host's own detector.
 * `endMs` is the end of the last speech window, which is what the person feels as "I finished".
 */
export function findSpeechMarks(pcm: Buffer): SpeechMarks {
  const vad = createVad();
  const events = vad.push(Buffer.concat([pcm, silencePcm(TAIL_SILENCE_MS)]));
  let startMs: number | null = null;
  let endMs: number | null = null;
  let utterances = 0;
  for (const event of events) {
    if (event.type === "speech_start") {
      startMs ??= event.atMs;
      utterances += 1;
    } else {
      endMs = event.atMs;
    }
  }
  if (startMs === null || endMs === null) {
    throw new Error("the voice detector heard no complete speech in this clip");
  }
  return { startMs, endMs, utterances };
}

export type Fixture = {
  readonly name: FixtureName;
  readonly text: string;
  /** The clip padded to whole frames. */
  readonly pcm: Buffer;
  /** The clip's length before padding, in ms. */
  readonly lengthMs: number;
  readonly marks: SpeechMarks;
};

const cache = new Map<string, Fixture>();

export function loadFixture(name: FixtureName, dir: string = FIXTURE_DIR): Fixture {
  const key = `${dir}\u0000${name}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }
  const raw = readWavPcm(readFileSync(join(dir, `${name}.wav`)), `${name}.wav`);
  const fixture: Fixture = {
    name,
    text: FIXTURE_TEXT[name],
    pcm: padToFrames(raw),
    lengthMs: pcmMs(raw),
    marks: findSpeechMarks(raw),
  };
  cache.set(key, fixture);
  return fixture;
}

export type Fixtures = Readonly<Record<FixtureName, Fixture>>;

export function loadFixtures(dir: string = FIXTURE_DIR): Fixtures {
  return Object.fromEntries(FIXTURE_NAMES.map((name) => [name, loadFixture(name, dir)])) as Fixtures;
}
