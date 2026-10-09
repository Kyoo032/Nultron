/**
 * The two network steps of the prompt-first Finance screen, both free and both code-only on the host:
 * reading a dropped file into figures text (`POST /api/v1/finance/import`, once per sheet) and asking
 * `POST /api/v1/finance/auto` what those figures look like. The paid write-up is not here: it is the
 * existing `/finance/stream`, and the screen sends it only when the person presses its button.
 */
import { apiFetch } from "./api-client";
import {
  FINANCE_AUTO_PATH,
  FINANCE_AUTO_TEXT_MAX,
  joinSheetTexts,
  parseFinanceAuto,
  type FinanceAutoAnswer,
} from "./finance-auto-client";
import {
  FINANCE_IMPORT_MAX_SHEETS,
  importFinanceFile,
  type FinanceImportResult,
} from "./finance-import-client";
import { EMPTY_FINANCE_PII, type FinanceImportWarning, type FinancePiiSummary } from "./finance-import-warnings";
import { t } from "./i18n";

/** A dropped file, read: what the screen shows, and what the free read is asked about. */
export type FinanceAutoSource = {
  readonly fileName: string;
  /** Every sheet that fits, each starting with its `Sheet:` line. */
  readonly figuresText: string;
  /** A document's prose, already redacted by the host. Empty for a spreadsheet. */
  readonly proseText: string;
  /** Every sheet the file has, including the ones that were not read. */
  readonly sheetNames: readonly string[];
  /** Whole sheets left out because they would not fit in one read. */
  readonly skipped: readonly string[];
  readonly warnings: readonly FinanceImportWarning[];
  readonly pii: FinancePiiSummary;
};

function failureMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }
  return fallback;
}

/**
 * Read every sheet of a file, in order, and join what fits. The first sheet decides whether the file
 * can be read at all; a later sheet that fails or does not fit is named as left out, never silently
 * dropped. It stops asking once the text is already as long as one read can take, so a workbook of
 * thirty sheets is not thirty uploads.
 */
export async function readFinanceFileForAuto(file: File): Promise<FinanceAutoSource> {
  const first = await importFinanceFile(file);
  const sheets = [{ name: first.sheet, text: first.figuresText }];
  const warnings: FinanceImportWarning[] = [...first.warnings];
  let pii: FinancePiiSummary = first.pii;
  const failed: string[] = [];
  const rest = first.sheets.filter((sheet) => sheet.name !== first.sheet).slice(0, FINANCE_IMPORT_MAX_SHEETS - 1);
  let length = first.figuresText.length;
  for (const sheet of rest) {
    if (length >= FINANCE_AUTO_TEXT_MAX) {
      failed.push(sheet.name);
      continue;
    }
    try {
      const next: FinanceImportResult = await importFinanceFile(file, sheet.name);
      sheets.push({ name: next.sheet, text: next.figuresText });
      warnings.push(...next.warnings);
      pii = next.pii.count > pii.count ? next.pii : pii;
      length += next.figuresText.length;
    } catch {
      failed.push(sheet.name);
    }
  }
  const joined = joinSheetTexts(sheets, FINANCE_AUTO_TEXT_MAX);
  return {
    fileName: file.name,
    figuresText: joined.text,
    proseText: first.proseText,
    sheetNames: first.sheets.map((sheet) => sheet.name),
    skipped: [...joined.skipped, ...failed],
    warnings,
    pii: pii.count === 0 ? EMPTY_FINANCE_PII : pii,
  };
}

/**
 * Ask the host what the figures look like and for the free preview. Throws an `Error` whose message is
 * the host's own refusal (an injection-guard 400, for one) or the catalog's fallback.
 */
export async function requestFinanceAuto(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FinanceAutoAnswer> {
  const res = await apiFetch(FINANCE_AUTO_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(failureMessage(payload, t("finance.auto.errors.read")));
  }
  const answer = parseFinanceAuto(payload);
  if (!answer) {
    throw new Error(t("finance.auto.errors.read"));
  }
  return answer;
}
