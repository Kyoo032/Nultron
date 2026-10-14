/**
 * SheetSpec to an Excel (.xlsx) workbook: one worksheet per sheet, typed cells, a styled frozen header
 * from the theme, and an optional totals row of live SUM formulas.
 *
 * A formula is written with its computed result cached beside it. Previews and Protected View show the
 * cache, so a bare formula would read blank there (the same reason `renderers/xlsx.ts` caches results).
 */
import ExcelJS from "exceljs";
import { safeCell, uniqueSheetName } from "../renderers/cells";
import { themeFor, type DocTheme } from "./themes";
import type { Column, CellValue, Sheet, SheetSpec } from "./types";

const NUMBER_FORMAT = "#,##0.00";
const PERCENT_FORMAT = "0.0%";
const DATE_FORMAT = "yyyy-mm-dd";
const WIDTH_MIN = 12;
const WIDTH_MAX = 42;
const WIDTH_PAD = 2;
const NUMERIC: ReadonlySet<Column["type"]> = new Set(["number", "currency", "percent"]);

function formatFor(type: Column["type"]): string | undefined {
  if (type === "percent") {
    return PERCENT_FORMAT;
  }
  if (type === "date") {
    return DATE_FORMAT;
  }
  if (NUMERIC.has(type)) {
    return NUMBER_FORMAT;
  }
  return undefined;
}

/** Column letter for a 1-based index: 1 is A, 27 is AA. */
export function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** A value as the sheet writes it. Text goes through `safeCell`, so "=..." never runs as a formula. */
function cellValue(column: Column, value: CellValue | undefined): ExcelJS.CellValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (column.type === "date" && typeof value === "string") {
    return new Date(`${value}T00:00:00Z`);
  }
  if (typeof value === "string") {
    return safeCell(value);
  }
  return value;
}

function applyFont(cell: ExcelJS.Cell, theme: DocTheme, bold = false): void {
  cell.font = { name: theme.fontFamily, size: theme.bodySize, bold, color: { argb: `FF${theme.textColor}` } };
}

function styleHeader(sheet: ExcelJS.Worksheet, columns: readonly Column[], theme: DocTheme): void {
  const row = sheet.getRow(1);
  columns.forEach((column, index) => {
    const cell = row.getCell(index + 1);
    cell.value = column.header;
    cell.font = { name: theme.fontFamily, size: theme.bodySize, bold: true, color: { argb: `FF${theme.headerText}` } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${theme.headerFill}` } };
    cell.border = { bottom: { style: "thin", color: { argb: `FF${theme.ruleColor}` } } };
  });
  row.commit();
}

function writeRows(sheet: ExcelJS.Worksheet, sheetSpec: Sheet, theme: DocTheme): void {
  sheetSpec.rows.forEach((record, rowIndex) => {
    const row = sheet.getRow(rowIndex + 2);
    sheetSpec.columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = cellValue(column, record[column.key]);
      const format = formatFor(column.type);
      if (format) {
        cell.numFmt = format;
      }
      applyFont(cell, theme);
    });
    row.commit();
  });
}

/** Sum of the column's numbers, rounded so a float artefact does not show as 0.30000000004. */
function columnSum(sheetSpec: Sheet, key: string): number {
  const total = sheetSpec.rows.reduce((sum, record) => {
    const value = record[key];
    return typeof value === "number" ? sum + value : sum;
  }, 0);
  return Math.round(total * 1e9) / 1e9;
}

/** One row under the data: a label, then SUM formulas over each numeric column. */
function writeTotals(sheet: ExcelJS.Worksheet, sheetSpec: Sheet, theme: DocTheme): void {
  const totalRow = sheetSpec.rows.length + 2;
  const lastDataRow = sheetSpec.rows.length + 1;
  const row = sheet.getRow(totalRow);
  sheetSpec.columns.forEach((column, index) => {
    const cell = row.getCell(index + 1);
    cell.border = { top: { style: "thin", color: { argb: `FF${theme.ruleColor}` } } };
    if (index === 0) {
      cell.value = "Total";
      applyFont(cell, theme, true);
      return;
    }
    if (!NUMERIC.has(column.type)) {
      applyFont(cell, theme, true);
      return;
    }
    const letter = columnLetter(index + 1);
    const result = columnSum(sheetSpec, column.key);
    cell.value = sheetSpec.rows.length > 0 ? { formula: `SUM(${letter}2:${letter}${lastDataRow})`, result } : 0;
    cell.numFmt = formatFor(column.type) ?? NUMBER_FORMAT;
    applyFont(cell, theme, true);
  });
  row.commit();
}

/** Column widths: the author's width if given, otherwise the widest value, clamped. */
function sizeColumns(sheet: ExcelJS.Worksheet, sheetSpec: Sheet): void {
  sheetSpec.columns.forEach((column, index) => {
    if (column.width !== undefined) {
      sheet.getColumn(index + 1).width = column.width;
      return;
    }
    const widest = sheetSpec.rows.reduce((max, record) => {
      const value = record[column.key];
      return value === undefined || value === null ? max : Math.max(max, String(value).length);
    }, column.header.length);
    sheet.getColumn(index + 1).width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, widest + WIDTH_PAD));
  });
}

function addSheet(workbook: ExcelJS.Workbook, sheetSpec: Sheet, theme: DocTheme, taken: Set<string>): void {
  const sheet = workbook.addWorksheet(uniqueSheetName(taken, sheetSpec.name));
  styleHeader(sheet, sheetSpec.columns, theme);
  writeRows(sheet, sheetSpec, theme);
  if (sheetSpec.totals) {
    writeTotals(sheet, sheetSpec, theme);
  }
  sizeColumns(sheet, sheetSpec);
  if (sheetSpec.freezeHeader) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
}

export async function renderXlsx(spec: SheetSpec): Promise<Uint8Array> {
  const theme = themeFor(spec.theme);
  const workbook = new ExcelJS.Workbook();
  workbook.title = spec.title;
  const taken = new Set<string>();
  for (const sheet of spec.sheets) {
    addSheet(workbook, sheet, theme, taken);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
