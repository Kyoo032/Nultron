/**
 * The copy of ffmpeg and ffprobe that ships inside the packaged app (`resources/ffmpeg/`, placed there by
 * `apps/desktop/scripts/stage-ffmpeg.mjs`).
 *
 * What these hold: in the packaged app the bundled programs are the answer, not a fallback. They are probed
 * before PATH is searched, a different ffmpeg on PATH never replaces them, and the owner's explicit
 * `AGENTFORGE_FFMPEG_PATH` is still the only thing that outranks them. When the bundled program cannot run, the
 * report says so against the bundled path, and the setup hint tells the person to reinstall the app, never to
 * install ffmpeg by hand. Webdev and every other non-Electron process never look in `resources/ffmpeg`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEditDoctor, resetDoctorRecheckThrottle } from "./doctor";
import { resetFfmpegBinaryCache, resolveFfmpeg, resolveFfprobe } from "./ffmpeg-binary";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
}));

const mockedExec = vi.mocked(execFileSync);
const mockedExists = vi.mocked(existsSync);

const RESOURCES = path.join(path.sep, "opt", "Nultron", "resources");
const EXE = process.platform === "win32" ? ".exe" : "";
const BUNDLED_FFMPEG = path.join(RESOURCES, "ffmpeg", `ffmpeg${EXE}`);
const BUNDLED_FFPROBE = path.join(RESOURCES, "ffmpeg", `ffprobe${EXE}`);
const ON_PATH = path.join(path.sep, "usr", "bin", `ffmpeg${EXE}`);

function banner(name: string, version: string): string {
  return `${name} version ${version} Copyright (c) 2000-2026 the FFmpeg developers\n`;
}

function isPathLookup(file: unknown): boolean {
  return typeof file === "string" && /(?:^|[\\/])(?:which|where\.exe)$/i.test(file);
}

function pathLookups(): unknown[][] {
  return mockedExec.mock.calls.filter((call) => isPathLookup(call[0]));
}

const ENV_KEYS = ["AGENTFORGE_FFMPEG_PATH", "AGENTFORGE_FFPROBE_PATH", "AGENTFORGE_PACKAGED"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");

function runAsElectron(): void {
  Object.defineProperty(process.versions, "electron", { value: "35.0.0", configurable: true, enumerable: true });
  Object.defineProperty(process, "resourcesPath", { value: RESOURCES, configurable: true, writable: true });
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** `existsSync` says yes only to these paths. */
function existing(...paths: string[]): void {
  mockedExists.mockImplementation((file) => paths.includes(String(file)));
}

beforeEach(() => {
  resetFfmpegBinaryCache();
  resetDoctorRecheckThrottle();
  mockedExec.mockReset();
  mockedExists.mockReset();
  mockedExists.mockReturnValue(false);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  resetFfmpegBinaryCache();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restore(process.versions, "electron", electronDescriptor);
  restore(process, "resourcesPath", resourcesDescriptor);
});

describe("the bundled ffmpeg in the packaged app", () => {
  it("wins over a different ffmpeg on PATH, and PATH is never searched", () => {
    runAsElectron();
    existing(BUNDLED_FFMPEG, BUNDLED_FFPROBE, ON_PATH);
    mockedExec.mockImplementation(((file: string) => {
      if (isPathLookup(file)) return `${ON_PATH}\n`;
      if (file === BUNDLED_FFMPEG) return banner("ffmpeg", "n8.1.3-9-g29e619e767-20260930");
      if (file === BUNDLED_FFPROBE) return banner("ffprobe", "n8.1.3-9-g29e619e767-20260930");
      return banner("ffmpeg", "5.1.2");
    }) as never);

    expect(resolveFfmpeg()).toEqual({ found: true, path: BUNDLED_FFMPEG, version: "8.1.3" });
    expect(resolveFfprobe()).toEqual({ found: true, path: BUNDLED_FFPROBE, version: "8.1.3" });
    expect(pathLookups()).toEqual([]);
  });

  it("is outranked only by an explicit AGENTFORGE_FFMPEG_PATH", () => {
    runAsElectron();
    existing(BUNDLED_FFMPEG);
    process.env.AGENTFORGE_FFMPEG_PATH = "/custom/ffmpeg";
    mockedExec.mockImplementation(((file: string) =>
      file === "/custom/ffmpeg" ? banner("ffmpeg", "7.1") : banner("ffmpeg", "8.1.3")) as never);

    expect(resolveFfmpeg()).toEqual({ found: true, path: "/custom/ffmpeg", version: "7.1" });
  });

  it("reports a bundled program that cannot run against the bundled path, without searching PATH", () => {
    runAsElectron();
    existing(BUNDLED_FFMPEG, ON_PATH);
    mockedExec.mockImplementation(((file: string) => {
      if (file === BUNDLED_FFMPEG) throw new Error("spawn UNKNOWN");
      return isPathLookup(file) ? `${ON_PATH}\n` : banner("ffmpeg", "7.0");
    }) as never);

    expect(resolveFfmpeg()).toEqual({ found: false, path: BUNDLED_FFMPEG, version: null, reason: "exec_failed" });
    expect(pathLookups()).toEqual([]);
  });

  it("packaged app, bundle folder missing: reports the bundled path as missing and never walks PATH", () => {
    // The README's rule is "a copy on PATH never replaces the bundled one". An install whose folder is gone must
    // say so (the reinstall notice), not quietly run whatever else the machine has.
    process.env.AGENTFORGE_PACKAGED = "1";
    runAsElectron();
    existing(ON_PATH);
    mockedExec.mockImplementation(((file: string) =>
      isPathLookup(file) ? `${ON_PATH}\n` : banner("ffmpeg", "7.0")) as never);

    expect(resolveFfmpeg()).toEqual({ found: false, path: BUNDLED_FFMPEG, version: null, reason: "missing" });
    expect(resolveFfprobe()).toEqual({ found: false, path: BUNDLED_FFPROBE, version: null, reason: "missing" });
    expect(pathLookups()).toEqual([]);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("packaged app, bundle folder missing, but the owner set AGENTFORGE_FFMPEG_PATH: that path is used", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    runAsElectron();
    existing();
    process.env.AGENTFORGE_FFMPEG_PATH = "/custom/ffmpeg";
    mockedExec.mockImplementation(((file: string) =>
      file === "/custom/ffmpeg" ? banner("ffmpeg", "7.1") : banner("ffmpeg", "5.0")) as never);

    expect(resolveFfmpeg()).toEqual({ found: true, path: "/custom/ffmpeg", version: "7.1" });
  });

  it("Electron but not packaged (the webdev window), folder missing: still finds ffmpeg on PATH", () => {
    // `pnpm desktop:dev` is Electron around webdev: no `AGENTFORGE_PACKAGED`, and `resourcesPath` is Electron's own.
    runAsElectron();
    existing(ON_PATH);
    mockedExec.mockImplementation(((file: string) =>
      isPathLookup(file) ? `${ON_PATH}\n` : banner("ffmpeg", "7.0")) as never);

    expect(resolveFfmpeg()).toEqual({ found: true, path: ON_PATH, version: "7.0" });
    expect(pathLookups()).toHaveLength(1);
  });

  it("is never read outside Electron, even when a file sits at that path", () => {
    // Not Electron: process.versions.electron is absent, as in webdev and in every test run.
    restore(process.versions, "electron", undefined);
    Object.defineProperty(process, "resourcesPath", { value: RESOURCES, configurable: true, writable: true });
    existing(BUNDLED_FFMPEG, ON_PATH);
    mockedExec.mockImplementation(((file: string) =>
      isPathLookup(file) ? `${ON_PATH}\n` : banner("ffmpeg", file === BUNDLED_FFMPEG ? "8.1.3" : "7.0")) as never);

    expect(resolveFfmpeg().path).toBe(ON_PATH);
  });
});

describe("what the doctor says when the packaged app's own ffmpeg is the problem", () => {
  function brokenBundle(): void {
    runAsElectron();
    existing(BUNDLED_FFMPEG);
    mockedExec.mockImplementation((() => {
      throw new Error("spawn UNKNOWN");
    }) as never);
  }

  it("packaged: tells the person to reinstall, with no install command and no install link", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    brokenBundle();
    const { ffmpeg } = getEditDoctor();

    expect(ffmpeg.found).toBe(false);
    expect(ffmpeg.reason).toBe("exec_failed");
    expect(ffmpeg.setup?.bundled).toBe(true);
    expect(ffmpeg.setup?.installCommand).toBe("");
    expect(ffmpeg.setup?.installUrl).toBe("");
    expect(`${ffmpeg.setup?.summary} ${ffmpeg.setup?.steps.join(" ")}`).toMatch(/reinstall/i);
    expect(`${ffmpeg.setup?.summary} ${ffmpeg.setup?.steps.join(" ")}`).not.toMatch(/winget|brew|apt install|sudo/i);
  });

  it("packaged, with the bundle missing: says the tools are missing from the install, even with a copy on PATH", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    runAsElectron();
    existing(ON_PATH);
    mockedExec.mockImplementation(((file: string) =>
      isPathLookup(file) ? `${ON_PATH}\n` : banner("ffmpeg", "7.0")) as never);
    const { ffmpeg } = getEditDoctor();

    expect(ffmpeg.found).toBe(false);
    expect(ffmpeg.path).toBe(BUNDLED_FFMPEG);
    expect(ffmpeg.reason).toBe("missing");
    expect(ffmpeg.setup?.bundled).toBe(true);
    expect(ffmpeg.setup?.summary).toMatch(/missing from this install/i);
  });

  it("webdev (not packaged): the same failure still gets the install guide, unchanged", () => {
    brokenBundle();
    const { ffmpeg } = getEditDoctor();

    expect(ffmpeg.setup).not.toHaveProperty("bundled");
    expect(ffmpeg.setup?.installCommand).toMatch(/ffmpeg/i);
  });

  it("packaged, but the owner pointed AGENTFORGE_FFMPEG_PATH somewhere broken: that path is the problem, not the install", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    runAsElectron();
    process.env.AGENTFORGE_FFMPEG_PATH = "/custom/ffmpeg";
    mockedExec.mockImplementation((() => {
      throw new Error("spawn UNKNOWN");
    }) as never);
    const { ffmpeg } = getEditDoctor();

    expect(ffmpeg.setup).not.toHaveProperty("bundled");
    expect(ffmpeg.setup?.summary).toMatch(/AGENTFORGE_FFMPEG_PATH/);
  });

  it("a working bundled copy carries no setup hint at all", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    runAsElectron();
    existing(BUNDLED_FFMPEG);
    mockedExec.mockImplementation((() => banner("ffmpeg", "8.1.3")) as never);
    const { ffmpeg } = getEditDoctor();

    expect(ffmpeg).toEqual({ found: true, path: BUNDLED_FFMPEG, version: "8.1.3" });
  });
});
