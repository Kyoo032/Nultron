/**
 * One uploaded document into the text Chat sends: read locally, masked, then cut to the budget.
 *
 * The reader is `file-extract`, the one local pipeline Knowledge and Finance already use, so the same
 * 25 MB and 20 s caps apply, the extension and the bytes must agree, a scan is refused as `needs_ocr`,
 * and nothing here opens a socket. What this adds is the steps Chat needs:
 *
 *   1. clean the text so it is valid for the desk's file store and safe inside an attachment block;
 *   2. mask personal details with the same `maskPii` the outbound copy uses, on the whole text, so
 *      the model's copy and the desk copy are both masked and neither is ever the raw text;
 *   3. cut the model's copy on a line boundary to {@link CHAT_DOCUMENT_TEXT_MAX_CHARS}.
 *
 * Nothing is mutated; every step returns a new string. Nothing is written to the desk here: the copy is
 * saved when the message is sent (`save-handler.ts`), so a removed attachment leaves nothing behind.
 */
import { maskPii, PII_MASK } from "@agentforge/core";
import { CHAT_DOCUMENT_TEXT_MAX_CHARS } from "@agentforge/core/chat-documents";
import { type Limiter, withLimit } from "../concurrency";
import { FileExtractError, extractFile } from "../file-extract";
import type { HostFile } from "../types";
import { documentLimiter } from "./limiter";
import { cleanDocumentText, cutOnLine } from "./text";

export type ReadDocument = {
  readonly format: string;
  /** Size of the uploaded file, as received. */
  readonly bytes: number;
  /** The whole text, cleaned and masked. This is what the desk copy holds. */
  readonly fullText: string;
  /** The same text cut to the model's budget. */
  readonly sentText: string;
  readonly truncated: boolean;
  /** Tables the reader found, counted before any cut. */
  readonly tables: number;
  /** Personal details the mask replaced. */
  readonly masked: number;
};

export type ReadOptions = {
  readonly limiter?: Limiter;
  /** The request's own abort: a cancelled upload leaves the waiting room instead of queueing to run. */
  readonly signal?: AbortSignal;
};

/** How many mask tokens a text holds. The difference before and after masking is what the mask replaced. */
function countMasks(text: string): number {
  return Object.values(PII_MASK).reduce((total, token) => total + text.split(token).length - 1, 0);
}

export async function readChatDocument(file: HostFile, options: ReadOptions = {}): Promise<ReadDocument> {
  const { limiter = documentLimiter, signal } = options;
  signal?.throwIfAborted();
  const extracted = await withLimit(
    limiter,
    () => extractFile({ bytes: file.bytes, filename: file.filename, mime: file.mime }),
    signal,
  );
  const cleaned = cleanDocumentText(extracted.markdown);
  if (cleaned === "") {
    throw new FileExtractError("empty");
  }
  // One scan: `maskPii` finds the details, and what it replaced is counted from the tokens it left.
  const fullText = maskPii(cleaned);
  const { text: sentText, cut } = cutOnLine(fullText, CHAT_DOCUMENT_TEXT_MAX_CHARS);
  return {
    format: extracted.format,
    bytes: file.bytes.byteLength,
    fullText,
    sentText,
    truncated: cut,
    tables: extracted.tables.length,
    masked: Math.max(0, countMasks(fullText) - countMasks(cleaned)),
  };
}
