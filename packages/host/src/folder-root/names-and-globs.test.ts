import { describe, expect, it } from "vitest";
import { parseRelPath } from "./contain";
import { isDeniedName, isDeniedPath, isSkippedDirName } from "./denied-names";
import { compileGlob } from "./glob";
import { isFolderRefusal } from "./refusal";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isFolderRefusal(error)) {
      return error.code;
    }
    throw error;
  }
  return "no refusal";
}

describe("denied names", () => {
  it.each([
    ".env",
    ".ENV",
    ".env.local",
    ".env.production",
    "server.pem",
    "tls.KEY",
    "store.p12",
    "cert.pfx",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    ".npmrc",
    ".netrc",
    ".git",
    ".ssh",
    ".envrc",
    ".git-credentials",
    ".aws",
    ".gnupg",
  ])("refuses %s", (name) => {
    expect(isDeniedName(name)).toBe(true);
  });

  it.each(["README.md", "environment.ts", "keys.md", "monkey.txt", "src", "envelope.ts", "ssh-notes.md", "pem.txt"])(
    "allows %s",
    (name) => {
      expect(isDeniedName(name)).toBe(false);
    },
  );

  it("refuses a path when any segment is denied, not only the last", () => {
    expect(isDeniedPath(["src", ".ssh", "known_hosts"])).toBe(true);
    expect(isDeniedPath([".git", "config"])).toBe(true);
    expect(isDeniedPath(["src", "app.ts"])).toBe(false);
  });

  it("skips noise directories in listings but does not deny them", () => {
    for (const name of ["node_modules", "dist", "build", ".next", ".turbo", "Node_Modules"]) {
      expect(isSkippedDirName(name), name).toBe(true);
      expect(isDeniedName(name), name).toBe(false);
    }
    expect(isSkippedDirName("src")).toBe(false);
  });
});

describe("parseRelPath", () => {
  it("splits a plain path", () => {
    expect(parseRelPath("src/app/main.ts")).toEqual(["src", "app", "main.ts"]);
  });

  it.each([
    "",
    "/etc/passwd",
    "../secrets.txt",
    "a/../../b",
    "a//b",
    "a/./b",
    "a\\b",
    "C:/Windows/win.ini",
    "file.txt:stream",
    ".env.",
    "notes.txt ",
    "con",
    "NUL.txt",
    "a/com1.log",
    "dir/",
    "bad\u0000name",
    "what?.txt",
    "x".repeat(300),
  ])("refuses %j as bad_path", (input) => {
    expect(codeOf(() => parseRelPath(input))).toBe("bad_path");
  });

  it("refuses a non-string", () => {
    expect(codeOf(() => parseRelPath(42))).toBe("bad_path");
    expect(codeOf(() => parseRelPath(undefined))).toBe("bad_path");
  });
});

describe("compileGlob", () => {
  it("matches a bare pattern against the file name at any depth", () => {
    const matches = compileGlob("*.md");
    expect(matches("README.md")).toBe(true);
    expect(matches("docs/guide/intro.MD")).toBe(true);
    expect(matches("docs/guide/intro.mdx")).toBe(false);
  });

  it("matches a pattern with a slash against the whole path", () => {
    const matches = compileGlob("src/**/*.ts");
    expect(matches("src/a.ts")).toBe(true);
    expect(matches("src/a/b/c.ts")).toBe(true);
    expect(matches("lib/a.ts")).toBe(false);
    expect(matches("src/a/b/c.js")).toBe(false);
  });

  it("supports ?, **, and one level of braces", () => {
    expect(compileGlob("file?.txt")("file1.txt")).toBe(true);
    expect(compileGlob("file?.txt")("file12.txt")).toBe(false);
    expect(compileGlob("**/test/*.{ts,tsx}")("a/b/test/x.tsx")).toBe(true);
    expect(compileGlob("**/test/*.{ts,tsx}")("a/b/test/x.js")).toBe(false);
  });

  it("treats no glob as everything", () => {
    expect(compileGlob(undefined)("anything/at/all")).toBe(true);
    expect(compileGlob("  ")("anything/at/all")).toBe(true);
  });

  it("stays fast on a hostile pattern", () => {
    const hostile = compileGlob("**/**/**/**/**/**/**/**/zzz");
    const start = Date.now();
    expect(hostile(`${"a/".repeat(200)}b`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("refuses a pattern with a backslash or too many alternatives", () => {
    expect(codeOf(() => compileGlob("a\\b"))).toBe("bad_pattern");
    expect(codeOf(() => compileGlob("{a,b,c,d}{a,b,c,d}{a,b,c,d}"))).toBe("bad_pattern");
  });
});
