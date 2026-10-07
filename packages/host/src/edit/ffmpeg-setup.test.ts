import { afterEach, describe, expect, it } from "vitest";
import { ffmpegSetupHint, usesBundledFfmpeg } from "./ffmpeg-setup";

describe("ffmpegSetupHint", () => {
  it("points macOS users at Homebrew and explains the Finder PATH gap", () => {
    const hint = ffmpegSetupHint("darwin", "missing");
    expect(hint.platform).toBe("macos");
    expect(hint.installCommand).toBe("brew install ffmpeg");
    expect(hint.installUrl).toBe("https://brew.sh");
    expect(hint.summary).toMatch(/ffmpeg was not found/i);
    expect(hint.steps.join(" ")).toMatch(/Check again/);
    expect(hint.envVar).toBe("AGENTFORGE_FFMPEG_PATH");
  });

  it("points Windows users at winget", () => {
    const hint = ffmpegSetupHint("win32", "missing");
    expect(hint.platform).toBe("windows");
    expect(hint.installCommand).toBe("winget install --id Gyan.FFmpeg -e");
    expect(hint.installUrl).toBe("https://ffmpeg.org/download.html#build-windows");
  });

  it("points Linux users at apt", () => {
    const hint = ffmpegSetupHint("linux", "missing");
    expect(hint.platform).toBe("linux");
    expect(hint.installCommand).toBe("sudo apt install ffmpeg");
  });

  it("explains an outdated build instead of a missing one", () => {
    const hint = ffmpegSetupHint("darwin", "version_below_6");
    expect(hint.summary).toMatch(/older than 6/i);
    expect(hint.installCommand).toBe("brew upgrade ffmpeg");
  });

  it("explains a binary that could not run", () => {
    const hint = ffmpegSetupHint("win32", "exec_failed");
    expect(hint.summary).toMatch(/could not run/i);
  });

  it("leaves a desk's hint without a bundled flag", () => {
    expect(ffmpegSetupHint("win32", "missing")).not.toHaveProperty("bundled");
    expect(ffmpegSetupHint("win32", "missing", { bundled: false })).toEqual(ffmpegSetupHint("win32", "missing"));
  });
});

describe("ffmpegSetupHint for the packaged app's own copy", () => {
  const INSTALL_ADVICE = [
    /winget|Gyan/i,
    /brew/i,
    /apt/i,
    /sudo/i,
    /terminal/i,
    /AGENTFORGE_FFMPEG_PATH/,
    /install ffmpeg/i,
  ];

  it("tells the person to reinstall the app, on every platform and for every reason, and names no install tool", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      for (const reason of ["missing", "exec_failed", "unparsed_version", "version_below_6", undefined]) {
        const hint = ffmpegSetupHint(platform, reason, { bundled: true });
        const text = [hint.summary, hint.installCommand, ...hint.steps].join("\n");
        expect(hint.bundled, `${platform} ${reason}`).toBe(true);
        expect(text, `${platform} ${reason}`).toMatch(/reinstall/i);
        for (const advice of INSTALL_ADVICE) {
          expect(text, `${platform} ${reason} ${advice}`).not.toMatch(advice);
        }
        expect(hint.installCommand).toBe("");
        expect(hint.installUrl).toBe("");
      }
    }
  });

  it("says the file is missing when it is, and that it could not start when it did not run", () => {
    expect(ffmpegSetupHint("win32", "missing", { bundled: true }).summary).toMatch(/missing/i);
    expect(ffmpegSetupHint("win32", "exec_failed", { bundled: true }).summary).toMatch(/could not start/i);
  });
});

describe("usesBundledFfmpeg", () => {
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

  it("is true only in the packaged app with no custom path", () => {
    delete process.env.AGENTFORGE_FFMPEG_PATH;
    delete process.env.AGENTFORGE_PACKAGED;
    expect(usesBundledFfmpeg()).toBe(false);
    process.env.AGENTFORGE_PACKAGED = "1";
    expect(usesBundledFfmpeg()).toBe(true);
    process.env.AGENTFORGE_FFMPEG_PATH = "C:\\custom\\ffmpeg.exe";
    expect(usesBundledFfmpeg()).toBe(false);
    process.env.AGENTFORGE_FFMPEG_PATH = "   ";
    expect(usesBundledFfmpeg()).toBe(true);
  });
});
