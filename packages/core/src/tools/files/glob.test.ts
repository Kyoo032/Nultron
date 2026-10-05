import { describe, expect, it } from "vitest";
import { checkGlob, globMatcher, matchGlob } from "./glob";

describe("matchGlob", () => {
  it.each([
    ["notes/a.md", "notes/*.md", true],
    ["notes/sub/a.md", "notes/*.md", false],
    ["a.md", "*", true],
    ["notes/a.md", "*", false],
    [".env", "*", true],
    ["a.md", "*.md", true],
    ["a.txt", "*.md", false],
    ["A.md", "a.md", false],
    ["abc.md", "a*c.md", true],
    ["ac.md", "a*c.md", true],
    ["abd.md", "a*c.md", false],
    ["a1.md", "a?.md", true],
    ["a12.md", "a?.md", false],
    ["a/.md", "a?.md", false],
    ["日本.md", "??.md", true],
    ["😀.md", "?.md", true],
  ])("single part: %s against %s is %s", (path, glob, expected) => {
    expect(matchGlob(path, glob)).toBe(expected);
  });

  it.each([
    ["notes/sub/a.md", "notes/**/*.md", true],
    ["notes/a.md", "notes/**/*.md", true],
    ["notes/x/y/z/a.md", "notes/**/*.md", true],
    ["other/a.md", "notes/**/*.md", false],
    ["a.md", "**/*.md", true],
    ["x/y/a.md", "**/*.md", true],
    ["x/y/a.txt", "**/*.md", false],
    ["a/b/c.md", "**", true],
    ["a", "**", true],
    ["a/b", "a/**", true],
    ["a/b/c", "a/**", true],
    ["a", "a/**", false],
    ["a/c.md", "a/**/c.md", true],
    ["a/b/c.md", "a/**/c.md", true],
    ["ab/c.md", "a/**/c.md", false],
    ["a/b/d.md", "a/**/c.md", false],
    ["a/x/b/y/c.md", "a/**/b/**/c.md", true],
    ["ab.md", "a**b.md", true],
    ["a/b.md", "a**b.md", false],
  ])("across folders: %s against %s is %s", (path, glob, expected) => {
    expect(matchGlob(path, glob)).toBe(expected);
  });

  it.each([
    ["x.ts", "*.{ts,tsx}", true],
    ["x.tsx", "*.{ts,tsx}", true],
    ["x.js", "*.{ts,tsx}", false],
    ["src/a.ts", "{src,lib}/**/*.ts", true],
    ["lib/x/y.ts", "{src,lib}/**/*.ts", true],
    ["test/a.ts", "{src,lib}/**/*.ts", false],
    ["b2.md", "{a,b{1,2}}.md", true],
    ["a.md", "{a,b{1,2}}.md", true],
    ["b.md", "{a,b{1,2}}.md", false],
    ["a.md", "{a,}.md", true],
    [".md", "{a,}.md", true],
    ["a{b.md", "a{b.md", true],
    ["ab.md", "a{b.md", false],
    ["a}b.md", "a}b.md", true],
    ["a{b,c.md", "a{b,c.md", true],
    ["ab.md", "a{b,c.md", false],
  ])("alternatives: %s against %s is %s", (path, glob, expected) => {
    expect(matchGlob(path, glob)).toBe(expected);
  });

  it("matches nothing when the braces expand past 64 globs", () => {
    const glob = "{a,b}".repeat(7);
    expect(matchGlob("aaaaaaa", glob)).toBe(false);
  });

  it("does not blow up on a pattern built to make a backtracking matcher stall", () => {
    const path = "a".repeat(120);
    expect(matchGlob(path, "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b")).toBe(false);
    expect(matchGlob(path, "**/**/**/**/**/**/**/**/x")).toBe(false);
  });

  it("builds a matcher once for many paths", () => {
    const matches = globMatcher("docs/**/*.md");
    expect(["docs/a.md", "docs/x/b.md", "docs/c.txt", "src/d.md"].filter(matches)).toEqual([
      "docs/a.md",
      "docs/x/b.md",
    ]);
  });
});

describe("checkGlob", () => {
  it("accepts a missing glob and an ordinary one", () => {
    expect(checkGlob(undefined)).toBeNull();
    expect(checkGlob("notes/**/*.{md,txt}")).toBeNull();
  });

  it("refuses a glob over 200 characters", () => {
    expect(checkGlob("a".repeat(201))).toEqual({
      ok: false,
      code: "bad_pattern",
      message: "The glob is longer than 200 characters.",
    });
  });

  it("refuses a glob with more than 64 combinations", () => {
    expect(checkGlob("{a,b}".repeat(7))).toEqual({
      ok: false,
      code: "bad_pattern",
      message: "The glob has more than 64 {a,b} combinations. Split it.",
    });
  });
});
