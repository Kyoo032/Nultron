import { describe, expect, it } from "vitest";
import { FileExtractError } from "../file-extract";
import { docSpecFromDocx, docSpecFromPdf } from "./import-docx";
import { renderDocx } from "./render-docx";
import { sampleDoc } from "./fixtures";

describe("docSpecFromDocx", () => {
  it("reads a rendered Word file back: section headings and paragraph texts match", async () => {
    const original = sampleDoc("corporate");
    const bytes = await renderDocx(original);
    const imported = await docSpecFromDocx(bytes);

    const headings = imported.sections.map((section) => section.heading).filter((heading) => heading !== undefined);
    expect(headings).toEqual(original.sections.map((section) => section.heading));

    const paragraphTexts = imported.sections
      .flatMap((section) => section.blocks)
      .flatMap((block) => (block.type === "paragraph" ? [block.text] : []));
    expect(paragraphTexts.some((text) => text.includes("This review covers"))).toBe(true);
    expect(paragraphTexts.some((text) => text.includes("Revenue rose 12%") || text.includes("Costs held flat"))).toBe(
      true,
    );
  });

  it("refuses a file that is not a Word file with a typed error", async () => {
    const garbage = new TextEncoder().encode("this is plainly not a zip container");
    const error = await docSpecFromDocx(garbage).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FileExtractError);
    expect((error as FileExtractError).code).toBe("format_mismatch");
  });

  it("refuses an empty file before any parsing", async () => {
    const error = await docSpecFromDocx(new Uint8Array(0)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FileExtractError);
    expect((error as FileExtractError).code).toBe("empty");
  });
});

describe("docSpecFromPdf", () => {
  it("refuses bytes that are not a PDF with a typed error", async () => {
    const garbage = new TextEncoder().encode("not a pdf at all");
    const error = await docSpecFromPdf(garbage).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(FileExtractError);
  });
});
