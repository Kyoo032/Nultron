/**
 * PCM helpers for the HTTP talker. The browser and the player use raw PCM16, 24 kHz, mono.
 * The gateway wants that audio wrapped in a wav for input, and sends raw PCM16 back out
 * (no RIFF header), sometimes split mid-sample.
 */
import type { Pcm } from "./talker";

export const PCM_SAMPLE_RATE = 24_000;
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** Seconds of mono PCM16 at 24 kHz. The header is not part of the length. */
export function pcmDurationSeconds(byteLength: number): number {
  if (byteLength <= 0) {
    return 0;
  }
  return Math.round((byteLength / (PCM_SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000) / 1000;
}

/** A 44-byte PCM wav around `pcm`. The rate is 24 kHz, mono, 16-bit. */
export function wavFromPcm(pcm: Pcm, rate = PCM_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The speech-in part the gateway accepts: a data URI around a wav, format `wav`. */
export function inputAudioPart(pcm: Pcm): {
  readonly type: "input_audio";
  readonly input_audio: { readonly data: string; readonly format: "wav" };
} {
  const wav = wavFromPcm(pcm);
  return {
    type: "input_audio",
    input_audio: { data: `data:audio/wav;base64,${wav.toString("base64")}`, format: "wav" },
  };
}

/**
 * Yields only whole PCM16 samples. An odd trailing byte is held for the next chunk and
 * dropped when the stream ends, so a split sample is never played.
 */
export function createPcmAligner(): {
  push(chunk: Buffer): Pcm | null;
} {
  let carry: Buffer | null = null;
  return {
    push(chunk: Buffer): Pcm | null {
      const buf = carry && carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      if (buf.length < BYTES_PER_SAMPLE) {
        carry = buf.length === 1 ? buf.subarray(0) : null;
        return null;
      }
      const even = buf.length - (buf.length % BYTES_PER_SAMPLE);
      if (even !== buf.length) {
        carry = buf.subarray(even);
      }
      return buf.subarray(0, even);
    },
  };
}
