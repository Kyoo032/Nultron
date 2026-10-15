import { describe, expect, it } from "vitest";
import type { DocSection } from "@/lib/docs-client";
import { diffSections, diffWords, sectionPlainText, type DiffSegment } from "@/lib/doc-word-diff";

function beforeText(segments: readonly DiffSegment[]): string {
  return segments
    .filter((segment) => segment.kind !== "added")
    .map((segment) => segment.text)
    .join("");
}

function afterText(segments: readonly DiffSegment[]): string {
  return segments
    .filter((segment) => segment.kind !== "removed")
    .map((segment) => segment.text)
    .join("");
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomText(next: () => number, words: number): string {
  const vocabulary = ["alpha", "beta", "gamma", "delta", "pro", "basic"];
  const separators = [" ", "  ", "\n", " \n", "\t"];
  let text = "";
  for (let index = 0; index < words; index += 1) {
    const word = vocabulary[Math.floor(next() * vocabulary.length)];
    const separator = separators[Math.floor(next() * separators.length)];
    text += `${word}${separator}`;
  }
  return text;
}

describe("diffWords", () => {
  it("returns one same segment for identical text", () => {
    expect(diffWords("Keep the rest.", "Keep the rest.")).toEqual([{ kind: "same", text: "Keep the rest." }]);
  });

  it("marks one replaced word as removed then added, around the unchanged words", () => {
    expect(diffWords("the cat sat", "the dog sat")).toEqual([
      { kind: "same", text: "the " },
      { kind: "removed", text: "cat " },
      { kind: "added", text: "dog " },
      { kind: "same", text: "sat" },
    ]);
  });

  it("returns only added text when the old text is empty", () => {
    expect(diffWords("", "New text.")).toEqual([{ kind: "added", text: "New text." }]);
  });

  it("returns only removed text when the new text is empty", () => {
    expect(diffWords("Old text.", "")).toEqual([{ kind: "removed", text: "Old text." }]);
  });

  it("returns nothing when both sides are empty", () => {
    expect(diffWords("", "")).toEqual([]);
  });

  it("keeps newlines and spacing exactly, so a rebuilt text matches", () => {
    const before = "First line.\nSecond  line.";
    const after = "First line.\nSecond line, shorter.";
    const segments = diffWords(before, after);
    expect(beforeText(segments)).toBe(before);
    expect(afterText(segments)).toBe(after);
  });

  it("rebuilds both sides exactly for seeded random pairs", () => {
    const next = seeded(20261015);
    for (let round = 0; round < 200; round += 1) {
      const before = randomText(next, Math.floor(next() * 40));
      const after = randomText(next, Math.floor(next() * 40));
      const segments = diffWords(before, after);
      expect(beforeText(segments), `before, round ${round}`).toBe(before);
      expect(afterText(segments), `after, round ${round}`).toBe(after);
    }
  });

  it("falls back to all removed then all added for very large sides, and still rebuilds both", () => {
    const before = Array.from({ length: 1500 }, (_, index) => `old${index} `).join("");
    const after = Array.from({ length: 1500 }, (_, index) => `new${index} `).join("");
    const segments = diffWords(before, after);
    expect(segments).toEqual([
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ]);
    expect(beforeText(segments)).toBe(before);
    expect(afterText(segments)).toBe(after);
  });
});

const CURRENT: DocSection = {
  id: "s2",
  heading: "2. What competitors charge",
  blocks: [
    { type: "paragraph", text: "Competitors charge roughly the same." },
    { type: "bullets", items: ["Basic", "Pro"] },
  ],
};

describe("sectionPlainText", () => {
  it("joins blocks as lines and leaves the heading out", () => {
    expect(sectionPlainText(CURRENT)).toBe("Competitors charge roughly the same.\nBasic\nPro");
  });

  it("flattens a table to pipe-separated rows and reads a missing cell as empty", () => {
    const section: DocSection = {
      id: "s3",
      heading: null,
      blocks: [
        {
          type: "table",
          columns: ["Plan", "Now"],
          rows: [
            ["Basic", 12],
            ["Pro", null],
          ],
        },
        { type: "pageBreak" },
        { type: "quote", text: "Keep it simple." },
      ],
    };
    expect(sectionPlainText(section)).toBe("Plan | Now\nBasic | 12\nPro | \nKeep it simple.");
  });
});

describe("diffSections", () => {
  it("diffs a proposed section against the current one, word by word", () => {
    const proposed: DocSection = {
      id: "s2",
      heading: "2. What competitors charge",
      blocks: [
        { type: "paragraph", text: "Competitor A lists Pro at 49 and Competitor B at 52." },
        { type: "bullets", items: ["Basic", "Pro"] },
      ],
    };
    const segments = diffSections(CURRENT, proposed);
    expect(segments.find((segment) => segment.kind === "removed")?.text).toContain("Competitors");
    expect(segments.find((segment) => segment.kind === "added")?.text).toContain("Competitor A");
    expect(beforeText(segments)).toBe(sectionPlainText(CURRENT));
    expect(afterText(segments)).toBe(sectionPlainText(proposed));
  });

  it("is all same when the proposal changes nothing", () => {
    expect(diffSections(CURRENT, CURRENT)).toEqual([{ kind: "same", text: sectionPlainText(CURRENT) }]);
  });
});
