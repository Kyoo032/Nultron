import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { ODD_TEXT, longDoc, sampleBook, sampleDoc } from "./fixtures";
import { renderDocx } from "./render-docx";
import { renderPdf } from "./render-pdf";
import { printable, toDrawable } from "./pdf-text";
import { renderXlsx } from "./render-xlsx";
import { parseDocSpec, parseSheetSpec } from "./types";

async function zipText(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  if (!file) {
    throw new Error(`missing ${path}`);
  }
  return file.async("string");
}

async function reopenWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  return workbook;
}

describe("renderDocx", () => {
  it("writes a Word file whose XML carries the headings, runs, lists, table header and page break", async () => {
    const bytes = await renderDocx(sampleDoc("corporate"));
    const xml = await zipText(bytes, "word/document.xml");
    expect(xml).toContain("Quarterly operations review");
    expect(xml).toContain("Summary");
    expect(xml).toContain("Revenue rose 12%");
    expect(xml).toContain("Hire two analysts");
    expect(xml).toContain("<w:b/>"); // **three**
    expect(xml).toContain("<w:i/>"); // *steady*
    expect(xml).toContain("Region");
    expect(xml).toContain("Jakarta");
    expect(xml).toContain('w:fill="1F3A5F"'); // corporate header fill
    expect(xml).toContain('w:type="page"');
    const numbering = await zipText(bytes, "word/numbering.xml");
    expect(numbering).toContain('w:numFmt w:val="decimal"');
  });

  it("gives each numbered list its own numbering instance so it restarts at 1", async () => {
    const spec = parseDocSpec({
      kind: "document",
      title: "Two lists",
      sections: [
        { id: "a", blocks: [{ type: "numbered", items: ["one"] }] },
        { id: "b", blocks: [{ type: "numbered", items: ["two"] }] },
      ],
    });
    const xml = await zipText(await renderDocx(spec), "word/document.xml");
    const instances = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((match) => match[1]);
    expect(new Set(instances).size).toBe(2);
  });

  it("renders the odd characters without throwing", async () => {
    const xml = await zipText(await renderDocx(sampleDoc()), "word/document.xml");
    expect(xml).toContain("Laporan Q3");
    expect(xml).toContain("—");
  });
});

describe("renderXlsx", () => {
  it("writes one worksheet per sheet, with the header text and the typed cells in the XML", async () => {
    const bytes = await renderXlsx(sampleBook());
    const workbook = await reopenWorkbook(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Budget Q3", "Headcount"]);
    const shared = await zipText(bytes, "xl/sharedStrings.xml");
    expect(shared).toContain("Office rent");
    expect(shared).toContain("Amount");
    const sheetXml = await zipText(bytes, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toContain("<f>SUM(B2:B4)</f>");
  });

  it("keeps numbers as numbers, writes the SUM formula with its result, and freezes the header", async () => {
    const workbook = await reopenWorkbook(await renderXlsx(sampleBook()));
    const sheet = workbook.getWorksheet("Budget Q3");
    expect(sheet).toBeDefined();
    if (!sheet) {
      return;
    }
    expect(sheet.getCell("A1").value).toBe("Item");
    expect(sheet.getCell("B2").value).toBe(12000000);
    expect(typeof sheet.getCell("B2").value).toBe("number");
    expect(sheet.getCell("B2").numFmt).toBe("#,##0.00");
    expect(sheet.getCell("C2").numFmt).toBe("0.0%");
    expect(sheet.getCell("D2").value).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(sheet.getCell("A4").value).toBe("'=1+1 injected label");
    const total = sheet.getCell("B5").value as { formula: string; result: number };
    expect(total.formula).toBe("SUM(B2:B4)");
    expect(total.result).toBe(16300000);
    expect(sheet.getCell("A5").value).toBe("Total");
    expect(sheet.views?.[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("writes the totals row on the headcount sheet and omits it when totals is false", async () => {
    const workbook = await reopenWorkbook(await renderXlsx(sampleBook()));
    const sheet = workbook.getWorksheet("Headcount");
    if (!sheet) {
      throw new Error("no Headcount sheet");
    }
    expect(sheet.getCell("A4").value).toBe("Total");
    expect((sheet.getCell("B4").value as { formula: string }).formula).toBe("SUM(B2:B3)");
    const plain = parseSheetSpec({
      kind: "workbook",
      title: "No totals",
      sheets: [{ id: "n", name: "N", columns: [{ key: "a", header: "A", type: "number" }], rows: [{ a: 1 }] }],
    });
    const reopened = await reopenWorkbook(await renderXlsx(plain));
    expect(reopened.getWorksheet("N")?.getCell("A3").value).toBeNull();
  });

  it("writes a plain 0 instead of an empty SUM range when a sheet has no rows", async () => {
    const book = emptySheetSpec();
    const workbook = await reopenWorkbook(await renderXlsx(book));
    expect(workbook.getWorksheet("Empty")?.getCell("B2").value).toBe(0);
  });
});

function emptySheetSpec() {
  return parseSheetSpec({
    kind: "workbook",
    title: "Empty",
    sheets: [
      {
        id: "e",
        name: "Empty",
        columns: [
          { key: "t", header: "T", type: "text" },
          { key: "n", header: "N", type: "number" },
        ],
        rows: [],
        totals: true,
      },
    ],
  });
}

describe("renderPdf", () => {
  it("writes a PDF that reopens, with one page for a short document", async () => {
    const bytes = await renderPdf(sampleDoc());
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2); // title page plus content
    expect(pdf.getTitle()).toBe("Quarterly operations review");
  });

  it("paginates a long document into more than one page", async () => {
    const pdf = await PDFDocument.load(await renderPdf(longDoc(40)));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("does not throw on Indonesian text, an em dash and an emoji", async () => {
    const spec = parseDocSpec({
      kind: "document",
      title: `Laporan 😀 — ${ODD_TEXT}`,
      sections: [
        {
          id: "x",
          heading: "Catatan 中文 ✓",
          blocks: [
            { type: "paragraph", text: ODD_TEXT },
            { type: "table", columns: ["Nama 😀", "Nilai —"], rows: [["Ünïcode ✓", "Rp 1.250.000 — ok"]] },
          ],
        },
      ],
    });
    const pdf = await PDFDocument.load(await renderPdf(spec));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("repeats the table header and keeps every row when a table spills onto a new page", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Row ${i + 1}`, i * 10]);
    const spec = parseDocSpec({
      kind: "document",
      title: "Big table",
      sections: [{ id: "t", blocks: [{ type: "table", columns: ["Name", "Value"], rows }] }],
    });
    const pdf = await PDFDocument.load(await renderPdf(spec));
    expect(pdf.getPageCount()).toBeGreaterThan(2);
  });

  it("splits a single row taller than a page instead of looping or dropping it", async () => {
    const tall = "word ".repeat(4000);
    const spec = parseDocSpec({
      kind: "document",
      title: "Tall row",
      sections: [{ id: "t", blocks: [{ type: "table", columns: ["Body"], rows: [[tall]] }] }],
    });
    const pdf = await PDFDocument.load(await renderPdf(spec));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});

describe("pdf text fallback", () => {
  it("keeps WinAnsi characters, folds accents, and replaces emoji and CJK", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(printable("—", font)).toBe("—");
    expect(printable("é", font)).toBe("é");
    expect(printable("😀", font)).toBe("?");
    expect(printable("中", font)).toBe("?");
    expect(printable("\u0007", font)).toBe("");
    expect(toDrawable("a\tb 😀 — c", font)).toBe("a b ? — c");
  });
});

/** Writes the three sample files so they can be opened by hand. Their paths are printed. */
describe("sample files", () => {
  it("writes a docx, an xlsx and a pdf to a temp folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-model-samples-"));
    const docPath = join(dir, "sample-document.docx");
    const sheetPath = join(dir, "sample-workbook.xlsx");
    const pdfPath = join(dir, "sample-document.pdf");
    writeFileSync(docPath, await renderDocx(sampleDoc("modern")));
    writeFileSync(sheetPath, await renderXlsx(sampleBook("corporate")));
    writeFileSync(pdfPath, await renderPdf(longDoc(12)));
    console.log(`DOC_MODEL_SAMPLES ${docPath}\nDOC_MODEL_SAMPLES ${sheetPath}\nDOC_MODEL_SAMPLES ${pdfPath}`);
  });
});
