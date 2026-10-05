import { describe, expect, it } from "vitest";
import { DIFF_MAX_LINES, diffLines, foldUnchanged, splitLines, type DiffLine } from "./folder-diff";

const same = (text: string): DiffLine => ({ kind: "same", text });
const add = (text: string): DiffLine => ({ kind: "add", text });
const remove = (text: string): DiffLine => ({ kind: "remove", text });

describe("splitLines", () => {
  it("reads an empty text as no lines", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("does not invent an empty last line after a final line break", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("splits on LF, CRLF and CR alike", () => {
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps a blank line in the middle and a lone line break as one empty line", () => {
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("\n")).toEqual([""]);
  });
});

describe("diffLines", () => {
  it("marks a one-line edit as one removal and one addition between unchanged lines", () => {
    const result = diffLines("one\ntwo\nthree\n", "one\n2\nthree\n");
    expect(result.lines).toEqual([same("one"), remove("two"), add("2"), same("three")]);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.changed).toBe(true);
  });

  it("shows a new file as all additions", () => {
    const result = diffLines("", "alpha\nbeta\n");
    expect(result.lines).toEqual([add("alpha"), add("beta")]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
  });

  it("shows a delete as all removals", () => {
    const result = diffLines("alpha\nbeta\n", "");
    expect(result.lines).toEqual([remove("alpha"), remove("beta")]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
  });

  it("keeps the longest common run when lines are inserted and removed together", () => {
    const result = diffLines("a\nb\nc\nd\ne\n", "a\nc\nx\nd\ny\n");
    expect(result.lines).toEqual([same("a"), remove("b"), same("c"), add("x"), same("d"), remove("e"), add("y")]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
  });

  it("handles a block moved to the end as a removal and an addition", () => {
    const result = diffLines("a\nb\nc\n", "b\nc\na\n");
    expect(result.lines).toEqual([remove("a"), same("b"), same("c"), add("a")]);
  });

  it("reports identical texts as unchanged", () => {
    const result = diffLines("same\ntext\n", "same\ntext\n");
    expect(result.lines).toEqual([same("same"), same("text")]);
    expect(result.added + result.removed).toBe(0);
    expect(result.changed).toBe(false);
  });

  it("says a text changed even when no line differs, so a line-ending-only edit is not shown as nothing", () => {
    const result = diffLines("a\nb\n", "a\r\nb\r\n");
    expect(result.added + result.removed).toBe(0);
    expect(result.changed).toBe(true);
    const finalNewline = diffLines("a\nb", "a\nb\n");
    expect(finalNewline.added + finalNewline.removed).toBe(0);
    expect(finalNewline.changed).toBe(true);
  });

  it("compares lines exactly, so trailing spaces count as a change", () => {
    const result = diffLines("a\nb\n", "a \nb\n");
    expect(result.lines).toEqual([remove("a"), add("a "), same("b")]);
  });

  it("returns nothing for two empty texts", () => {
    const result = diffLines("", "");
    expect(result.lines).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("caps each side at the line limit and says it did", () => {
    const longBefore = Array.from({ length: DIFF_MAX_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
    const longAfter = `${longBefore}\nextra`;
    const result = diffLines(longBefore, longAfter);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(DIFF_MAX_LINES);
    expect(result.added + result.removed).toBe(0);
  });

  it("does not call a text of exactly the limit truncated", () => {
    const exact = Array.from({ length: DIFF_MAX_LINES }, (_, index) => `line ${index}`).join("\n");
    expect(diffLines(exact, exact).truncated).toBe(false);
  });

  it("takes a custom limit", () => {
    const result = diffLines("1\n2\n3\n4\n", "1\n2\n3\n5\n", 2);
    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual([same("1"), same("2")]);
  });

  it("diffs two completely different 2000-line texts within its bound", () => {
    const before = Array.from({ length: DIFF_MAX_LINES }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: DIFF_MAX_LINES }, (_, index) => `new ${index}`).join("\n");
    const started = Date.now();
    const result = diffLines(before, after);
    expect(result.removed).toBe(DIFF_MAX_LINES);
    expect(result.added).toBe(DIFF_MAX_LINES);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("foldUnchanged", () => {
  const numbered = (count: number, prefix: string): DiffLine[] =>
    Array.from({ length: count }, (_, index) => same(`${prefix}${index}`));

  it("folds a long unchanged run between two changes, keeping the context on both sides", () => {
    const lines = [remove("x"), ...numbered(10, "m"), add("y")];
    expect(foldUnchanged(lines, 2)).toEqual([
      remove("x"),
      same("m0"),
      same("m1"),
      { kind: "gap", count: 6 },
      same("m8"),
      same("m9"),
      add("y"),
    ]);
  });

  it("keeps only the lines next to a change at the start and the end of the file", () => {
    const lines = [...numbered(10, "a"), remove("x"), ...numbered(10, "b")];
    expect(foldUnchanged(lines, 2)).toEqual([
      { kind: "gap", count: 8 },
      same("a8"),
      same("a9"),
      remove("x"),
      same("b0"),
      same("b1"),
      { kind: "gap", count: 8 },
    ]);
  });

  it("draws a run whole when folding it would hide a single line", () => {
    const lines = [remove("x"), ...numbered(5, "m"), add("y")];
    expect(foldUnchanged(lines, 2)).toEqual(lines);
  });

  it("folds a file with no change into one gap, and leaves a one-line file alone", () => {
    expect(foldUnchanged(numbered(8, "s"), 3)).toEqual([{ kind: "gap", count: 8 }]);
    expect(foldUnchanged(numbered(1, "s"), 3)).toEqual([same("s0")]);
  });

  it("returns every line of an all-change diff", () => {
    const lines = [add("a"), add("b"), add("c")];
    expect(foldUnchanged(lines)).toEqual(lines);
  });
});
