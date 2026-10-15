import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DocBlock } from "@/lib/docs-client";
import { joinBlocks, sectionInputOf, splitBlocks } from "@/lib/doc-section-text";

const here = dirname(fileURLToPath(import.meta.url));

const TABLE_A: DocBlock = {
  type: "table",
  columns: ["Plan", "Now"],
  rows: [
    ["Basic", 12],
    ["Pro", null],
  ],
};

const TABLE_B: DocBlock = { type: "table", columns: ["Region"], rows: [["ID"]] };

function roundTrip(blocks: readonly DocBlock[]): DocBlock[] {
  const split = splitBlocks(blocks);
  return joinBlocks(split.text, split.tables);
}

function textOf(blocks: readonly DocBlock[]): string {
  return splitBlocks(blocks).text;
}

describe("exact: blocks to text and back", () => {
  it("keeps paragraphs, lists, a quote and a page break in order", () => {
    const blocks: DocBlock[] = [
      { type: "paragraph", text: "One." },
      { type: "paragraph", text: "Two\nmore" },
      { type: "bullets", items: ["a", "b"] },
      { type: "numbered", items: ["x", "y"] },
      { type: "quote", text: "Quoted." },
      { type: "pageBreak" },
      { type: "paragraph", text: "End." },
    ];
    expect(textOf(blocks)).toBe("One.\n\nTwo\nmore\n\n- a\n- b\n\n1. x\n2. y\n\n> Quoted.\n\n---\n\nEnd.");
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("escapes a paragraph line that would read as a marker, and only that", () => {
    const blocks: DocBlock[] = [
      { type: "paragraph", text: ["- dash", "1. step", "> quoted", "---", "\\back", "-", ">", "--x"].join("\n") },
    ];
    expect(textOf(blocks).split("\n")).toEqual([
      "\\- dash",
      "\\1. step",
      "\\> quoted",
      "\\---",
      "\\\\back",
      "\\-",
      "\\>",
      "--x",
    ]);
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("keeps an empty paragraph, an inner blank line and a whitespace-only line", () => {
    const blocks: DocBlock[] = [
      { type: "paragraph", text: "" },
      { type: "paragraph", text: "a\n\nb\n   \nc" },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("keeps list items with empty, multi-line and blank-line content", () => {
    const blocks: DocBlock[] = [
      { type: "bullets", items: ["", "one\ntwo", "a\n\nb"] },
      { type: "numbered", items: ["", "x"] },
      { type: "quote", text: "first\n\nlast" },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("keeps adjacent lists and quotes as separate blocks", () => {
    const blocks: DocBlock[] = [
      { type: "bullets", items: ["a"] },
      { type: "bullets", items: ["b"] },
      { type: "quote", text: "x" },
      { type: "quote", text: "y" },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("keeps every table where it sits among the text blocks, and leaves tables out of the text", () => {
    const blocks: DocBlock[] = [{ type: "paragraph", text: "p1" }, TABLE_A, { type: "paragraph", text: "p2" }, TABLE_B];
    expect(textOf(blocks)).toBe("p1\n\np2");
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("keeps a table first, last, alone, or next to another table", () => {
    const cases: DocBlock[][] = [
      [TABLE_A, { type: "paragraph", text: "p" }],
      [{ type: "paragraph", text: "p" }, TABLE_A],
      [TABLE_A, TABLE_B],
      [TABLE_A],
      [{ type: "paragraph", text: "p" }, TABLE_A, TABLE_B, { type: "paragraph", text: "q" }],
      [],
    ];
    for (const blocks of cases) {
      expect(roundTrip(blocks)).toEqual(blocks);
    }
    expect(textOf([TABLE_A])).toBe("");
  });
});

describe("idempotent: text to blocks and back", () => {
  it("keeps canonical text exactly", () => {
    const text = "a\n\n- b\n- c\n\n> q\n\n---\n\n\\- literal\n\n1. one\n2. two";
    expect(textOf(joinBlocks(text, []))).toBe(text);
  });

  it("settles a list that follows a paragraph without a blank line after one save", () => {
    const once = textOf(joinBlocks("Intro\n- one\n- two", []));
    expect(once).toBe("Intro\n\n- one\n- two");
    expect(textOf(joinBlocks(once, []))).toBe(once);
  });

  it("reads CRLF line endings as LF", () => {
    expect(textOf(joinBlocks("a\r\n\r\nb", []))).toBe("a\n\nb");
  });
});

describe("reading the text", () => {
  it("renumbers a numbered list on save", () => {
    expect(joinBlocks("5. a\n9. b", [])).toEqual([{ type: "numbered", items: ["a", "b"] }]);
    expect(textOf(joinBlocks("5. a\n9. b", []))).toBe("1. a\n2. b");
  });

  it("reads a lone dash as an empty bullet", () => {
    expect(joinBlocks("-", [])).toEqual([{ type: "bullets", items: [""] }]);
  });

  it("reads two leading spaces as the continuation of the previous list item", () => {
    expect(joinBlocks("- one\n  more", [])).toEqual([{ type: "bullets", items: ["one\nmore"] }]);
  });

  it("reads a lone backslash line as an empty paragraph", () => {
    expect(joinBlocks("\\", [])).toEqual([{ type: "paragraph", text: "" }]);
  });

  it("has no blocks in blank text", () => {
    expect(joinBlocks("", [])).toEqual([]);
    expect(joinBlocks("\n\n\n", [])).toEqual([]);
  });

  it("keeps a table in its place when text blocks are removed", () => {
    const original: DocBlock[] = [{ type: "paragraph", text: "p1" }, TABLE_A, { type: "paragraph", text: "p2" }];
    const split = splitBlocks(original);
    expect(joinBlocks("p2 only", split.tables)).toEqual([{ type: "paragraph", text: "p2 only" }, TABLE_A]);
    expect(joinBlocks("", split.tables)).toEqual([TABLE_A]);
  });

  it("keeps a table right after the same number of text blocks before it", () => {
    const original: DocBlock[] = [{ type: "paragraph", text: "p1" }, TABLE_A, { type: "paragraph", text: "p2" }];
    const split = splitBlocks(original);
    expect(joinBlocks("p1\n\nnew\n\np2", split.tables)).toEqual([
      { type: "paragraph", text: "p1" },
      TABLE_A,
      { type: "paragraph", text: "new" },
      { type: "paragraph", text: "p2" },
    ]);
  });
});

describe("section input", () => {
  it("leaves the heading out when it is blank", () => {
    const input = sectionInputOf("   ", "x", []);
    expect("heading" in input).toBe(false);
    expect(input.blocks).toEqual([{ type: "paragraph", text: "x" }]);
  });

  it("keeps a heading that has words in it", () => {
    expect(sectionInputOf("1. Summary", "x", []).heading).toBe("1. Summary");
  });
});

describe("the mapping names no brand", () => {
  it("holds no Nultron in the module source", () => {
    const source = readFileSync(resolve(here, "doc-section-text.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("nultron");
  });
});
