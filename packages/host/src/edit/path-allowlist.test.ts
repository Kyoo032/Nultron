import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { assertInsidePath, escapeFilterPath } from "./ffmpeg/paths";

describe("path allowlist (G-14)", () => {
  it("rejects NUL, UNC, device, drive-relative, and empty paths", () => {
    const roots = { roots: ["/tmp/edit-root"], denied: [] };
    expect(() => assertInsidePath("", roots)).toThrow(ApiError);
    expect(() => assertInsidePath("a\0b", roots)).toThrow(ApiError);
    expect(() => assertInsidePath("\\\\server\\share\\file", roots)).toThrow(ApiError);
    expect(() => assertInsidePath("\\\\?\\C:\\Windows", roots)).toThrow(ApiError);
    expect(() => assertInsidePath("C:foo", roots)).toThrow(ApiError);
  });

  it("rejects paths that escape the root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edit-root-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ok.txt"), "ok");
    expect(() => assertInsidePath(path.join(dir, "..", "secret"), { roots: [dir], denied: [] })).toThrow(ApiError);
  });

  it("rejects a symlink that points outside the root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "edit-link-"));
    const outside = mkdtempSync(path.join(tmpdir(), "edit-out-"));
    writeFileSync(path.join(outside, "secret.txt"), "nope");
    const link = path.join(dir, "escape.txt");
    symlinkSync(path.join(outside, "secret.txt"), link);
    expect(() => assertInsidePath(link, { roots: [dir], denied: [] })).toThrow(ApiError);
  });

  it("escapes C:/ and apostrophes for ass= filters at both levels ffmpeg unescapes a filtergraph", () => {
    // Two levels: the graph parser removes one backslash layer, then the filter splits its options on ":".
    const escaped = escapeFilterPath("C:/Users/O'Brien/title.ass");
    expect(escaped).toBe("C\\\\:/Users/O\\\\\\'Brien/title.ass");
    expect(escapeFilterPath("C:\\Users\\a.ass")).toBe("C\\\\:/Users/a.ass");
    expect(escapeFilterPath("/data/a[1],b;c.ass")).toBe("/data/a\\[1\\]\\,b\\;c.ass");
    expect(escapeFilterPath("/data/plain.ass")).toBe("/data/plain.ass");
  });
});
