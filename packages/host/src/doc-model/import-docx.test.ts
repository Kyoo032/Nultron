import { describe, expect, it } from "vitest";
import { FileExtractError, type AnydocModule } from "../file-extract";
import { docSpecFromDocx, docSpecFromPdf } from "./import-docx";
import { ODD_TEXT, sampleDoc } from "./fixtures";
import { renderDocx } from "./render-docx";
import { renderPdf } from "./render-pdf";
import type { Block, DocSpec } from "./types";

function headingsOf(spec: DocSpec): Array<string | undefined> {
  return spec.sections.map((section) => section.heading);
}

function blocksOf<T extends Block["type"]>(spec: DocSpec, type: T): Array<Extract<Block, { type: T }>> {
  return spec.sections
    .flatMap((section) => section.blocks)
    .filter((block): block is Extract<Block, { type: T }> => block.type === type);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

/** A converter that is present but reports the file as a scan, the way a real one does. */
function scanningConverter(): AnydocModule {
  return {
    formatFromBytes: () => "pdf",
    formatFromExtension: () => "pdf",
    toMarkdownBytes: () => Promise.reject(Object.assign(new Error("scanned pages"), { code: "needsOcr" })),
  };
}

describe("docSpecFromDocx", () => {
  it("reads a rendered Word file back: section headings, title and paragraph texts match", async () => {
    const original = sampleDoc("corporate");
    const imported = await docSpecFromDocx(await renderDocx(original));

    expect(imported.title).toBe(original.title);
    expect(headingsOf(imported)).toEqual(original.sections.map((section) => section.heading));

    const paragraphs = blocksOf(imported, "paragraph").map((block) => block.text);
    expect(paragraphs).toContain("This review covers **three** months of *steady* work.");
    expect(paragraphs).toContain(ODD_TEXT);
    // The renderer's quote is read back as an italic paragraph, which is the honest reading of it.
    expect(paragraphs).toContain("*Small, steady steps beat big promises.*");
  });

  it("reads bullets, numbered items and the table as the blocks they were", async () => {
    const imported = await docSpecFromDocx(await renderDocx(sampleDoc("corporate")));

    expect(blocksOf(imported, "bullets").map((block) => block.items)).toEqual([
      ["Revenue rose 12%", "Costs held flat"],
    ]);
    expect(blocksOf(imported, "numbered").map((block) => block.items)).toEqual([
      ["Hire two analysts", "Close the Jakarta office review"],
    ]);
    const [table] = blocksOf(imported, "table");
    expect(table.columns).toEqual(["Region", "Revenue", "Share"]);
    expect(table.rows[0]).toEqual(["Jakarta", "120000", "45%"]);
  });

  it("is stable on a second round: importing a rendered import keeps the same sections", async () => {
    const first = await docSpecFromDocx(await renderDocx(sampleDoc("corporate")));
    const second = await docSpecFromDocx(await renderDocx(first));

    expect(second.title).toBe(first.title);
    expect(second.sections.length).toBe(first.sections.length);
    expect(headingsOf(second)).toEqual(headingsOf(first));
    expect(second.sections.map((section) => section.id)).toEqual(first.sections.map((section) => section.id));
  });

  it("refuses a file that is not a Word file with a typed error", async () => {
    const garbage = new TextEncoder().encode("this is plainly not a zip container");
    const error = await rejectionOf(docSpecFromDocx(garbage));
    expect(error).toBeInstanceOf(FileExtractError);
    expect((error as FileExtractError).code).toBe("format_mismatch");
  });

  it("refuses an empty file before any parsing", async () => {
    const error = await rejectionOf(docSpecFromDocx(new Uint8Array(0)));
    expect(error).toBeInstanceOf(FileExtractError);
    expect((error as FileExtractError).code).toBe("empty");
  });
});

describe("docSpecFromPdf", () => {
  it("reads a rendered PDF back: the section headings and the paragraph text survive", async () => {
    const original = sampleDoc("corporate");
    const imported = await docSpecFromPdf(await renderPdf(original));

    const everything = JSON.stringify(imported.sections);
    for (const section of original.sections) {
      if (section.heading !== undefined) {
        expect(everything).toContain(section.heading);
      }
    }
    expect(everything).toContain("Costs held flat");
    expect(everything).toContain("Jakarta");
  });

  it("refuses bytes that are not a PDF with a typed error", async () => {
    const error = await rejectionOf(docSpecFromPdf(new TextEncoder().encode("not a pdf at all")));
    expect(error).toBeInstanceOf(FileExtractError);
  });

  it("passes a scanned PDF through as needs_ocr, with nothing sent anywhere", async () => {
    const scan = new TextEncoder().encode("%PDF-1.4\n% a scanned page\n");
    const error = await rejectionOf(docSpecFromPdf(scan, { extract: { loadAnydoc: scanningConverter } }));
    expect(error).toBeInstanceOf(FileExtractError);
    expect((error as FileExtractError).code).toBe("needs_ocr");
  });
});
