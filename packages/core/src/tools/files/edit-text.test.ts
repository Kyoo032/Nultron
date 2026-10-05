import { describe, expect, it } from "vitest";
import { applyExactEdit, matchFileLineEndings } from "./edit-text";

describe("applyExactEdit", () => {
  it("replaces a single match", () => {
    expect(applyExactEdit("step one\nstep two\nstep three\n", "step two", "step 2", false)).toEqual({
      ok: true,
      text: "step one\nstep 2\nstep three\n",
      replacements: 1,
    });
  });

  it("refuses zero matches with no_match", () => {
    expect(applyExactEdit("alpha beta", "gamma", "delta", false)).toEqual({
      ok: false,
      code: "no_match",
      message:
        "old_string was not found. It must match the file exactly, including spaces, indentation and line breaks. Read the file again and copy the text.",
    });
  });

  it("refuses two matches with ambiguous_match", () => {
    expect(applyExactEdit("x = 1\ny = 1\n", "= 1", "= 2", false)).toEqual({
      ok: false,
      code: "ambiguous_match",
      message:
        "old_string matches 2 places. Add the lines around it so it matches once, or set replace_all to change every one.",
    });
  });

  it("replaces every match with replaceAll", () => {
    expect(applyExactEdit("x = 1\ny = 1\n", "= 1", "= 2", true)).toEqual({
      ok: true,
      text: "x = 2\ny = 2\n",
      replacements: 2,
    });
  });

  it("replaces one match with replaceAll set", () => {
    expect(applyExactEdit("only here", "here", "there", true)).toEqual({
      ok: true,
      text: "only there",
      replacements: 1,
    });
  });

  it("counts matches that do not overlap", () => {
    expect(applyExactEdit("aaa", "aa", "b", false)).toEqual({ ok: true, text: "ba", replacements: 1 });
    expect(applyExactEdit("aaaa", "aa", "b", true)).toEqual({ ok: true, text: "bb", replacements: 2 });
  });

  it("writes new_string literally, including replacement patterns", () => {
    expect(applyExactEdit("price: X", "X", "$& and $1 and $$", false)).toEqual({
      ok: true,
      text: "price: $& and $1 and $$",
      replacements: 1,
    });
  });

  it("matches across line breaks", () => {
    expect(applyExactEdit("a\nb\nc\n", "a\nb", "z", false)).toEqual({ ok: true, text: "z\nc\n", replacements: 1 });
  });

  it("refuses an empty old_string with bad_pattern", () => {
    expect(applyExactEdit("text", "", "x", false)).toEqual({
      ok: false,
      code: "bad_pattern",
      message: "old_string is empty. Give the exact text to replace, or use write_file for a new file.",
    });
  });

  it("refuses an unchanged edit with bad_pattern", () => {
    expect(applyExactEdit("text", "text", "text", false)).toEqual({
      ok: false,
      code: "bad_pattern",
      message: "old_string and new_string are identical, so nothing would change.",
    });
  });
});

describe("matchFileLineEndings", () => {
  it("gives a snippet CRLF breaks when the whole file uses them", () => {
    expect(matchFileLineEndings("a\r\nb\r\nc\r\n", "a\nb")).toBe("a\r\nb");
  });

  it("does not double a break that is already CRLF", () => {
    expect(matchFileLineEndings("a\r\nb\r\n", "a\r\nb")).toBe("a\r\nb");
  });

  it("leaves the snippet alone for an LF file", () => {
    expect(matchFileLineEndings("a\nb\n", "a\nb")).toBe("a\nb");
  });

  it("leaves the snippet alone for a file with mixed breaks", () => {
    expect(matchFileLineEndings("a\r\nb\nc\r\n", "a\nb")).toBe("a\nb");
  });
});
