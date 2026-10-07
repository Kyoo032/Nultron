/**
 * Meeting mode — turning an uploaded recording into speech-grade audio chunks.
 *
 * Edit's `extractAudio` recipe does the same encode, but it resolves paths against Edit's project
 * allowlist (`edit/ffmpeg/paths.ts` `editAllowlist`), so it cannot read a file that lives
 * under the meeting store. The ffmpeg runner, the path guard and the probe below are the shared
 * ones; only the allowlist root differs.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@agentforge/core";
import { resolveFfmpeg } from "../edit/ffmpeg-binary";
import { usesBundledFfmpeg } from "../edit/ffmpeg-setup";
import { assertAcceptableContainer, mediaTimeoutMs } from "../edit/ffmpeg/input-safety";
import { assertExistingInput, assertInsidePath, type PathAllowlist } from "../edit/ffmpeg/paths";
import { runFfmpeg } from "../edit/ffmpeg/run";
import { localeForRun } from "../run-context";

/**
 * One chunk per ten minutes. Mono 16 kHz at 64 kbps is about 4.8 MB for that, which every
 * transcription route on the gateway accepts in one request, base64-inflated included.
 */
export const CHUNK_SECONDS = 600;
/** Guards against a pathological file producing hundreds of gateway calls: 6 hours of audio. */
export const MAX_CHUNKS = 36;

export type ExtractedAudio = {
  files: string[];
  durationSeconds: number;
  /** Offset of each chunk from the start, so transcript timings survive the split. */
  offsets: number[];
};

/**
 * Whole milliseconds: a probed duration is fractional (`65.556063`), and `execFile` refuses a
 * fractional timeout outright. `runFfmpeg` rounds too, but a budget that is honest at its source
 * is one less thing to reason about.
 */
function timeoutForMedia(seconds: number): number {
  // The length a recording declares is only believed up to six hours (MAX_CHUNKS chunks of CHUNK_SECONDS, the
  // longest this file reads) and a hosted run stops at an hour, so a forged length cannot hold an ffmpeg slot.
  return mediaTimeoutMs(seconds, 30_000);
}

export function ffmpegAvailable(): boolean {
  return resolveFfmpeg().found;
}

export async function probeDuration(filePath: string, allow: PathAllowlist): Promise<number> {
  const input = assertExistingInput(filePath, allow);
  const { stdout } = await runFfmpeg(["-v", "error", "-print_format", "json", "-show_format", input], {
    timeoutMs: 15_000,
    bin: "ffprobe",
  });
  const parsed = JSON.parse(stdout || "{}") as { format?: { duration?: string; format_name?: string } };
  // A playlist or concat script is not a recording and names other files or addresses (SR-135).
  assertAcceptableContainer(parsed.format?.format_name, localeForRun());
  const duration = Number(parsed.format?.duration ?? 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * Decode whatever was uploaded — audio or video — into mono 16 kHz mp3 segments. Speech
 * recognition gains nothing from stereo or from a higher sample rate, and the smaller payload is
 * what keeps a long meeting inside one gateway request per chunk.
 */
export async function extractMeetingAudio(
  sourcePath: string,
  outDir: string,
  allow: PathAllowlist,
): Promise<ExtractedAudio> {
  if (!ffmpegAvailable()) {
    // In the packaged app the ffmpeg is the installer's own: nobody installed it, so nobody is told to.
    throw new ApiError(
      "ffmpeg_missing",
      usesBundledFfmpeg()
        ? "The video tools that come with this app could not start, so this recording cannot be read. Reinstall the app, or paste the transcript instead."
        : "ffmpeg is needed to read a recording. Install it, or paste the transcript instead.",
      503,
    );
  }
  const input = assertExistingInput(sourcePath, allow);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const pattern = assertInsidePath(path.join(outDir, "chunk-%03d.mp3"), allow);
  const durationSeconds = await probeDuration(input, allow);
  await runFfmpeg(
    [
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "segment",
      "-segment_time",
      String(CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      pattern,
    ],
    { timeoutMs: timeoutForMedia(durationSeconds) },
  );
  if (!existsSync(outDir)) {
    throw new ApiError("ffmpeg_failed", "ffmpeg produced no audio from that recording", 502);
  }
  const files = (await readdir(outDir))
    .filter((name) => name.endsWith(".mp3"))
    .sort()
    .slice(0, MAX_CHUNKS)
    .map((name) => path.join(outDir, name));
  if (files.length === 0) {
    throw new ApiError("ffmpeg_failed", "That recording has no audio track", 400);
  }
  return {
    files,
    durationSeconds,
    offsets: files.map((_, index) => index * CHUNK_SECONDS),
  };
}
