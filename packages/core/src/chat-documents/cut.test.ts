import { describe, expect, it } from "vitest";
import { CHAT_TEXT_ATTACHMENT_MAX_CHARS, cutNoteLine, cutOnLine, cutTextAttachment, isHostNoteLine } from "./index";

describe("cutOnLine", () => {
  it("leaves a text that fits alone", () => {
    expect(cutOnLine("one\ntwo", 100)).toEqual({ text: "one\ntwo", cut: false });
    expect(cutOnLine("exact", 5)).toEqual({ text: "exact", cut: false });
  });

  it("cuts at the last line break inside the limit, never mid-line", () => {
    expect(cutOnLine("alpha\nbeta\ngamma", 12)).toEqual({ text: "alpha\nbeta", cut: true });
  });

  it("cuts mid-line only when the first line is longer than the limit", () => {
    expect(cutOnLine("abcdefghij\nnext", 4)).toEqual({ text: "abcd", cut: true });
  });

  it("never leaves half a surrogate pair at the cut", () => {
    const grin = "\u{1F600}";
    const cut = cutOnLine(`${grin}${grin}${grin}`, 3);
    expect(cut.cut).toBe(true);
    expect(cut.text).toBe(`${grin}`);
    expect(cut.text.charCodeAt(cut.text.length - 1)).not.toBe(0xd83d);
  });
});

describe("cutNoteLine", () => {
  it("says how much follows, in the host's voice", () => {
    const note = cutNoteLine(60_000, 340_000, "The rest was not kept.");
    expect(note).toBe("[Cut: only the first 60,000 of 340,000 characters follow. The rest was not kept.]");
    expect(isHostNoteLine(note)).toBe(true);
  });
});

describe("cutTextAttachment", () => {
  it("changes nothing for a text file inside the budget", () => {
    expect(cutTextAttachment("a,b\n1,2")).toEqual({ notes: "", text: "a,b\n1,2", cut: false });
  });

  it("holds a text file to the same budget a document has", () => {
    const line = `${"x".repeat(99)}\n`;
    const big = line.repeat(Math.ceil((CHAT_TEXT_ATTACHMENT_MAX_CHARS * 2) / line.length));
    const result = cutTextAttachment(big);
    expect(result.cut).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(CHAT_TEXT_ATTACHMENT_MAX_CHARS);
    expect(big.startsWith(result.text)).toBe(true);
    // On a line boundary: what was cut off starts with a line break.
    expect(big.charAt(result.text.length)).toBe("\n");
  });

  it("says so above the block, once, and that the rest was not kept", () => {
    const big = "word ".repeat(CHAT_TEXT_ATTACHMENT_MAX_CHARS);
    const result = cutTextAttachment(`${big}\nend`);
    const lines = result.notes.split("\n");
    expect(result.notes.endsWith("\n\n")).toBe(true);
    expect(lines.filter((line) => line !== "")).toHaveLength(1);
    expect(isHostNoteLine(lines[0] ?? "")).toBe(true);
    expect(result.notes).toContain("The rest was not kept.");
    expect(result.notes).toContain(`of ${(big.length + 4).toLocaleString("en-US")} characters`);
  });

  it("takes a smaller budget when asked", () => {
    const result = cutTextAttachment("one\ntwo\nthree", 8);
    expect(result.text).toBe("one\ntwo");
    expect(result.cut).toBe(true);
  });
});
