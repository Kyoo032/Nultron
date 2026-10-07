import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FILES_MAX_BYTES,
  FILES_MAX_PATH_CHARS,
  FILES_MAX_PATH_SEGMENTS,
  authorOf,
  baseName,
  checkNewPath,
  fileFromSearch,
  filesErrorKey,
  folderOf,
  formatWhen,
  groupByFolder,
  numberLines,
  readUploadText,
  utf8Bytes,
  type FileEntry,
  type FileVersion,
} from "./files-model";

const here = dirname(fileURLToPath(import.meta.url));

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return { path, kind: "file", bytes: 10, updatedAt: 1, version: 1, ...over };
}

function upload(bytes: Uint8Array, size = bytes.length) {
  return {
    size,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

describe("limits mirrored from the host", () => {
  it("match the core constants they copy", () => {
    const lines = readFileSync(resolve(here, "../../../packages/core/src/tools/files/lines.ts"), "utf8");
    expect(lines).toMatch(/MAX_FILE_BYTES = 2 \* 1024 \* 1024/);
    expect(FILES_MAX_BYTES).toBe(2 * 1024 * 1024);
    const path = readFileSync(resolve(here, "../../../packages/core/src/tools/files/path.ts"), "utf8");
    expect(path).toContain(`MAX_PATH_CHARS = ${FILES_MAX_PATH_CHARS}`);
    expect(path).toContain(`MAX_PATH_SEGMENTS = ${FILES_MAX_PATH_SEGMENTS}`);
  });
});

describe("groupByFolder", () => {
  it("puts the top level first, then folders A to Z, files A to Z inside", () => {
    const groups = groupByFolder([
      entry("notes/plan.md"),
      entry("readme.md"),
      entry("a/b/deep.txt"),
      entry("notes/draft.md"),
      entry("Apple.md"),
    ]);
    expect(groups.map((g) => g.folder)).toEqual(["", "a/b", "notes"]);
    expect(groups[0].items.map((i) => i.path)).toEqual(["Apple.md", "readme.md"]);
    expect(groups[2].items.map((i) => i.path)).toEqual(["notes/draft.md", "notes/plan.md"]);
  });

  it("orders numbers naturally and leaves the input alone", () => {
    const input = [entry("n/file10.md"), entry("n/file2.md")];
    const before = JSON.stringify(input);
    expect(groupByFolder(input)[0].items.map((i) => i.path)).toEqual(["n/file2.md", "n/file10.md"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("drops directory rows and answers an empty list for nothing", () => {
    expect(groupByFolder([entry("notes", { kind: "dir" })])).toEqual([]);
    expect(groupByFolder([])).toEqual([]);
  });

  it("splits a path into folder and name", () => {
    expect(folderOf("notes/plan.md")).toBe("notes");
    expect(baseName("notes/plan.md")).toBe("plan.md");
    expect(folderOf("plan.md")).toBe("");
    expect(baseName("plan.md")).toBe("plan.md");
  });
});

describe("checkNewPath", () => {
  it("accepts ordinary paths", () => {
    for (const ok of ["plan.md", "notes/plan.md", " notes/plan.md ", "a/b/c/d/e/f/g/h.txt"]) {
      expect(checkNewPath(ok), ok).toBeNull();
    }
  });

  it("names the first slip", () => {
    expect(checkNewPath("")).toBe("empty");
    expect(checkNewPath("   ")).toBe("empty");
    expect(checkNewPath("/etc/plan.md")).toBe("absolute");
    expect(checkNewPath("notes\\plan.md")).toBe("backslash");
    expect(checkNewPath("notes//plan.md")).toBe("emptyPart");
    expect(checkNewPath("notes/")).toBe("emptyPart");
    expect(checkNewPath("../plan.md")).toBe("dots");
    expect(checkNewPath("./plan.md")).toBe("dots");
    expect(checkNewPath("a/b/c/d/e/f/g/h/i.txt")).toBe("tooDeep");
    expect(checkNewPath("x".repeat(FILES_MAX_PATH_CHARS + 1))).toBe("tooLong");
  });
});

describe("fileFromSearch", () => {
  it("reads the deep link", () => {
    expect(fileFromSearch("?file=notes%2Fplan.md")).toBe("notes/plan.md");
    expect(fileFromSearch("?x=1&file=notes/plan.md")).toBe("notes/plan.md");
    expect(fileFromSearch("file=plan.md")).toBe("plan.md");
  });

  it("answers null for nothing usable", () => {
    expect(fileFromSearch("")).toBeNull();
    expect(fileFromSearch("?file=")).toBeNull();
    expect(fileFromSearch("?file=%20%20")).toBeNull();
    expect(fileFromSearch("?other=1")).toBeNull();
    expect(fileFromSearch(`?file=${"x".repeat(FILES_MAX_PATH_CHARS + 1)}`)).toBeNull();
  });
});

describe("readUploadText", () => {
  it("reads UTF-8 text, a BOM and an empty file", async () => {
    const text = "héllo\nwörld ✓\n";
    expect(await readUploadText(upload(new TextEncoder().encode(text)))).toEqual({ ok: true, text });
    expect(await readUploadText(upload(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])))).toEqual({
      ok: true,
      text: "hi",
    });
    expect(await readUploadText(upload(new Uint8Array()))).toEqual({ ok: true, text: "" });
  });

  it("refuses binary: invalid UTF-8 and NUL", async () => {
    expect(await readUploadText(upload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])))).toEqual({
      ok: false,
      reason: "binary",
    });
    expect(await readUploadText(upload(new Uint8Array([0x61, 0x00, 0x62])))).toEqual({ ok: false, reason: "binary" });
  });

  it("refuses over the cap without reading, and reports an unreadable file", async () => {
    let read = false;
    const big = {
      size: FILES_MAX_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    };
    expect(await readUploadText(big)).toEqual({ ok: false, reason: "too_large" });
    expect(read).toBe(false);
    expect(await readUploadText({ size: 3, arrayBuffer: async () => Promise.reject(new Error("boom")) })).toEqual({
      ok: false,
      reason: "read_failed",
    });
  });

  it("takes a file exactly at the cap", async () => {
    const bytes = new Uint8Array(FILES_MAX_BYTES).fill(0x61);
    const result = await readUploadText(upload(bytes));
    expect(result.ok).toBe(true);
  });
});

describe("numberLines", () => {
  it("does not count a trailing newline as a line", () => {
    expect(numberLines("a\nb\n")).toEqual({ lines: ["a", "b"], total: 2, truncated: false });
    expect(numberLines("a\r\nb")).toEqual({ lines: ["a", "b"], total: 2, truncated: false });
  });

  it("keeps blank lines and answers nothing for an empty text", () => {
    expect(numberLines("a\n\nb").lines).toEqual(["a", "", "b"]);
    expect(numberLines("")).toEqual({ lines: [], total: 0, truncated: false });
    expect(numberLines("\n").lines).toEqual([""]);
  });

  it("caps what is drawn and says how many there were", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const cut = numberLines(text, 5);
    expect(cut.lines).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
    expect(cut.total).toBe(12);
    expect(cut.truncated).toBe(true);
  });
});

describe("authorOf", () => {
  const base: FileVersion = {
    version: 1,
    bytes: 1,
    sha256: "x",
    authorKind: "user",
    authorId: "u1",
    mode: null,
    createdAt: 1,
  };

  it("reads an agent version with its mode", () => {
    expect(authorOf({ ...base, authorKind: "agent", authorId: "run-9", mode: "research" }, "u1")).toEqual({
      who: "agent",
      mode: "research",
    });
  });

  it("tells you from a teammate when there is a signed-in person, and is always you on Personal", () => {
    expect(authorOf(base, "u1")).toEqual({ who: "you" });
    expect(authorOf(base, "u2")).toEqual({ who: "teammate" });
    expect(authorOf(base, null)).toEqual({ who: "you" });
  });
});

describe("formatWhen and filesErrorKey", () => {
  it("formats in the locale and answers nothing for a missing time", () => {
    expect(formatWhen(Date.UTC(2026, 9, 3, 12, 0), "en")).toMatch(/2026/);
    expect(formatWhen(Date.UTC(2026, 9, 3, 12, 0), "id")).toMatch(/Okt|Oct/);
    expect(formatWhen(0, "en")).toBe("");
    expect(formatWhen(Number.NaN, "en")).toBe("");
  });

  it("maps the host's codes to catalog keys and reads an unknown one as generic", () => {
    expect(filesErrorKey("not_found")).toBe("files.errors.notFound");
    expect(filesErrorKey("storage_quota_exceeded")).toBe("files.errors.quota");
    expect(filesErrorKey("too_many_files")).toBe("files.errors.tooMany");
    expect(filesErrorKey("save_failed")).toBe("files.errors.saveFailed");
    expect(filesErrorKey("something_new")).toBe("files.errors.generic");
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("✓")).toBe(3);
  });
});
