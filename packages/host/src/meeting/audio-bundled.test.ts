/**
 * Meeting mode, a recording that cannot be read because ffmpeg is not available.
 *
 * In the packaged app the ffmpeg is the installer's own, so the refusal must not say "Install it": the person
 * installed nothing and cannot. It says the app's video tools did not start and to reinstall the app, and still
 * offers the paste path. Everywhere else (webdev, a desk with its own ffmpeg setup) the message is what it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../edit/ffmpeg-binary", () => ({
  resolveFfmpeg: () => ({ found: false, path: null, version: null, reason: "missing" }),
  resolveFfprobe: () => ({ found: false, path: null, version: null, reason: "missing" }),
  resolveFfmpegAsync: async () => ({ found: false, path: null, version: null, reason: "missing" }),
  resetFfmpegBinaryCache: () => {},
}));

import { extractMeetingAudio } from "./audio";

const saved = { packaged: process.env.AGENTFORGE_PACKAGED, path: process.env.AGENTFORGE_FFMPEG_PATH };

afterEach(() => {
  for (const [key, value] of [
    ["AGENTFORGE_PACKAGED", saved.packaged],
    ["AGENTFORGE_FFMPEG_PATH", saved.path],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function refusal(): Promise<{ code?: string; message: string; status?: number }> {
  try {
    await extractMeetingAudio("recording.mp3", "out", { roots: [], denied: [] } as never);
  } catch (error) {
    return error as { code?: string; message: string; status?: number };
  }
  throw new Error("extractMeetingAudio did not refuse");
}

describe("extractMeetingAudio without a usable ffmpeg", () => {
  it("packaged: says to reinstall the app and still offers the transcript", async () => {
    delete process.env.AGENTFORGE_FFMPEG_PATH;
    process.env.AGENTFORGE_PACKAGED = "1";
    const error = await refusal();

    expect(error.code).toBe("ffmpeg_missing");
    expect(error.message).toMatch(/reinstall/i);
    expect(error.message).toMatch(/transcript/i);
    expect(error.message).not.toMatch(/Install it/);
  });

  it("not packaged: the message is unchanged", async () => {
    delete process.env.AGENTFORGE_PACKAGED;
    const error = await refusal();

    expect(error.code).toBe("ffmpeg_missing");
    expect(error.message).toBe("ffmpeg is needed to read a recording. Install it, or paste the transcript instead.");
  });
});
