import { describe, expect, it } from "vitest";
import { docSpecFromMarkdown } from "./import-markdown";
import { DocModelError } from "./errors";

const SAMPLE = [
  "Intro line before any heading.",
  "",
  "# Summary",
  "",
  "Para one",
  "continued here.",
  "",
  "## Plan",
  "",
  "- first point",
  "* second point",
  "",
  "1. hire",
  "2. review",
  "",
  "> Small steps",
  "> beat promises.",
  "",
  "| Region | Revenue |",
  "| --- | ---: |",
  "| Jakarta | 120 |",
  "| Surabaya | 98 |",
  "",
  "---",
  "",
  "# Notes",
  "",
  "Last words.",
].join("\n");

describe("docSpecFromMarkdown", () => {
  it("starts a section at each # or ## heading, ids s1, s2, ... in order", () => {
    const spec = docSpecFromMarkdown(SAMPLE);
    expect(spec.sections.map((section) => section.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(spec.sections.map((section) => section.heading)).toEqual([undefined, "Summary", "Plan", "Notes"]);
  });

  it("keeps the text before the first heading as a section with no heading", () => {
    const spec = docSpecFromMarkdown(SAMPLE);
    expect(spec.sections[0].blocks).toEqual([{ type: "paragraph", text: "Intro line before any heading." }]);
  });

  it("joins soft-wrapped lines into one paragraph", () => {
    const spec = docSpecFromMarkdown(SAMPLE);
    expect(spec.sections[1].blocks[0]).toEqual({ type: "paragraph", text: "Para one continued here." });
  });

  it("reads bullets, numbered lists, quotes and a pipe table in order", () => {
    const blocks = docSpecFromMarkdown(SAMPLE).sections[2].blocks;
    expect(blocks[0]).toEqual({ type: "bullets", items: ["first point", "second point"] });
    expect(blocks[1]).toEqual({ type: "numbered", items: ["hire", "review"] });
    expect(blocks[2]).toEqual({ type: "quote", text: "Small steps beat promises." });
    expect(blocks[3]).toEqual({
      type: "table",
      columns: ["Region", "Revenue"],
      rows: [
        ["Jakarta", "120"],
        ["Surabaya", "98"],
      ],
    });
  });

  it("turns a --- that stands alone between two sections into a page break", () => {
    const blocks = docSpecFromMarkdown(SAMPLE).sections[2].blocks;
    expect(blocks[blocks.length - 1]).toEqual({ type: "pageBreak" });
    expect(blocks.filter((block) => block.type === "pageBreak")).toHaveLength(1);
  });

  it("ignores a --- that is not between sections", () => {
    const spec = docSpecFromMarkdown("Text one\n\n---\n\nText two");
    expect(spec.sections).toHaveLength(1);
    expect(spec.sections[0].blocks).toEqual([
      { type: "paragraph", text: "Text one" },
      { type: "paragraph", text: "Text two" },
    ]);
  });

  it("takes the title from the option, then the first heading, then a default", () => {
    expect(docSpecFromMarkdown(SAMPLE, { title: "Report" }).title).toBe("Report");
    expect(docSpecFromMarkdown(SAMPLE).title).toBe("Summary");
    expect(docSpecFromMarkdown("Just text").title).toBe("Imported document");
  });

  it("keeps an escaped pipe inside a cell and pads a short row", () => {
    const spec = docSpecFromMarkdown("## Data\n\n| a | b |\n| --- | --- |\n| x \\| y | only |\n| solo |\n");
    const table = spec.sections[0].blocks[0];
    expect(table).toEqual({
      type: "table",
      columns: ["a", "b"],
      rows: [
        ["x | y", "only"],
        ["solo", ""],
      ],
    });
  });

  it("refuses a document over the section cap with a clear message", () => {
    const markdown = Array.from({ length: 201 }, (_, index) => `# Part ${index + 1}\n\nBody`).join("\n\n");
    expect(() => docSpecFromMarkdown(markdown)).toThrow(DocModelError);
    expect(() => docSpecFromMarkdown(markdown)).toThrow(/sections: 201 sent, the limit is 200/);
  });
});
