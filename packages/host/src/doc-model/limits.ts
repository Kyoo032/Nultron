/**
 * Caps and structural checks for a document or workbook spec. Every cap is a total across the whole
 * spec. A spec over a cap is refused with a message that names the limit and the count sent: the
 * model never gets a truncated file it did not ask for.
 */
import type { DocSpec, SheetSpec } from "./types";
import { DocModelError } from "./errors";

export const DOC_LIMITS = Object.freeze({
  sections: 200,
  blocks: 2000,
  sheets: 50,
  rows: 20000,
  textBytes: 2 * 1024 * 1024,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function refuse(field: string, sent: number, limit: number): never {
  throw new DocModelError(`${field}: ${sent} sent, the limit is ${limit}`);
}

/** Every string leaf in the spec, counted in UTF-8 bytes. Object keys are not counted. */
function textBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + textBytes(item), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, item) => sum + textBytes(item), 0);
  }
  return 0;
}

function assertUnique(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new DocModelError(`${field}: "${id}" appears more than once`);
    }
    seen.add(id);
  }
}

function assertTextBytes(spec: unknown): void {
  const bytes = textBytes(spec);
  if (bytes > DOC_LIMITS.textBytes) {
    refuse("text", bytes, DOC_LIMITS.textBytes);
  }
}

function countBlocks(spec: DocSpec): number {
  return spec.sections.reduce((sum, section) => sum + section.blocks.length, 0);
}

/** Section and block caps, unique section ids, and table rows as wide as their columns. */
export function assertDocLimits(spec: DocSpec): void {
  if (spec.sections.length > DOC_LIMITS.sections) {
    refuse("sections", spec.sections.length, DOC_LIMITS.sections);
  }
  const blocks = countBlocks(spec);
  if (blocks > DOC_LIMITS.blocks) {
    refuse("blocks", blocks, DOC_LIMITS.blocks);
  }
  assertUnique(
    spec.sections.map((section) => section.id),
    "section id",
  );
  for (const section of spec.sections) {
    for (const block of section.blocks) {
      if (block.type !== "table") {
        continue;
      }
      block.rows.forEach((row, index) => {
        if (row.length !== block.columns.length) {
          throw new DocModelError(
            `section "${section.id}", table row ${index + 1}: ${row.length} cells, the table has ${block.columns.length} columns`,
          );
        }
      });
    }
  }
  assertTextBytes(spec);
}

function cellProblem(value: unknown, type: string): string | null {
  if (value === null) {
    return null;
  }
  if (type === "text") {
    return typeof value === "string" ? null : "text column takes a string";
  }
  if (type === "date") {
    if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      return `date column takes an ISO date such as 2026-10-14, got ${JSON.stringify(value)}`;
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${type} column takes a number, got ${JSON.stringify(value)}`;
  }
  return null;
}

/** Sheet, row and cell caps, unique ids, known row keys, and cells that match their column type. */
export function assertSheetLimits(spec: SheetSpec): void {
  if (spec.sheets.length > DOC_LIMITS.sheets) {
    refuse("sheets", spec.sheets.length, DOC_LIMITS.sheets);
  }
  const rows = spec.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  if (rows > DOC_LIMITS.rows) {
    refuse("rows", rows, DOC_LIMITS.rows);
  }
  assertUnique(
    spec.sheets.map((sheet) => sheet.id),
    "sheet id",
  );
  for (const sheet of spec.sheets) {
    assertUnique(
      sheet.columns.map((column) => column.key),
      `sheet "${sheet.id}" column key`,
    );
    const types = new Map(sheet.columns.map((column) => [column.key, column.type]));
    sheet.rows.forEach((row, index) => {
      for (const [key, value] of Object.entries(row)) {
        const type = types.get(key);
        if (type === undefined) {
          throw new DocModelError(`sheet "${sheet.id}", row ${index + 1}: "${key}" is not a column`);
        }
        const problem = cellProblem(value, type);
        if (problem) {
          throw new DocModelError(`sheet "${sheet.id}", row ${index + 1}, "${key}": ${problem}`);
        }
      }
    });
  }
  assertTextBytes(spec);
}
