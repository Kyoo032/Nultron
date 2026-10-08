/**
 * Meeting mode — a transcript the owner already has, as a file.
 *
 * Plain text and Markdown are read as UTF-8 (a UTF-16 byte order mark is honoured, since Windows
 * notepad writes one), WebVTT and SRT caption files become timed segments (`transcriptFromCaptions`),
 * and Word and PDF go through the one local reader (`extractFile`): a scanned PDF is refused as
 * `needs_ocr` and nothing leaves the machine. Everything here is local and free, like the pasted-text
 * route, and every refusal is a sentence in the desk language.
 */

import { ApiError, type AppLocale } from "@agentforge/core";
import {
  TRANSCRIPT_MAX_CHARS,
  transcriptFileKind,
  transcriptFileMessage,
  transcriptFromCaptions,
  type TranscriptFileProblem,
  type TranscriptSegment,
} from "@agentforge/core/meeting";
import { FileExtractError, extractFile } from "../file-extract";
import type { HostFile } from "../types";

/** What a transcript file became: the text the minutes are written from, and its timed segments if it had any. */
export type TranscriptFileContent = { text: string; segments: TranscriptSegment[] };

/** Four bytes is the most a UTF-8 character takes, so a file past this cannot fit the character cap. */
const TEXT_FILE_MAX_BYTES = TRANSCRIPT_MAX_CHARS * 4;

type Refusal = { readonly code: string; readonly status: number };

const REFUSALS: Readonly<Record<TranscriptFileProblem, Refusal>> = {
  missing: { code: "invalid_request", status: 400 },
  type: { code: "unsupported_content_type", status: 400 },
  empty: { code: "invalid_request", status: 400 },
  no_text: { code: "invalid_request", status: 400 },
  too_large: { code: "invalid_request", status: 413 },
  encoding: { code: "invalid_request", status: 400 },
  needs_ocr: { code: "needs_ocr", status: 400 },
  encrypted: { code: "invalid_request", status: 400 },
  unreadable: { code: "invalid_request", status: 400 },
  timeout: { code: "timeout", status: 400 },
};

function refuse(problem: TranscriptFileProblem, locale: AppLocale): ApiError {
  const { code, status } = REFUSALS[problem];
  return new ApiError(code, transcriptFileMessage(problem, locale, TRANSCRIPT_MAX_CHARS), status);
}

/** How each way a document can fail to be read is put to the owner. */
const EXTRACT_PROBLEM: Readonly<Record<FileExtractError["code"], TranscriptFileProblem>> = {
  unsupported: "type",
  format_mismatch: "type",
  needs_ocr: "needs_ocr",
  malformed: "unreadable",
  encrypted: "encrypted",
  resource_limit: "unreadable",
  missing_part: "unreadable",
  too_large: "too_large",
  timeout: "timeout",
  empty: "empty",
};

const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** UTF-8 (with or without a byte order mark) or UTF-16 with one. Anything else is not text we can trust. */
function decodeText(bytes: Uint8Array): string | null {
  const encoding = startsWith(bytes, UTF16_LE_BOM)
    ? "utf-16le"
    : startsWith(bytes, UTF16_BE_BOM)
      ? "utf-16be"
      : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function documentText(file: HostFile, locale: AppLocale): Promise<string> {
  try {
    return (await extractFile({ bytes: file.bytes, filename: file.filename, mime: file.mime })).text;
  } catch (error) {
    if (error instanceof FileExtractError) {
      throw refuse(EXTRACT_PROBLEM[error.code], locale);
    }
    throw error;
  }
}

function contentOf(text: string, segments: TranscriptSegment[], locale: AppLocale): TranscriptFileContent {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") {
    throw refuse("no_text", locale);
  }
  if (trimmed.length > TRANSCRIPT_MAX_CHARS) {
    throw refuse("too_large", locale);
  }
  return { text: trimmed, segments };
}

/** Read one uploaded file into a transcript. Throws an `ApiError` the desk can show, in `locale`. */
export async function readTranscriptFile(
  file: HostFile | undefined,
  locale: AppLocale,
): Promise<TranscriptFileContent> {
  if (!file) {
    throw refuse("missing", locale);
  }
  const kind = transcriptFileKind(file.filename);
  if (!kind) {
    throw refuse("type", locale);
  }
  if (file.bytes.byteLength === 0) {
    throw refuse("empty", locale);
  }
  if (kind === "document") {
    return contentOf(await documentText(file, locale), [], locale);
  }
  if (file.bytes.byteLength > TEXT_FILE_MAX_BYTES) {
    throw refuse("too_large", locale);
  }
  const decoded = decodeText(file.bytes);
  if (decoded === null) {
    throw refuse("encoding", locale);
  }
  if (kind === "text") {
    return contentOf(decoded, [], locale);
  }
  const captions = transcriptFromCaptions(decoded);
  return contentOf(captions.text, captions.segments, locale);
}
