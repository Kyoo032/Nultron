import {
  CHAT_FINANCE_FIGURES_NAME_MAX,
  CHAT_FINANCE_FIGURES_NAMES_MAX,
  type ChatFinanceFigures,
  type ChatFinanceFiguresSkip,
  chatFinanceFiguresSchema,
} from "@agentforge/core/chat-documents";
import {
  FINANCE_FIGURES_TEXT_MAX,
  FINANCE_IMPORT_MAX_SHEETS,
  type FinanceSheet,
  joinSheetTexts,
  scoreFinanceTaskFit,
} from "@agentforge/core/finance";
import type { ExtractedTable } from "../file-extract";
import { guardFinanceInput } from "../finance-privacy";
import { FINANCE_AUTO_TRY_MIN_SCORE } from "../finance-tasks/auto";
import { log } from "../log";
import type { HostFile } from "../types";
import { financeTextBlocked } from "./injection";
import { documentProse, documentSheets, workbookSheets } from "./read-file";

export type FinanceFiguresRead = {
  readonly figures: ChatFinanceFigures | null;
  readonly skipped: ChatFinanceFiguresSkip | null;
};

const WORKBOOK_FORMATS: ReadonlySet<string> = new Set(["xlsx"]);
const DOCUMENT_FORMATS: ReadonlySet<string> = new Set(["docx", "pdf", "pptx"]);
const MACRO_WORKBOOK = /\.xlsm$/i;

type SheetText = { name: string; text: string };
type Joined = { readonly figuresText: string; readonly skipped: readonly string[] };

class NoTable extends Error {}

const skip = (reason: ChatFinanceFiguresSkip): FinanceFiguresRead => ({ figures: null, skipped: reason });

function capNames(names: readonly string[]): string[] {
  return names.slice(0, CHAT_FINANCE_FIGURES_NAMES_MAX).map((name) => name.slice(0, CHAT_FINANCE_FIGURES_NAME_MAX));
}

function joinSheets(sheets: ReadonlyArray<FinanceSheet>): Joined {
  const texts: SheetText[] = [];
  const failed: string[] = [];
  let length = 0;
  sheets.slice(0, FINANCE_IMPORT_MAX_SHEETS).forEach((sheet, index) => {
    if (index > 0 && length >= FINANCE_FIGURES_TEXT_MAX) {
      failed.push(sheet.name);
      return;
    }
    try {
      const text = guardFinanceInput({ sheet }).figuresText;
      texts.push({ name: sheet.name, text });
      length += text.length;
    } catch (error) {
      if (index === 0) {
        throw error;
      }
      failed.push(sheet.name);
    }
  });
  const joined = joinSheetTexts(texts, FINANCE_FIGURES_TEXT_MAX);
  return { figuresText: joined.text, skipped: [...joined.skipped, ...failed] };
}

function workbookFile(file: HostFile): HostFile {
  return MACRO_WORKBOOK.test(file.filename)
    ? { ...file, filename: file.filename.replace(MACRO_WORKBOOK, ".xlsx") }
    : file;
}

function readWorkbookFigures(file: HostFile): { sheets: ReadonlyArray<FinanceSheet>; proseText: string } {
  return { sheets: workbookSheets(workbookFile(file)), proseText: "" };
}

function readDocumentFigures(
  tables: readonly ExtractedTable[],
  markdown: string,
): { sheets: ReadonlyArray<FinanceSheet>; proseText: string } {
  const sheets = documentSheets(tables);
  if (sheets.length === 0) {
    throw new NoTable();
  }
  return { sheets, proseText: guardFinanceInput({ figuresText: documentProse(markdown) }).figuresText };
}

function fitsSomeTask(figures: ChatFinanceFigures): boolean {
  const fit = scoreFinanceTaskFit({
    figuresText: figures.figuresText,
    proseText: figures.proseText,
    sheetNames: figures.sheetNames,
    prompt: "",
  });
  return fit.ranked.some((entry) => entry.score >= FINANCE_AUTO_TRY_MIN_SCORE);
}

function judged(filename: string, candidate: ChatFinanceFigures): FinanceFiguresRead {
  if (candidate.figuresText.trim() === "") {
    return skip("no_table");
  }
  if (financeTextBlocked(filename, `${candidate.figuresText}\n${candidate.proseText}`)) {
    return skip("blocked");
  }
  if (!fitsSomeTask(candidate)) {
    return skip("no_table");
  }
  const parsed = chatFinanceFiguresSchema.safeParse(candidate);
  return parsed.success ? { figures: parsed.data, skipped: null } : skip("unreadable");
}

export async function readFinanceFigures(
  file: HostFile,
  format: string,
  tables: readonly ExtractedTable[],
  markdown = "",
): Promise<FinanceFiguresRead> {
  const workbook = WORKBOOK_FORMATS.has(format);
  if (!workbook && !DOCUMENT_FORMATS.has(format)) {
    return { figures: null, skipped: null };
  }
  try {
    const { sheets, proseText } = workbook ? readWorkbookFigures(file) : readDocumentFigures(tables, markdown);
    const joined = joinSheets(sheets);
    return judged(file.filename, {
      figuresText: joined.figuresText,
      proseText,
      sheetNames: capNames(sheets.map((sheet) => sheet.name)),
      skipped: capNames(joined.skipped),
    });
  } catch (error) {
    if (error instanceof NoTable) {
      return skip("no_table");
    }
    log.warn("chat_finance_figures_unreadable", { format, kind: error instanceof Error ? error.name : typeof error });
    return skip("unreadable");
  }
}

export function checkFinanceFigures(value: unknown, filename: string): ChatFinanceFigures | null {
  const sent = chatFinanceFiguresSchema.safeParse(value);
  if (!sent.success) {
    return null;
  }
  const guarded = {
    ...sent.data,
    figuresText: guardFinanceInput({ figuresText: sent.data.figuresText }).figuresText,
    proseText: guardFinanceInput({ figuresText: sent.data.proseText }).figuresText,
  };
  if (financeTextBlocked(filename, `${guarded.figuresText}\n${guarded.proseText}`)) {
    return null;
  }
  const checked = chatFinanceFiguresSchema.safeParse(guarded);
  return checked.success ? checked.data : null;
}
