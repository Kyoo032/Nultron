import { ApiError } from "@agentforge/core";
import {
  FINANCE_FIGURES_TEXT_MAX,
  readFinanceTable,
  type FinanceImportWarning,
  type FinanceSheet,
} from "@agentforge/core/finance";
import { type ExtractedTable, extractFile, markdownToText } from "../file-extract";
import { guardFinanceInput, mergeFinancePii, redactFinanceSheets, type FinancePiiSummary } from "../finance-privacy";
import type { HostFile } from "../types";

const NO_FIGURES = "No table and no figures were found in that document. Paste the figures you need instead.";
const PROSE_SHEET = "Document text";

export type ImportPayload = {
  readonly sheets: ReadonlyArray<FinanceSheet>;
  readonly sheet: FinanceSheet;
  readonly figuresText: string;
  readonly proseText: string;
  readonly warnings: ReadonlyArray<FinanceImportWarning>;
  readonly pii: FinancePiiSummary;
};

export function pickSheet(sheets: ReadonlyArray<FinanceSheet>, name: string): FinanceSheet {
  const first = sheets[0];
  if (!first) {
    throw new ApiError("invalid_request", "No rows of figures were found in that file", 400);
  }
  if (name === "") {
    return first;
  }
  const chosen = sheets.find((sheet) => sheet.name === name);
  if (!chosen) {
    throw new ApiError("invalid_request", "That sheet is not in this file", 400);
  }
  return chosen;
}

function uniqueNames(sheets: ReadonlyArray<FinanceSheet>): FinanceSheet[] {
  const seen = new Map<string, number>();
  return sheets.map((sheet) => {
    const used = seen.get(sheet.name) ?? 0;
    seen.set(sheet.name, used + 1);
    return used === 0 ? sheet : { ...sheet, name: `${sheet.name} (${used + 1})` };
  });
}

export function documentSheets(tables: ReadonlyArray<ExtractedTable>): FinanceSheet[] {
  const named = tables.map((table, index) => ({
    name: table.title?.trim() || `Table ${index + 1}`,
    rows: table.rows.map((row) => [...row]),
  }));
  return uniqueNames(named.filter((sheet) => sheet.rows.length >= 2));
}

function capProse(text: string): string {
  const lines = text.split("\n");
  const kept = lines.reduce<{ lines: string[]; length: number }>(
    (acc, line) => {
      const length = acc.length + line.length + (acc.lines.length === 0 ? 0 : 1);
      return length > FINANCE_FIGURES_TEXT_MAX ? acc : { lines: [...acc.lines, line], length };
    },
    { lines: [], length: 0 },
  );
  return kept.lines.join("\n").trim();
}

function proseOnly(prose: string): ImportPayload {
  const guarded = guardFinanceInput({ figuresText: prose });
  const rows = guarded.figuresText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => [line]);
  if (rows.length === 0) {
    throw new ApiError("invalid_request", NO_FIGURES, 400);
  }
  const sheet: FinanceSheet = { name: PROSE_SHEET, rows };
  return {
    sheets: [sheet],
    sheet,
    figuresText: guarded.figuresText,
    proseText: guarded.figuresText,
    warnings: [],
    pii: guarded.pii,
  };
}

export function documentProse(markdown: string): string {
  return capProse(markdownToText(markdown, { withoutTables: true }));
}

export function workbookSheets(file: HostFile): ReadonlyArray<FinanceSheet> {
  return readFinanceTable(file.bytes, file.filename).sheets;
}

export async function readDocument(file: HostFile, wanted: string): Promise<ImportPayload> {
  const extracted = await extractFile({ bytes: file.bytes, filename: file.filename, mime: file.mime });
  const proseText = documentProse(extracted.markdown);
  const sheets = documentSheets(extracted.tables);
  if (sheets.length === 0) {
    return proseOnly(proseText);
  }
  const guarded = guardFinanceInput({ sheet: pickSheet(sheets, wanted) });
  const prose = guardFinanceInput({ figuresText: proseText });
  return {
    sheets: redactFinanceSheets(sheets),
    sheet: guarded.sheet,
    figuresText: guarded.figuresText,
    proseText: prose.figuresText,
    warnings: guarded.warnings,
    pii: mergeFinancePii(guarded.pii, prose.pii),
  };
}

export function readWorkbook(file: HostFile, wanted: string): ImportPayload {
  const sheets = workbookSheets(file);
  const guarded = guardFinanceInput({ sheet: pickSheet(sheets, wanted) });
  return {
    sheets: redactFinanceSheets(sheets),
    sheet: guarded.sheet,
    figuresText: guarded.figuresText,
    proseText: "",
    warnings: guarded.warnings,
    pii: guarded.pii,
  };
}
