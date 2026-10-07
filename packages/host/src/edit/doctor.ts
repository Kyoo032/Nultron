import { type BinaryStatus, resetFfmpegBinaryCache, resolveFfmpeg, resolveFfmpegAsync } from "./ffmpeg-binary";
import { ffmpegSetupHint, usesBundledFfmpeg, type FfmpegSetupHint } from "./ffmpeg-setup";
import { isServerMode } from "@agentforge/core";
import type { ModelCacheScope } from "../model-cache";
import { currentRequestSession } from "../tenant-scope";
import { resolveAsrCapability } from "./asr";

export type EditDoctorAsr = {
  available: boolean;
  backend: string | null;
  model: string | null;
};

export type EditDoctorReport = {
  ffmpeg: {
    found: boolean;
    path: string | null;
    version: string | null;
    reason?: string;
    /**
     * Present only when ffmpeg is missing or unusable: how to install it on this OS, or, in the packaged app
     * (`setup.bundled`), that the install's own copy needs the app reinstalled.
     */
    setup?: FfmpegSetupHint;
  };
  asr: EditDoctorAsr;
  fonts: string[];
};

/** The report with no server path and no install advice in it. */
export type HostedEditDoctorReport = Omit<EditDoctorReport, "ffmpeg"> & {
  ffmpeg: Omit<EditDoctorReport["ffmpeg"], "path" | "setup">;
};

/**
 * What a hosted tenant is shown: whether ffmpeg is there and why not, and nothing about the server.
 *
 * On a desk the path and the setup hint are about the owner's own machine and help them fix an
 * install. On the hosted server both describe the operator's: the path is its filesystem layout, and
 * the hint is its platform, the command that installs ffmpeg on it and the environment variable that
 * points at a custom build. A tenant can act on none of it, and the hosted banner
 * (`ffmpeg-setup-notice.tsx`) reads `found` only and shows one calm line, so both are dropped.
 * `found`, `version` and `reason` stay.
 */
export function withoutBinaryPath(report: EditDoctorReport): HostedEditDoctorReport {
  const { path: _serverPath, setup: _serverSetup, ...ffmpeg } = report.ffmpeg;
  return { ...report, ffmpeg };
}

export type EditDoctorOptions = {
  /** Drop the cached probe so a freshly installed ffmpeg is picked up without a restart. */
  recheck?: boolean;
  /** Whose speech-to-text models the report names (the hosted server reads them per tenant). */
  scope?: ModelCacheScope;
};

/** Minimum gap between forced re-probes; each one re-walks PATH and runs ffmpeg, so this caps abuse from a local page. */
export const RECHECK_MIN_INTERVAL_MS = 2_000;

let lastRecheckAt = 0;

export function resetDoctorRecheckThrottle(): void {
  lastRecheckAt = 0;
}

function applyRecheck(options: EditDoctorOptions, now: number): void {
  if (options.recheck && now - lastRecheckAt >= RECHECK_MIN_INTERVAL_MS) {
    lastRecheckAt = now;
    resetFfmpegBinaryCache();
  }
}

/**
 * The speech-to-text capability of the caller's own catalogue. A hosted report with nobody behind it (no
 * tenant named, no request in scope: the Edit agent reads this mid-turn for the ffmpeg line alone) has no
 * catalogue to describe, so it says "none" rather than read anyone's or refuse.
 */
function asrFor(scope?: ModelCacheScope): EditDoctorAsr {
  if (isServerMode() && !scope && !currentRequestSession()) {
    return { available: false, backend: null, model: null };
  }
  return resolveAsrCapability(scope);
}

function reportFor(ffmpeg: BinaryStatus, scope?: ModelCacheScope): EditDoctorReport {
  return {
    ffmpeg: {
      found: ffmpeg.found,
      path: ffmpeg.path,
      version: ffmpeg.version,
      ...(ffmpeg.reason ? { reason: ffmpeg.reason } : {}),
      ...(ffmpeg.found
        ? {}
        : { setup: ffmpegSetupHint(process.platform, ffmpeg.reason, { bundled: usesBundledFfmpeg() }) }),
    },
    asr: asrFor(scope),
    fonts: [],
  };
}

/**
 * The report, probing synchronously when nothing is cached. For callers that cannot await (the Edit
 * agent's prompt line reads it mid-turn) and that run after the cache is warm; anything on a request
 * or boot path uses `getEditDoctorAsync`.
 */
export function getEditDoctor(options: EditDoctorOptions = {}, now: number = Date.now()): EditDoctorReport {
  applyRecheck(options, now);
  return reportFor(resolveFfmpeg(), options.scope);
}

/** The same report without blocking the event loop while a cold probe walks PATH and runs ffmpeg. */
export async function getEditDoctorAsync(
  options: EditDoctorOptions = {},
  now: number = Date.now(),
): Promise<EditDoctorReport> {
  applyRecheck(options, now);
  return reportFor(await resolveFfmpegAsync(), options.scope);
}
