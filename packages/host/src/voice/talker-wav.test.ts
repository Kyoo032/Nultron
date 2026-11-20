import { describe, expect, it } from "vitest";
import { createPcmAligner, inputAudioPart, pcmDurationSeconds, wavFromPcm } from "./talker-wav";

describe("wavFromPcm", () => {
  it("writes a 44-byte 24 kHz mono PCM header in front of the samples", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = wavFromPcm(pcm);
    expect(wav.length).toBe(48);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});

describe("inputAudioPart", () => {
  it("wraps the wav in a data URI and names the format wav", () => {
    const pcm = Buffer.from([8, 9]);
    const part = inputAudioPart(pcm);
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
    const encoded = part.input_audio.data;
    expect(encoded.startsWith("data:audio/wav;base64,")).toBe(true);
    const wav = Buffer.from(encoded.slice("data:audio/wav;base64,".length), "base64");
    expect(wav.subarray(0, 44)).toEqual(wavFromPcm(pcm).subarray(0, 44));
    expect(wav.subarray(44)).toEqual(pcm);
  });
});

describe("createPcmAligner", () => {
  it("carries an odd byte to the next chunk and drops a trailing one", () => {
    const aligner = createPcmAligner();
    const first = aligner.push(Buffer.from([1, 2, 3]));
    const second = aligner.push(Buffer.from([4]));
    const third = aligner.push(Buffer.from([5, 6]));
    expect(first).toEqual(Buffer.from([1, 2]));
    expect(second).toEqual(Buffer.from([3, 4]));
    expect(third).toEqual(Buffer.from([5, 6]));
    expect(aligner.push(Buffer.from([7]))).toBeNull();
  });
});

describe("pcmDurationSeconds", () => {
  it("measures mono PCM16 at 24 kHz and ignores a header it was not given", () => {
    expect(pcmDurationSeconds(48_000)).toBe(1);
    expect(pcmDurationSeconds(0)).toBe(0);
  });
});
