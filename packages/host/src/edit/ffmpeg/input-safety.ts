import { ApiError, isServerMode, modeMessage, type AppLocale } from "@agentforge/core";

/**
 * What an uploaded file may make ffmpeg do. The hosted image carries ffmpeg for every desk and a tenant picks the
 * bytes it opens, so a file must not be able to steer the program to other addresses, other files, or hours of
 * run time. Three limits, applied where every ffmpeg and ffprobe run passes (`run.ts`) or where the probe reads
 * the file (`recipes.ts` `probe`, `meeting/audio.ts` `probeDuration`). Record: security register SR-135.
 */

/**
 * The only protocols an input may use. `file` is every path this app hands ffmpeg; `crypto` and `data` are the two
 * that ffmpeg's own demuxers need for local, inline content. `http`, `https`, `tcp`, `udp`, `rtp`, `rtsp` and the
 * rest are absent, so a playlist that names an address cannot make ffmpeg connect to it.
 */
export const INPUT_PROTOCOL_WHITELIST = "file,crypto,data";

const WHITELIST_OPTION = "-protocol_whitelist";

/**
 * The argument list with the whitelist set for every input. For ffmpeg it goes directly before each `-i` (it is an
 * input option, so it must follow that input's own `-ss` and the like and precede the `-i` it governs; a second
 * input needs its own). For ffprobe, whose input is the last positional argument, it goes first. A whitelist a call
 * site supplied is dropped, so no recipe can widen it. Returns a new list.
 */
export function withProtocolWhitelist(argv: readonly string[], bin: "ffmpeg" | "ffprobe"): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === WHITELIST_OPTION) {
      i += 1; // its value goes too
      continue;
    }
    kept.push(argv[i]);
  }
  const pair = [WHITELIST_OPTION, INPUT_PROTOCOL_WHITELIST];
  if (bin === "ffprobe") {
    return [...pair, ...kept];
  }
  return kept.flatMap((part) => (part === "-i" ? [...pair, part] : [part]));
}

/**
 * Container formats (the names `ffprobe` prints as `format_name`) that make ffmpeg open other files or addresses
 * named inside the file: HLS and DASH playlists, `ffconcat` scripts, SDP and RTSP descriptions, and the raw
 * `data` and `ffmetadata` formats, which are not media. They have no place in an uploaded recording or clip.
 * Confirmed against the bundled ffprobe 8.1.3 on small generated files: a local playlist reports `hls`, a concat
 * script `concat`, a metadata file `ffmetadata`; SDP, DASH and an HLS playlist with an address fail the probe
 * itself once the whitelist is on. `applehttp` is the older name of the HLS demuxer.
 */
export const REFUSED_CONTAINER_FORMATS: ReadonlySet<string> = new Set([
  "hls",
  "applehttp",
  "concat",
  "sdp",
  "rtsp",
  "rtp",
  "ffmetadata",
  "data",
  "dash",
]);

/** The first refused name in an ffprobe `format_name` (a comma list such as `mov,mp4,m4a`), or null. */
export function refusedContainerFormat(formatName: unknown): string | null {
  if (typeof formatName !== "string") {
    return null;
  }
  for (const part of formatName.split(",")) {
    const name = part.trim().toLowerCase();
    if (REFUSED_CONTAINER_FORMATS.has(name)) {
      return name;
    }
  }
  return null;
}

/**
 * Throws the refusal for an uploaded file whose container is one of the refused formats. 400, in the run's own
 * locale (`mediaFormatRefused`). The format name is for the server log only; the message names nothing of it.
 */
export function assertAcceptableContainer(formatName: unknown, locale: AppLocale): void {
  if (refusedContainerFormat(formatName) !== null) {
    throw new ApiError("unsupported_media", modeMessage("mediaFormatRefused", locale), 400);
  }
}

/**
 * The longest media the product works through: Meeting reads at most 36 chunks of ten minutes
 * (`meeting/audio.ts` `MAX_CHUNKS * CHUNK_SECONDS`), six hours. A longer declared length is not believed when a
 * timeout is derived from it. (The upload cap, 500 MB for Edit, means a real file this long is audio.)
 */
export const MAX_MEDIA_SECONDS = 36 * 600;

/**
 * Hosted only: the most an analysis step (probe-driven silence and scene scans, Meeting's audio extraction) may
 * run. Within the 500 MB Edit upload cap an hour of video is a low-bitrate file that decodes several times faster
 * than real time, so a legitimate run ends in minutes; the figure only has to stop a forged length from holding
 * one of the two ffmpeg slots (`DEFAULT_MAX_FFMPEG`) for days.
 */
export const ANALYSIS_TIMEOUT_CEILING_MS = 60 * 60 * 1000;

/**
 * Hosted only: the most any single ffmpeg run may take, whichever recipe asked (`run.ts`). A render has no file
 * to bound it, only the timeline, so this is the backstop for it and for any recipe added later. Two hours is more
 * than a 2-vCPU server finishes a 1080p encode of a 30-minute timeline in.
 */
export const HOSTED_RUN_CEILING_MS = 2 * 60 * 60 * 1000;

function believedSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_MEDIA_SECONDS) : 0;
}

/**
 * Timeout for an analysis step over a file of `seconds`: twice its length plus thirty seconds, never below
 * `floorMs`, in whole milliseconds (`execFile` refuses a fractional timeout). The length counts only up to
 * `MAX_MEDIA_SECONDS`, and on a hosted server the result stops at `ANALYSIS_TIMEOUT_CEILING_MS`. A desk has no
 * slot to protect, so only the first bound applies there and an ordinary file keeps exactly its old timeout.
 */
export function mediaTimeoutMs(seconds: number, floorMs: number, hosted: boolean = isServerMode()): number {
  const wanted = Math.ceil(Math.max(floorMs, 2 * believedSeconds(seconds) * 1000 + 30_000));
  return hosted ? Math.min(wanted, ANALYSIS_TIMEOUT_CEILING_MS) : wanted;
}

/** Timeout for exporting a timeline of `timelineSeconds`: ten times its length plus a minute, bounded like the above. */
export function renderTimeoutMs(timelineSeconds: number, hosted: boolean = isServerMode()): number {
  const wanted = Math.ceil(Math.max(60_000, 10 * believedSeconds(timelineSeconds) * 1000 + 60_000));
  return hosted ? Math.min(wanted, HOSTED_RUN_CEILING_MS) : wanted;
}

/**
 * The per-run backstop, applied to the whole-millisecond timeout `execFile` gets (0 means none): on a hosted
 * server no ffmpeg run, whatever it asked for, outlives `HOSTED_RUN_CEILING_MS`, and a request with no usable
 * timeout gets the ceiling instead of none. A desk is left exactly as asked.
 */
export function hostedRunTimeoutMs(timeoutMs: number, hosted: boolean = isServerMode()): number {
  if (!hosted) {
    return timeoutMs;
  }
  return timeoutMs > 0 ? Math.min(timeoutMs, HOSTED_RUN_CEILING_MS) : HOSTED_RUN_CEILING_MS;
}
