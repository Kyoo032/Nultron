import { isPackagedRuntime } from "@agentforge/core";

export type FfmpegPlatform = "macos" | "windows" | "linux";

export type FfmpegSetupHint = {
  platform: FfmpegPlatform;
  summary: string;
  installCommand: string;
  installUrl: string;
  steps: string[];
  envVar: "AGENTFORGE_FFMPEG_PATH";
  /**
   * Present (true) only when the program that failed is the app's own bundled copy. The fix is then to
   * reinstall the app, so `installCommand` and `installUrl` are empty and a screen shows no command to copy.
   */
  bundled?: boolean;
};

export type FfmpegSetupOptions = {
  /** The packaged app's own ffmpeg is the one in question (see `usesBundledFfmpeg`). */
  bundled?: boolean;
};

const MIN_MAJOR = 6;

/**
 * True when the ffmpeg this process uses is the copy shipped inside the packaged app.
 *
 * The packaged shell sets `AGENTFORGE_PACKAGED=1` (`apps/desktop/main.cjs`) and the installer carries
 * `resources/ffmpeg/` (`apps/desktop/scripts/stage-ffmpeg.mjs`), so a failure there is the install's, and the
 * person is told to reinstall, never to install ffmpeg themselves. An explicit `AGENTFORGE_FFMPEG_PATH` outranks
 * the bundled copy (`ffmpeg-binary.ts`), so with one set the problem is that path and the usual advice stands.
 * Webdev, the hosted server and tests are never packaged.
 */
export function usesBundledFfmpeg(): boolean {
  return isPackagedRuntime() && !process.env.AGENTFORGE_FFMPEG_PATH?.trim();
}

function platformOf(nodePlatform: string): FfmpegPlatform {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }
  return "linux";
}

const INSTALL: Record<FfmpegPlatform, { fresh: string; upgrade: string; url: string; where: string }> = {
  macos: {
    fresh: "brew install ffmpeg",
    upgrade: "brew upgrade ffmpeg",
    url: "https://brew.sh",
    where: "Homebrew puts it in /opt/homebrew/bin (Apple silicon) or /usr/local/bin (Intel); both are checked automatically.",
  },
  windows: {
    fresh: "winget install --id Gyan.FFmpeg -e",
    upgrade: "winget upgrade --id Gyan.FFmpeg -e",
    url: "https://ffmpeg.org/download.html#build-windows",
    where: "winget, Chocolatey, Scoop and C:\\ffmpeg\\bin are checked automatically.",
  },
  linux: {
    fresh: "sudo apt install ffmpeg",
    upgrade: "sudo apt install --only-upgrade ffmpeg",
    url: "https://ffmpeg.org/download.html#build-linux",
    where: "/usr/bin, /usr/local/bin and snap are checked automatically.",
  },
};

/**
 * The hint for the packaged app's own copy: reinstall the app. Nothing here names an install tool, a terminal
 * or the AGENTFORGE_FFMPEG_PATH variable, because the person did not choose this ffmpeg and has nothing to set.
 * `reason` only decides whether the file is gone or merely would not start; any other reason reads as the latter.
 */
function bundledHint(platform: FfmpegPlatform, reason: string | undefined): FfmpegSetupHint {
  const summary =
    reason === "missing"
      ? "The video tools that come with this app are missing from this install. Reinstall the app to get them back."
      : "The video tools that come with this app could not start. Reinstall the app to fix this.";
  return {
    platform,
    summary,
    installCommand: "",
    installUrl: "",
    steps: ["Run the installer again. Your desks and files are kept.", "Open the app and press Check again."],
    envVar: "AGENTFORGE_FFMPEG_PATH",
    bundled: true,
  };
}

/**
 * Human guidance for a missing or unusable ffmpeg, keyed by the host platform.
 * Rendered in the Edit studio banner, the onboarding setup check, and the agent prompt.
 */
export function ffmpegSetupHint(
  nodePlatform: string,
  reason: string | undefined,
  options: FfmpegSetupOptions = {},
): FfmpegSetupHint {
  const platform = platformOf(nodePlatform);
  if (options.bundled) {
    return bundledHint(platform, reason);
  }
  const install = INSTALL[platform];
  const outdated = reason === "version_below_6";
  const broken = reason === "exec_failed" || reason === "unparsed_version";
  const summary = outdated
    ? `The ffmpeg that was found is older than ${MIN_MAJOR}. Video editing needs ${MIN_MAJOR} or newer.`
    : broken
      ? "An ffmpeg binary was found but could not run. Reinstall it or point AGENTFORGE_FFMPEG_PATH at a working build."
      : "ffmpeg was not found. Probe, cut, captions and export need it; everything else works without it.";
  const steps = [
    `Open a terminal and run: ${outdated ? install.upgrade : install.fresh}`,
    install.where,
    "Come back here and press Check again. No restart needed.",
    "Custom build? Set AGENTFORGE_FFMPEG_PATH to the full path of the ffmpeg binary and restart the app.",
  ];
  return {
    platform,
    summary,
    installCommand: outdated ? install.upgrade : install.fresh,
    installUrl: install.url,
    steps,
    envVar: "AGENTFORGE_FFMPEG_PATH",
  };
}
