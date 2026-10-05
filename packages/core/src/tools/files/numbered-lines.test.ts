import { describe, expect, it } from "vitest";
import { cutText, splitLines, utf8ByteLength } from "./lines";
import { formatNumberedLines } from "./numbered-lines";

describe("formatNumberedLines", () => {
  it("numbers lines from 1 with a tab after the number", () => {
    expect(formatNumberedLines("alpha\nbeta\n")).toEqual({
      text: "     1\talpha\n     2\tbeta",
      firstLine: 1,
      lastLine: 2,
      totalLines: 2,
      truncated: false,
    });
  });

  it("counts a file without a final line break the same way", () => {
    expect(formatNumberedLines("alpha\nbeta")).toMatchObject({ totalLines: 2, lastLine: 2, truncated: false });
  });

  it("hides CRLF breaks", () => {
    expect(formatNumberedLines("a\r\nb\r\n").text).toBe("     1\ta\n     2\tb");
  });

  it("shows an empty file as no lines", () => {
    expect(formatNumberedLines("")).toEqual({ text: "", firstLine: 0, lastLine: 0, totalLines: 0, truncated: false });
  });

  it("starts at offset and stops at limit, with a note saying where to continue", () => {
    const text = "l1\nl2\nl3\nl4\nl5\n";
    expect(formatNumberedLines(text, 2, 2)).toEqual({
      text: "     2\tl2\n     3\tl3\n[Showing lines 2-3 of 5. Call read_file again with offset 4 to continue.]",
      firstLine: 2,
      lastLine: 3,
      totalLines: 5,
      truncated: true,
    });
  });

  it("adds no note when the view reaches the last line", () => {
    expect(formatNumberedLines("l1\nl2\nl3\n", 3, 10)).toEqual({
      text: "     3\tl3",
      firstLine: 3,
      lastLine: 3,
      totalLines: 3,
      truncated: false,
    });
  });

  it("shows at most 2000 lines by default", () => {
    const text = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
    const view = formatNumberedLines(text);
    expect(view.lastLine).toBe(2000);
    expect(view.totalLines).toBe(2500);
    expect(view.truncated).toBe(true);
    expect(view.text.split("\n")).toHaveLength(2001);
    expect(view.text.split("\n").at(-2)).toBe("  2000\tline 2000");
    expect(view.text.split("\n").at(-1)).toBe(
      "[Showing lines 1-2000 of 2500. Call read_file again with offset 2001 to continue.]",
    );
  });

  it("clamps a limit above 2000 and an offset below 1", () => {
    const text = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(formatNumberedLines(text, 0, 9999)).toMatchObject({ firstLine: 1, lastLine: 2000 });
    expect(formatNumberedLines(text, -5, 0)).toMatchObject({ firstLine: 1, lastLine: 1 });
  });

  it("reads the tail from a later offset", () => {
    const text = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(formatNumberedLines(text, 2001)).toMatchObject({ firstLine: 2001, lastLine: 2500, truncated: false });
  });

  it("cuts a line at 2000 characters and says so", () => {
    const view = formatNumberedLines(`${"x".repeat(2500)}\nshort`);
    expect(view.text.split("\n")[0]).toBe(`     1\t${"x".repeat(2000)} [line cut: 2000 of 2500 characters]`);
    expect(view.text.split("\n")[1]).toBe("     2\tshort");
  });

  it("keeps a line of exactly 2000 characters whole", () => {
    expect(formatNumberedLines("y".repeat(2000)).text).toBe(`     1\t${"y".repeat(2000)}`);
  });

  it("says when the offset is past the end", () => {
    expect(formatNumberedLines("a\nb\n", 5)).toEqual({
      text: "[The file has 2 lines; offset 5 is past the end.]",
      firstLine: 0,
      lastLine: 0,
      totalLines: 2,
      truncated: false,
    });
  });
});

describe("line helpers", () => {
  it("splits lines without a phantom last line", () => {
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("\n")).toEqual([""]);
    expect(splitLines("")).toEqual([]);
  });

  it("measures UTF-8 bytes", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(utf8ByteLength("naïve 日本 😀")).toBe(new TextEncoder().encode("naïve 日本 😀").length);
  });

  it("does not cut a surrogate pair in half", () => {
    expect(cutText("ab😀cd", 3)).toBe("ab");
    expect(cutText("ab😀cd", 4)).toBe("ab😀");
    expect(cutText("abc", 5)).toBe("abc");
  });
});
