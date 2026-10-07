/**
 * What an uploaded file may make ffmpeg do (SR-135).
 *
 * The hosted image now has ffmpeg on every desk, and a tenant chooses the bytes it opens. Three things keep
 * that file from steering the program:
 *
 * - **Protocols.** Containers such as HLS, DASH and SDP name other URLs, and ffmpeg opens them. Every input is
 *   given `-protocol_whitelist file,crypto,data`, so a playlist cannot make it fetch an address.
 * - **Formats.** A playlist or a concat script that points at local files is refused when the probe reports
 *   it, before ffmpeg opens anything it names. `ffconcat` with its default `safe=1` can still read a sibling
 *   file of the same folder, which is why the format is refused and not only whitelisted.
 * - **Time.** A file declares its own duration, and the timeout used to be derived from it. One that declares
 *   10^6 seconds held an ffmpeg slot for days (and 10^7 overflowed Node's timer, which is why it failed at once
 *   by accident). The derived timeouts are now bounded.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_TIMEOUT_CEILING_MS,
  HOSTED_RUN_CEILING_MS,
  INPUT_PROTOCOL_WHITELIST,
  MAX_MEDIA_SECONDS,
  mediaTimeoutMs,
  REFUSED_CONTAINER_FORMATS,
  refusedContainerFormat,
  renderTimeoutMs,
  withProtocolWhitelist,
} from "./input-safety";

const PAIR = ["-protocol_whitelist", "file,crypto,data"];
const MAX_NODE_TIMER_MS = 2 ** 31 - 1;

describe("withProtocolWhitelist", () => {
  it("is the file, crypto and data protocols and nothing else", () => {
    expect(INPUT_PROTOCOL_WHITELIST).toBe("file,crypto,data");
  });

  it("puts the whitelist directly before every -i, after the options that belong to that input", () => {
    expect(withProtocolWhitelist(["-ss", "2", "-i", "a.mp4", "-frames:v", "1", "out.jpg"], "ffmpeg")).toEqual([
      "-ss",
      "2",
      ...PAIR,
      "-i",
      "a.mp4",
      "-frames:v",
      "1",
      "out.jpg",
    ]);
    expect(withProtocolWhitelist(["-i", "a.mp4", "-i", "b.mov", "-map", "0", "o.mp4"], "ffmpeg")).toEqual([
      ...PAIR,
      "-i",
      "a.mp4",
      ...PAIR,
      "-i",
      "b.mov",
      "-map",
      "0",
      "o.mp4",
    ]);
  });

  it("covers the lavfi input the render recipe uses when a timeline has no clip", () => {
    expect(withProtocolWhitelist(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "out.mp4"], "ffmpeg")).toEqual([
      "-f",
      "lavfi",
      ...PAIR,
      "-i",
      "color=c=black:s=64x64:d=1",
      "out.mp4",
    ]);
  });

  it("leaves an argument list with no input alone", () => {
    expect(withProtocolWhitelist(["-hide_banner", "-version"], "ffmpeg")).toEqual(["-hide_banner", "-version"]);
  });

  it("puts it first for ffprobe, whose input is the last positional argument", () => {
    expect(withProtocolWhitelist(["-v", "error", "-show_format", "clip.mp4"], "ffprobe")).toEqual([
      ...PAIR,
      "-v",
      "error",
      "-show_format",
      "clip.mp4",
    ]);
  });

  it("replaces a whitelist a caller supplied, so a call site cannot widen it", () => {
    const widened = withProtocolWhitelist(["-protocol_whitelist", "file,http,https", "-i", "a.mp4", "o.mp4"], "ffmpeg");
    expect(widened).toEqual([...PAIR, "-i", "a.mp4", "o.mp4"]);
    expect(widened.join(" ")).not.toMatch(/http/);
    const probe = withProtocolWhitelist(["-protocol_whitelist", "all", "-show_format", "x.mp4"], "ffprobe");
    expect(probe).toEqual([...PAIR, "-show_format", "x.mp4"]);
  });

  it("does not change the list it was given", () => {
    const argv = ["-i", "a.mp4", "o.mp4"];
    withProtocolWhitelist(argv, "ffmpeg");
    expect(argv).toEqual(["-i", "a.mp4", "o.mp4"]);
  });
});

describe("refusedContainerFormat", () => {
  it("lets every ordinary media container through", () => {
    for (const name of [
      "mov,mp4,m4a,3gp,3g2,mj2", // mp4, mov, m4a
      "matroska,webm",
      "mp3",
      "wav",
      "ogg",
      "flac",
      "avi",
      "mpegts",
      "png_pipe",
      "jpeg_pipe",
      "image2",
      "gif",
    ]) {
      expect(refusedContainerFormat(name), name).toBeNull();
    }
  });

  it("refuses the playlist, script and metadata formats that open other paths or addresses", () => {
    for (const name of [
      "hls",
      "applehttp",
      "hls,applehttp",
      "concat",
      "sdp",
      "rtsp",
      "rtp",
      "ffmetadata",
      "data",
      "dash",
    ]) {
      expect(refusedContainerFormat(name), name).not.toBeNull();
    }
    expect(refusedContainerFormat("concat")).toBe("concat");
  });

  it("looks at every name in a comma list, and ignores case and spaces", () => {
    expect(refusedContainerFormat("mov,mp4,hls")).toBe("hls");
    expect(refusedContainerFormat(" HLS , x")).toBe("hls");
  });

  it("says nothing when the probe gave no format name", () => {
    for (const value of [undefined, null, "", 3, {}]) {
      expect(refusedContainerFormat(value)).toBeNull();
    }
  });

  it("names the formats it refuses in one readable list", () => {
    expect([...REFUSED_CONTAINER_FORMATS].sort()).toEqual(
      ["applehttp", "concat", "dash", "data", "ffmetadata", "hls", "rtp", "rtsp", "sdp"].sort(),
    );
  });
});

describe("the duration-driven timeouts", () => {
  it("keeps the formula for an ordinary file: twice its length plus thirty seconds, in whole milliseconds", () => {
    expect(mediaTimeoutMs(65.556063, 15_000, false)).toBe(161_113);
    expect(mediaTimeoutMs(65.556063, 15_000, true)).toBe(161_113);
    expect(mediaTimeoutMs(0, 15_000, false)).toBe(30_000);
    expect(mediaTimeoutMs(0, 45_000, false)).toBe(45_000);
  });

  it("treats a duration that is not a positive finite number as zero", () => {
    for (const seconds of [Number.NaN, -5, Number.POSITIVE_INFINITY * 0, Number.NEGATIVE_INFINITY]) {
      expect(mediaTimeoutMs(seconds, 15_000, true)).toBe(30_000);
    }
  });

  it("stops a hosted file that declares an absurd length from holding a slot: one hour at most", () => {
    for (const seconds of [3_600, 10 ** 6, 10 ** 7, 10 ** 12, Number.MAX_VALUE]) {
      const timeout = mediaTimeoutMs(seconds, 15_000, true);
      expect(timeout, String(seconds)).toBeLessThanOrEqual(ANALYSIS_TIMEOUT_CEILING_MS);
      expect(timeout, String(seconds)).toBeGreaterThan(0);
    }
    expect(ANALYSIS_TIMEOUT_CEILING_MS).toBe(60 * 60 * 1000);
  });

  it("on a desk, bounds the length it believes to the longest the product accepts, so nothing reaches Node's timer overflow", () => {
    for (const seconds of [10 ** 6, 10 ** 7, 10 ** 12]) {
      const timeout = mediaTimeoutMs(seconds, 15_000, false);
      expect(timeout).toBe(2 * MAX_MEDIA_SECONDS * 1000 + 30_000);
      expect(timeout).toBeLessThan(MAX_NODE_TIMER_MS);
    }
  });

  it("takes the longest length from Meeting's own limit: thirty-six chunks of ten minutes, six hours", () => {
    expect(MAX_MEDIA_SECONDS).toBe(36 * 600);
    expect(MAX_MEDIA_SECONDS).toBe(6 * 60 * 60);
  });

  it("bounds an export the same way: ten times the timeline on a desk, two hours at most when hosted", () => {
    expect(renderTimeoutMs(10, false)).toBe(160_000);
    expect(renderTimeoutMs(10, true)).toBe(160_000);
    expect(renderTimeoutMs(0, false)).toBe(60_000);
    expect(renderTimeoutMs(10 ** 7, true)).toBeLessThanOrEqual(HOSTED_RUN_CEILING_MS);
    expect(renderTimeoutMs(10 ** 7, false)).toBe(10 * MAX_MEDIA_SECONDS * 1000 + 60_000);
    expect(renderTimeoutMs(Number.NaN, true)).toBe(60_000);
    expect(HOSTED_RUN_CEILING_MS).toBe(2 * 60 * 60 * 1000);
  });
});
