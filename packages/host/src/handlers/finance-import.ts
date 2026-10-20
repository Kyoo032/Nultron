/**
 * `POST /api/v1/finance/import` — a CSV, Excel or document upload read into the plain figures text
 * the paste box already takes. Nothing is stored and nothing is computed here: the owner still reads
 * the text, runs the existing parse, and confirms every line item before any number is used.
 *
 * Two readers, on purpose. A `.csv` / `.xlsx` / `.xls` keeps the spreadsheet path unchanged, because
 * that is where the Indonesian thousands-point and period-column logic lives. A `.pdf` / `.docx` /
 * `.pptx` goes through `file-extract`, which converts it locally: each table in the document becomes
 * a selectable "sheet" fed through the same `tableToFiguresText`, and the prose around the tables
 * comes back as `proseText` so figures that were only ever written in a sentence are not lost.
 *
 * The converter opens no socket and a scanned PDF is refused here rather than sent anywhere.
 *
 * The upload convention is the one the dataset and legal routes use: one multipart file under the
 * field `file`, surfaced by the HTTP adapter as `request.files`. Multipart form fields are not
 * surfaced, so a second sheet is chosen with `?sheet=<name>`.
 */
import { ApiError, scanInjection } from "@agentforge/core";
import {
  FINANCE_IMPORT_EXTENSIONS,
  FINANCE_IMPORT_MAX_BYTES,
  FinanceImportError,
  financeImportExtension,
  financeWorkbookKind,
  type FinanceImportExtension,
  type FinanceSheet,
} from "@agentforge/core/finance";
import { jsonError, jsonOk } from "../errors";
import { FileExtractError } from "../file-extract";
import { readDocument, readWorkbook } from "../finance-figures/read-file";
import type { HostFile, HostRequest, HostResult } from "../types";

/** Rows of each sheet shown back to the owner before they use the figures. */
export const FINANCE_IMPORT_PREVIEW_ROWS = 8;

/** Documents Finance reads as tables plus prose. Everything else still goes through SheetJS. */
export const FINANCE_IMPORT_DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".pptx"] as const;

type FinanceDocumentExtension = (typeof FINANCE_IMPORT_DOCUMENT_EXTENSIONS)[number];

/** Every extension the route takes, spreadsheets first. */
export const FINANCE_IMPORT_ALL_EXTENSIONS = [
  ...FINANCE_IMPORT_EXTENSIONS,
  ...FINANCE_IMPORT_DOCUMENT_EXTENSIONS,
] as const;

const ACCEPTED = FINANCE_IMPORT_ALL_EXTENSIONS.join(", ");
const SIZE_CAP_MB = Math.round(FINANCE_IMPORT_MAX_BYTES / 1_000_000);
const UNREADABLE = "That file could not be read as a table. Open it, save it again as .csv or .xlsx, and try again.";
const INJECTION =
  "That file contains text written as instructions to the assistant, so it was not imported. Open the file and paste the figures you need instead.";

function financeDocumentExtension(filename: string): FinanceDocumentExtension | null {
  const lower = filename.trim().toLowerCase();
  return FINANCE_IMPORT_DOCUMENT_EXTENSIONS.find((extension) => lower.endsWith(extension)) ?? null;
}

/** The bytes must be what the name claims: an OOXML workbook is a zip, a legacy .xls an OLE file. */
function requireMagicBytes(extension: FinanceImportExtension, bytes: Uint8Array): void {
  const kind = financeWorkbookKind(bytes);
  const wrong =
    (extension === ".xlsx" && kind !== "zip") ||
    (extension === ".xls" && kind === null) ||
    (extension === ".csv" && kind !== null);
  if (wrong) {
    throw new ApiError("unsupported_content_type", `That file is not really a ${extension} file`, 400);
  }
}

type Upload = { readonly file: HostFile; readonly document: FinanceDocumentExtension | null };

function requireImportFile(request: HostRequest): Upload {
  const file = request.files?.find((item) => item.field === "file") ?? request.files?.[0];
  if (!file) {
    throw new ApiError("invalid_request", `Attach one ${ACCEPTED} file under the field "file"`, 400);
  }
  if (file.bytes.byteLength === 0) {
    throw new ApiError("invalid_request", "That file is empty", 400);
  }
  if (file.bytes.byteLength > FINANCE_IMPORT_MAX_BYTES) {
    throw new ApiError("invalid_request", `That file is over the ${SIZE_CAP_MB} MB cap`, 413);
  }
  const document = financeDocumentExtension(file.filename);
  if (document) {
    // `extractFile` reads the real container and refuses a name that lies about it, which is a
    // stronger check than four magic bytes: .docx and .pptx are both zips.
    return { file, document };
  }
  const extension = financeImportExtension(file.filename);
  if (!extension) {
    throw new ApiError("unsupported_content_type", `Only ${ACCEPTED} files can be imported`, 400);
  }
  requireMagicBytes(extension, file.bytes);
  return { file, document: null };
}

function readSheetParam(request: HostRequest): string {
  const fromBody = (request.body ?? null) as { sheet?: unknown } | null;
  const raw = request.query.sheet ?? (typeof fromBody?.sheet === "string" ? fromBody.sheet : "");
  return raw.trim();
}

/**
 * The figures text is about to be read back by the model, so an uploaded sheet gets the same guard
 * a knowledge upload gets. The owner's way past a false positive is the paste box, which is untouched.
 */
function requireNoInjection(filename: string, text: string): void {
  if (scanInjection(filename) ?? scanInjection(text)) {
    throw new ApiError("injection_blocked", INJECTION, 400);
  }
}

function sheetSummary(sheet: FinanceSheet) {
  return {
    name: sheet.name,
    rowCount: sheet.rows.length,
    preview: sheet.rows.slice(0, FINANCE_IMPORT_PREVIEW_ROWS).map((row) => [...row]),
  };
}

/** Import failures answer with a sentence the owner can act on; nothing else reaches the client. */
const EXTRACT_FAILURES: Readonly<Record<string, { readonly code: string; readonly status: number }>> = {
  unsupported: { code: "unsupported_content_type", status: 400 },
  format_mismatch: { code: "unsupported_content_type", status: 400 },
  too_large: { code: "invalid_request", status: 413 },
  needs_ocr: { code: "needs_ocr", status: 400 },
  timeout: { code: "timeout", status: 400 },
};

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof FileExtractError) {
    const mapped = EXTRACT_FAILURES[error.code] ?? { code: "invalid_request", status: 400 };
    return new ApiError(mapped.code, error.message, mapped.status);
  }
  if (error instanceof FinanceImportError) {
    switch (error.code) {
      case "unsupported_type":
        return new ApiError("unsupported_content_type", error.message, 400);
      case "too_large":
        return new ApiError("invalid_request", error.message, 413);
      case "empty":
        return new ApiError("invalid_request", error.message, 400);
      default:
        return new ApiError("invalid_request", UNREADABLE, 400);
    }
  }
  return new ApiError("invalid_request", UNREADABLE, 400);
}

/**
 * Reading a file needs no tenant and touches no store; only the document reader has to await.
 *
 * Deliberately NOT behind `requireGatewayAllowed()`: no path below reaches the gateway, and a
 * closed gate must never stop the owner reading a file that never leaves it.
 */
export async function handlePostFinanceImport(request: HostRequest): Promise<HostResult> {
  try {
    const { file, document } = requireImportFile(request);
    const wanted = readSheetParam(request);
    // Everything below is already redacted: the privacy guard runs inside the two readers, so the
    // only copy of the figures that exists past this line is the one the owner is shown.
    const { sheets, sheet, figuresText, proseText, warnings, pii } = document
      ? await readDocument(file, wanted)
      : readWorkbook(file, wanted);
    // Both the figures and the prose are about to be read back by the model, so both are scanned.
    requireNoInjection(file.filename, `${figuresText}\n${proseText}`);
    return jsonOk({
      sheets: sheets.map(sheetSummary),
      sheet: sheet.name,
      figuresText,
      proseText,
      warnings: warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        detail: [...warning.detail],
      })),
      pii,
    });
  } catch (error) {
    return jsonError(asApiError(error));
  }
}
