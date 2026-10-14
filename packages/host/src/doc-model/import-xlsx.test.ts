import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { FILE_EXTRACT_MAX_TABLE_COLS } from "../file-extract/limits";
import { DocModelError } from "./errors";
import { sampleBook } from "./fixtures";
import { renderXlsx } from "./render-xlsx";
import { sheetSpecFromXlsx } from "./import-xlsx";

async function workbookBytes(build: (book: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  build(book);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

describe("sheetSpecFromXlsx", () => {
  it("reads a rendered workbook back: headers, types and numbers match, and the totals row is kept as totals", async () => {
    const imported = await sheetSpecFromXlsx(await renderXlsx(sampleBook()));

    const [budget, headcount] = imported.sheets;
    expect(budget.name).toBe("Budget Q3");
    expect(budget.columns.map((column) => column.header)).toEqual(["Item", "Amount", "Share", "Due"]);
    expect(budget.columns.map((column) => column.type)).toEqual(["text", "number", "percent", "date"]);
    // The rendered totals row is not a data row: it comes back as the sheet's totals flag.
    expect(budget.rows).toHaveLength(3);
    expect(budget.totals).toBe(true);
    expect(budget.rows[0]).toEqual({ col1: "Office rent", col2: 12000000, col3: 0.4, col4: "2026-10-01" });
    expect(headcount.rows).toEqual([
      { col1: "Sales", col2: 4 },
      { col1: "Operations", col2: 3 },
    ]);
    expect(headcount.totals).toBe(true);
    expect(imported.sheets.map((sheet) => sheet.name)).toEqual(["Budget Q3", "Headcount"]);
  });

  it("keeps the escaped formula-looking label readable, without its escape apostrophe", async () => {
    const imported = await sheetSpecFromXlsx(await renderXlsx(sampleBook()));
    expect(imported.sheets[0].rows[2].col1).toBe("=1+1 injected label");
  });

  it("reads a formula as its cached value", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Calc");
      sheet.addRow(["Base", "Double"]);
      sheet.addRow([5, { formula: "A2*2", result: 10 }]);
    });
    const imported = await sheetSpecFromXlsx(bytes);
    expect(imported.sheets[0].rows).toEqual([{ col1: 5, col2: 10 }]);
    expect(imported.sheets[0].columns[1].type).toBe("number");
  });

  it("drops empty trailing rows and reads a percent-formatted column as percent", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Share");
      sheet.addRow(["Team", "Share"]);
      sheet.addRow(["A", 0.25]);
      sheet.getCell("B2").numFmt = "0.0%";
      sheet.addRow(["B", 0.75]);
      sheet.getCell("B3").numFmt = "0.0%";
      sheet.getRow(7).font = { bold: true };
    });
    const imported = await sheetSpecFromXlsx(bytes);
    expect(imported.sheets[0].rows).toHaveLength(2);
    expect(imported.sheets[0].columns[1].type).toBe("percent");
    expect(imported.sheets[0].totals).toBe(false);
  });

  it("reads a vertically merged data cell once: the covered cell is empty, not repeated", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Merged");
      sheet.addRow(["Group", "Score"]);
      sheet.addRow(["x", 1]);
      sheet.addRow([null, 2]);
      sheet.mergeCells("A2:A3");
    });
    const [only] = (await sheetSpecFromXlsx(bytes)).sheets;
    expect(only.columns.map((column) => column.header)).toEqual(["Group", "Score"]);
    expect(only.rows).toEqual([
      { col1: "x", col2: 1 },
      { col1: null, col2: 2 },
    ]);
  });

  it("takes a merged title row above the table as the header row, the first-row rule", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Titled");
      sheet.mergeCells("A1:B1");
      sheet.getCell("A1").value = "Quarter report";
      sheet.addRow(["Name", "Score"]);
    });
    const [only] = (await sheetSpecFromXlsx(bytes)).sheets;
    expect(only.columns.map((column) => column.header)).toEqual(["Quarter report", "Column 2"]);
    expect(only.rows).toEqual([{ col1: "Name", col2: "Score" }]);
  });

  it("names a column with no header and keeps headers unique", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Odd");
      sheet.addRow(["Name", "Name", null]);
      sheet.addRow(["x", "y", 1]);
    });
    const imported = await sheetSpecFromXlsx(bytes);
    expect(imported.sheets[0].columns.map((column) => column.header)).toEqual(["Name", "Name 2", "Column 3"]);
  });

  it("refuses a file that is not a workbook with a clear error", async () => {
    const garbage = new TextEncoder().encode("this is not a workbook");
    const error = await rejectionOf(sheetSpecFromXlsx(garbage));
    expect(error).toBeInstanceOf(DocModelError);
    expect((error as DocModelError).message).toMatch(/not a readable Excel workbook/);
  });

  it("refuses a workbook over the sheet cap with a clear message", async () => {
    const bytes = await workbookBytes((book) => {
      for (let index = 0; index < 51; index += 1) {
        book.addWorksheet(`Sheet ${index + 1}`).addRow(["h"]);
      }
    });
    await expect(sheetSpecFromXlsx(bytes)).rejects.toThrow(/sheets: 51 sent, the limit is 50/);
  });

  it("refuses a sheet over the column cap before reading its cells", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Wide");
      sheet.getCell(1, 500).value = "far away";
    });
    await expect(sheetSpecFromXlsx(bytes)).rejects.toThrow(
      new RegExp(`Wide.*500 columns sent, the limit is ${FILE_EXTRACT_MAX_TABLE_COLS}`),
    );
  });

  it("refuses a workbook whose rows, across all sheets, pass the row cap", async () => {
    const bytes = await workbookBytes((book) => {
      const sheet = book.addWorksheet("Long");
      sheet.addRow(["h"]);
      for (let index = 0; index < 20001; index += 1) {
        sheet.addRow([index]);
      }
    });
    await expect(sheetSpecFromXlsx(bytes)).rejects.toThrow(/rows: 20001 sent, the limit is 20000/);
  });
});
