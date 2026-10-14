/**
 * An Excel workbook to a sheet spec: each worksheet becomes a sheet the model can edit. The first
 * non-empty row of a sheet is its headers. A column's type is inferred from its values: all dates
 * is `date`, all numbers is `number` (or `percent` when every cell is formatted with a percent sign),
 * and anything mixed is `text`. A formula is read as its cached result, so the numbers the sheet
 * showed are the numbers the model gets. Empty rows are dropped. A last row labelled "Total" whose
 * numbers are all formulas is the renderer's totals row, so it sets `totals` instead of becoming data.
 * A merged cell that is not the top-left of its range reads as empty, so a merge is not repeated.
 *
 * Reads locally with exceljs. Nothing leaves the machine.
 */
import ExcelJS from "exceljs";
import { FILE_EXTRACT_MAX_BYTES, FILE_EXTRACT_MAX_TABLE_COLS } from "../file-extract/limits";
import { DocModelError } from "./errors";
import type { DocThemeName } from "./themes";
import { DOC_LIMITS } from "./limits";
import { parseSheetSpec, type CellValue, type ColumnType, type Sheet, type SheetSpec } from "./types";

export type SheetImportOptions = {
  readonly title?: string;
  readonly theme?: DocThemeName;
};

/** One cell after reading: the value, whether its number format is a percent, and whether it was a formula. */
type Cell = { readonly value: string | number | Date | null; readonly percent: boolean; readonly formula: boolean };

const DEFAULT_TITLE = "Imported workbook";
const DEFAULT_SHEET_NAME = "Sheet";
const NAME_MAX = 200;
const HEADER_MAX = 200;
const TOTAL_LABEL = "Total";
/** A text cell that starts with an apostrophe and then a formula trigger was escaped by the renderer. */
const ESCAPED_FORMULA = /^'(?=[=+\-@])/;

/** Excel's cell value, unwrapped: a formula gives its cached result, rich text its plain words. */
function plainValue(value: unknown): string | number | Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "object") {
    return objectValue(value as Record<string, unknown>);
  }
  return null;
}

function objectValue(value: Record<string, unknown>): string | number | Date | null {
  if ("result" in value) {
    return plainValue(value.result);
  }
  if (Array.isArray(value.richText)) {
    const words = value.richText.map((run: { text?: unknown }) => String(run.text ?? "")).join("");
    return words.length > 0 ? words : null;
  }
  if ("text" in value) {
    return plainValue(String(value.text));
  }
  if ("error" in value) {
    return String(value.error);
  }
  return null;
}

function isPercent(numFmt: unknown): boolean {
  return typeof numFmt === "string" && numFmt.includes("%");
}

/** A merged range's top-left cell carries the value; the cells it covers are empty for this purpose. */
function isCoveredByMerge(cell: ExcelJS.Cell): boolean {
  return cell.isMerged && cell.master !== cell;
}

function readCell(cell: ExcelJS.Cell): Cell | null {
  if (isCoveredByMerge(cell)) {
    return null;
  }
  const value = plainValue(cell.value);
  if (value === null) {
    return null;
  }
  return { value, percent: isPercent(cell.numFmt), formula: cell.type === ExcelJS.ValueType.Formula };
}

/** Every row of one worksheet as cells, with rows that hold nothing already removed. */
function readRows(worksheet: ExcelJS.Worksheet): Array<Array<Cell | null>> {
  if (worksheet.columnCount > FILE_EXTRACT_MAX_TABLE_COLS) {
    throw new DocModelError(
      `sheet "${worksheet.name}": ${worksheet.columnCount} columns sent, the limit is ${FILE_EXTRACT_MAX_TABLE_COLS}`,
    );
  }
  const rows: Array<Array<Cell | null>> = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = Array.from({ length: worksheet.columnCount }, (_, column) => readCell(row.getCell(column + 1)));
    if (cells.some((cell) => cell !== null)) {
      rows.push(cells);
    }
  }
  return rows;
}

/** Width of the table: up to the last column that holds anything. */
function tableWidth(rows: ReadonlyArray<ReadonlyArray<Cell | null>>): number {
  return rows.reduce((width, row) => {
    const last = row.reduce<number>((found, cell, index) => (cell === null ? found : index + 1), 0);
    return Math.max(width, last);
  }, 0);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function unescapeFormula(text: string): string {
  return text.replace(ESCAPED_FORMULA, "");
}

/** The text a cell shows: a date as ISO, a number or word as it is. */
function cellText(cell: Cell): string {
  return cell.value instanceof Date ? isoDate(cell.value) : unescapeFormula(String(cell.value));
}

function headerText(cell: Cell | null, position: number): string {
  const text = cell === null ? "" : cellText(cell);
  return text.trim().slice(0, HEADER_MAX) || `Column ${position + 1}`;
}

/** Make each header unique by adding a number to the repeats: "Name", "Name 2", ... */
function uniqueHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = (seen.get(header) ?? 0) + 1;
    seen.set(header, count);
    return count === 1 ? header : `${header} ${count}`.slice(0, HEADER_MAX);
  });
}

function inferType(cells: ReadonlyArray<Cell>): ColumnType {
  if (cells.length === 0) {
    return "text";
  }
  if (cells.every((cell) => cell.value instanceof Date)) {
    return "date";
  }
  if (cells.every((cell) => typeof cell.value === "number")) {
    return cells.every((cell) => cell.percent) ? "percent" : "number";
  }
  return "text";
}

/** One cell as the column type wants it: a number, an ISO date, or text. */
function typed(cell: Cell | null, type: ColumnType): CellValue {
  if (cell === null) {
    return null;
  }
  if (type === "number" || type === "percent" || type === "currency") {
    return typeof cell.value === "number" ? cell.value : null;
  }
  return cellText(cell);
}

/** The totals row the renderer writes: "Total" first, then only formulas. Removed from the data. */
function splitTotals(rows: Array<Array<Cell | null>>): { data: Array<Array<Cell | null>>; totals: boolean } {
  const last = rows[rows.length - 1];
  const isTotals =
    rows.length > 1 && last[0]?.value === TOTAL_LABEL && last.slice(1).every((cell) => cell === null || cell.formula);
  return { data: isTotals ? rows.slice(0, -1) : rows, totals: isTotals };
}

/** One worksheet as a sheet, or null when it holds no cells at all. */
function readSheet(worksheet: ExcelJS.Worksheet, position: number): Sheet | null {
  const rows = readRows(worksheet);
  if (rows.length === 0) {
    return null;
  }
  const { data, totals } = splitTotals(rows);
  const width = tableWidth(rows);
  const [headerRow, ...dataRows] = data;
  const headers = uniqueHeaders(
    Array.from({ length: width }, (_, column) => headerText(headerRow?.[column] ?? null, column)),
  );
  const padded = dataRows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? null));
  const types = Array.from({ length: width }, (_, column) =>
    inferType(padded.flatMap((row) => (row[column] === null ? [] : [row[column]]))),
  );
  const keys = types.map((_, column) => `col${column + 1}`);
  return {
    id: `sh${position + 1}`,
    name: (worksheet.name.trim() || `${DEFAULT_SHEET_NAME} ${position + 1}`).slice(0, NAME_MAX),
    columns: headers.map((header, column) => ({ key: keys[column], header, type: types[column] })),
    rows: padded.map((row) => Object.fromEntries(keys.map((key, column) => [key, typed(row[column], types[column])]))),
    totals,
    freezeHeader: true,
  };
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  if (bytes.byteLength > FILE_EXTRACT_MAX_BYTES) {
    throw new DocModelError(`workbook: ${bytes.byteLength} bytes sent, the limit is ${FILE_EXTRACT_MAX_BYTES}`);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs types its own Buffer; take the parameter type from the library rather than the global one.
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<ExcelJS.Xlsx["load"]>[0]);
  } catch {
    throw new DocModelError("not a readable Excel workbook (.xlsx)");
  }
  return workbook;
}

/**
 * Refuse before any cell is read when the workbook's rows, across every sheet together, pass the
 * model's row cap. The check uses the sheets' own row counts, so a huge file is never materialised.
 */
function assertTotalRows(worksheets: readonly ExcelJS.Worksheet[]): void {
  const total = worksheets.reduce((sum, worksheet) => sum + Math.max(0, worksheet.rowCount - 1), 0);
  if (total > DOC_LIMITS.rows) {
    throw new DocModelError(`rows: ${total} sent, the limit is ${DOC_LIMITS.rows}`);
  }
}

/** Read an .xlsx file into the editable sheet model. Refuses with a `DocModelError` when it cannot. */
export async function sheetSpecFromXlsx(bytes: Uint8Array, options: SheetImportOptions = {}): Promise<SheetSpec> {
  const workbook = await loadWorkbook(bytes);
  assertTotalRows(workbook.worksheets);
  const sheets = workbook.worksheets
    .map((worksheet, position) => readSheet(worksheet, position))
    .filter((sheet): sheet is Sheet => sheet !== null)
    .map((sheet, position) => ({ ...sheet, id: `sh${position + 1}` }));
  if (sheets.length === 0) {
    throw new DocModelError("the workbook has no cells to read");
  }
  return parseSheetSpec({
    kind: "workbook",
    title: options.title ?? DEFAULT_TITLE,
    theme: options.theme ?? "plain",
    sheets,
  });
}
