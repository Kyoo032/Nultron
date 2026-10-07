/**
 * Reader failures as the route's answers.
 *
 * The composer shows its own catalog copy for each `document_*` code, in either language, so the
 * message here is only the fallback an old renderer would print. Every message is a fixed sentence:
 * the reader's own detail can quote a path or a byte, and none of it is passed on.
 */
import { ApiError } from "@agentforge/core";
import type { ChatDocumentErrorCode } from "@agentforge/core/chat-documents";
import { FileExtractError, type FileExtractErrorCode } from "../file-extract";

type Answer = { readonly code: ChatDocumentErrorCode; readonly status: number; readonly message: string };

const ANSWERS: Readonly<Record<FileExtractErrorCode, Answer>> = {
  too_large: { code: "document_too_large", status: 413, message: "That file is over the size limit." },
  unsupported: { code: "document_unsupported", status: 400, message: "That file type cannot be read here." },
  format_mismatch: {
    code: "document_mismatch",
    status: 400,
    message: "That file is not really the type its name claims.",
  },
  needs_ocr: {
    code: "document_needs_ocr",
    status: 400,
    message: "This PDF is scanned and has no text to read. Nothing was sent anywhere.",
  },
  encrypted: {
    code: "document_encrypted",
    status: 400,
    message: "That file is password protected. Remove the password and try again.",
  },
  empty: { code: "document_empty", status: 400, message: "There is no text in that file." },
  timeout: { code: "document_slow", status: 400, message: "That file took too long to read." },
  malformed: { code: "document_unreadable", status: 400, message: "That file could not be read." },
  resource_limit: { code: "document_unreadable", status: 400, message: "That file could not be read safely." },
  missing_part: { code: "document_unreadable", status: 400, message: "That file could not be read." },
};

const UNREADABLE = ANSWERS.malformed;

function asApiError(answer: Answer): ApiError {
  return new ApiError(answer.code, answer.message, answer.status);
}

/** The API error for anything the document route can throw. */
export function chatDocumentError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof FileExtractError) {
    return asApiError(ANSWERS[error.code]);
  }
  return asApiError(UNREADABLE);
}
