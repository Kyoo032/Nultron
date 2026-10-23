import { describe, expect, it } from "vitest";
import { checkSearchPattern, createRegexScanner, searchLiteralLines } from "./search-text";
import type { DeskPath } from "./types";

const path = "notes/a.md" as DeskPath;

describe("checkSearchPattern", () => {
  it("accepts text and a valid regular expression", () => {
    expect(checkSearchPattern("TODO", false)).toBeNull();
    expect(checkSearchPattern("step \\d+", true)).toBeNull();
  });

  it("refuses an empty pattern", () => {
    expect(checkSearchPattern("", false)).toEqual({
      ok: false,
      code: "bad_pattern",
      message: "The search pattern is empty.",
    });
  });

  it("refuses a pattern over 200 characters, in either mode", () => {
    const message = "The search pattern is longer than 200 characters.";
    expect(checkSearchPattern("a".repeat(201), false)).toEqual({ ok: false, code: "bad_pattern", message });
    expect(checkSearchPattern("a".repeat(201), true)).toEqual({ ok: false, code: "bad_pattern", message });
    expect(checkSearchPattern("a".repeat(200), true)).toBeNull();
  });

  it("refuses a regular expression that does not compile", () => {
    expect(checkSearchPattern("(unclosed", true)).toEqual({
      ok: false,
      code: "bad_pattern",
      message: expect.stringMatching(/^The regular expression is not valid: .*Unterminated group$/),
    });
    expect(checkSearchPattern("(unclosed", false)).toBeNull();
  });

  it("refuses any regex on the hosted server, before compiling it, and still allows plain text", () => {
    const hosted = { AGENTFORGE_SERVER: "1" };
    const refusal = {
      ok: false,
      code: "bad_pattern",
      message: expect.stringContaining("Search for plain text instead"),
    };
    expect(checkSearchPattern("step \\d+", true, hosted)).toEqual(refusal);
    expect(checkSearchPattern("(unclosed", true, hosted)).toEqual(refusal);
    expect(checkSearchPattern("(a|a)*b", true, hosted)).toEqual(refusal);
    expect(checkSearchPattern("TODO", false, hosted)).toBeNull();
    expect(checkSearchPattern("", true, hosted)).toMatchObject({
      code: "bad_pattern",
      message: "The search pattern is empty.",
    });
  });

  it("keeps regex when the server flag is off", () => {
    expect(checkSearchPattern("step \\d+", true, {})).toBeNull();
    expect(checkSearchPattern("step \\d+", true, { AGENTFORGE_SERVER: "0" })).toBeNull();
  });
});

describe("searchLiteralLines", () => {
  it("returns one hit per matching line with 1-based numbers", () => {
    expect(searchLiteralLines(path, "TODO a\nfine\nTODO b TODO c\n", "TODO", 10)).toEqual([
      { path, line: 1, text: "TODO a" },
      { path, line: 3, text: "TODO b TODO c" },
    ]);
  });

  it("is case sensitive and treats the needle as plain text", () => {
    expect(searchLiteralLines(path, "a.b\naxb\nA.B\n", "a.b", 10)).toEqual([{ path, line: 1, text: "a.b" }]);
  });

  it("stops at the limit", () => {
    expect(searchLiteralLines(path, "x\nx\nx\n", "x", 2).map((hit) => hit.line)).toEqual([1, 2]);
  });

  it("cuts a long hit line at 300 characters", () => {
    const [hit] = searchLiteralLines(path, `${"y".repeat(500)} needle`, "needle", 1);
    expect(hit?.text).toBe("y".repeat(300));
  });
});

describe("createRegexScanner", () => {
  it("finds matching lines", () => {
    const scan = createRegexScanner("^step \\d+$");
    expect(scan(path, "intro\nstep 1\nstep two\nstep 22\n", 10)).toEqual([
      { path, line: 2, text: "step 1" },
      { path, line: 4, text: "step 22" },
    ]);
  });

  it("honours the hit limit and reuses one scanner across files", () => {
    const scan = createRegexScanner("x");
    expect(scan(path, "x\nx\nx\n", 2)).toEqual([
      { path, line: 1, text: "x" },
      { path, line: 2, text: "x" },
    ]);
    expect(scan(path, "no\nmatch\n", 2)).toEqual([]);
  });

  it("tests only the first 2000 characters of a line", () => {
    const scan = createRegexScanner("tail$");
    expect(scan(path, `${"z".repeat(2100)}tail`, 5)).toEqual([]);
    expect(scan(path, `${"z".repeat(1990)}tail`, 5)).toHaveLength(1);
  });

  it("gives up on a pattern that backtracks without end instead of hanging", () => {
    const scan = createRegexScanner("(a|a)*b", 300);
    const started = Date.now();
    expect(scan(path, `${"a".repeat(45)}!`, 5)).toBe("too_slow");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("refuses every later file once the time budget is spent", () => {
    // One pass flakes: node:vm can report the timeout a millisecond before the wall
    // clock reaches the slice, and the next file then still runs. Repeat so that gap shows.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const scan = createRegexScanner("(a|a)*b", 200);
      expect(scan(path, `${"a".repeat(45)}!`, 5), `attempt ${attempt} first file`).toBe("too_slow");
      expect(scan(path, "b", 5), `attempt ${attempt} later file`).toBe("too_slow");
    }
  });
});
