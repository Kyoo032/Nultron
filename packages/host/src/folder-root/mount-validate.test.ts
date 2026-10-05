import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkMountPath, isSystemDirectory } from "./mount-validate";
import { makeSandbox } from "./test-support";

const box = makeSandbox();
const places = { homeDir: path.join(box.base, "home"), dataDir: box.data };
mkdirSync(places.homeDir, { recursive: true });

afterAll(() => {
  box.dispose();
});

describe("checkMountPath refusals", () => {
  it("accepts an ordinary folder and returns its real path", async () => {
    const project = path.join(box.base, "project");
    mkdirSync(project);
    expect(await checkMountPath(project, places)).toEqual({ ok: true, real: project });
  });

  it.each([
    ["a relative path", "folder/sub"],
    ["an empty string", ""],
    ["a dot", "."],
    ["a path with a NUL", "/tmp/a\u0000b"],
    ["a non-string", 42],
  ])("refuses %s as not_absolute", async (_label, input) => {
    expect(await checkMountPath(input, places)).toEqual({ ok: false, reason: "not_absolute" });
  });

  it.runIf(process.platform === "win32")("refuses UNC and root-relative paths on Windows", async () => {
    for (const input of ["\\\\server\\share\\dir", "\\\\?\\C:\\Users", "\\Users\\someone", "C:relative"]) {
      expect(await checkMountPath(input, places), input).toEqual({ ok: false, reason: "not_absolute" });
    }
  });

  it("refuses a folder that does not exist", async () => {
    expect(await checkMountPath(path.join(box.base, "missing"), places)).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a file", async () => {
    const file = box.put("note.txt", "x");
    expect(await checkMountPath(file, places)).toEqual({ ok: false, reason: "not_a_directory" });
  });

  it("refuses the filesystem root", async () => {
    const root = path.parse(box.base).root;
    expect(await checkMountPath(root, places)).toEqual({ ok: false, reason: "filesystem_root" });
  });

  it("refuses the home directory itself but not a folder inside it", async () => {
    expect(await checkMountPath(places.homeDir, places)).toEqual({ ok: false, reason: "home_directory" });
    const inside = path.join(places.homeDir, "work");
    mkdirSync(inside);
    expect(await checkMountPath(inside, places)).toEqual({ ok: true, real: inside });
  });

  it("refuses the app data dir, a folder inside it, and a folder that contains it", async () => {
    expect(await checkMountPath(box.data, places)).toEqual({ ok: false, reason: "app_data" });
    const inside = path.join(box.data, "media");
    mkdirSync(inside);
    expect(await checkMountPath(inside, places)).toEqual({ ok: false, reason: "app_data" });
    expect(await checkMountPath(box.base, places)).toEqual({ ok: false, reason: "app_data" });
  });

  it("refuses a link that points at the app data dir", async () => {
    const link = path.join(box.base, "data-link");
    try {
      symlinkSync(box.data, link, "junction");
    } catch {
      return;
    }
    expect(await checkMountPath(link, places)).toEqual({ ok: false, reason: "app_data" });
  });

  it("refuses a folder named for keys or version control", async () => {
    for (const name of [".ssh", ".git", ".aws", ".gnupg"]) {
      const dir = path.join(box.base, name);
      mkdirSync(dir);
      expect(await checkMountPath(dir, places), name).toEqual({ ok: false, reason: "sensitive_directory" });
    }
    const nested = path.join(box.base, ".git", "hooks");
    mkdirSync(nested);
    expect(await checkMountPath(nested, places)).toEqual({ ok: false, reason: "sensitive_directory" });
  });

  it.runIf(process.platform === "win32")("refuses the real Windows directory", async () => {
    const windir = process.env.SystemRoot ?? "C:\\Windows";
    expect(await checkMountPath(windir, places)).toEqual({ ok: false, reason: "system_directory" });
  });
});

describe("isSystemDirectory", () => {
  it.each([
    ["win32", "C:\\Windows"],
    ["win32", "C:\\Windows\\System32"],
    ["win32", "D:\\windows\\temp"],
    ["win32", "C:\\Program Files"],
    ["win32", "C:\\Program Files (x86)\\Vendor"],
    ["win32", "C:\\ProgramData\\Vendor"],
    ["darwin", "/System/Library"],
    ["darwin", "/Library/Preferences"],
    ["darwin", "/Applications"],
    ["darwin", "/usr/local/bin"],
    ["darwin", "/bin"],
    ["darwin", "/etc"],
    ["darwin", "/private/etc/ssh"],
    ["linux", "/usr"],
    ["linux", "/usr/share/doc"],
    ["linux", "/bin"],
    ["linux", "/etc/nginx"],
    ["linux", "/proc/1"],
    ["linux", "/sys/kernel"],
    ["linux", "/dev/shm"],
  ] as const)("%s: %s is a system directory", (platform, real) => {
    expect(isSystemDirectory(real, platform, {})).toBe(true);
  });

  it.each([
    ["win32", "C:\\Users\\someone\\work"],
    ["win32", "C:\\WindowsApps"],
    ["win32", "C:\\ProgramDataX"],
    ["darwin", "/Users/someone/Library/Application Support"],
    ["darwin", "/private/var/folders/ab/cd"],
    ["darwin", "/Volumes/Backup"],
    ["linux", "/home/someone/projects"],
    ["linux", "/tmp/work"],
    ["linux", "/usrlocal"],
  ] as const)("%s: %s is not", (platform, real) => {
    expect(isSystemDirectory(real, platform, {})).toBe(false);
  });

  it("also honours the Windows environment's own idea of where the system lives", () => {
    expect(isSystemDirectory("E:\\Apps\\Shared", "win32", { ProgramFiles: "E:\\Apps" })).toBe(true);
    expect(isSystemDirectory("E:\\Other", "win32", { ProgramFiles: "E:\\Apps" })).toBe(false);
  });
});
