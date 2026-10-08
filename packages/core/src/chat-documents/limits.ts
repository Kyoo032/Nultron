/**
 * Caps for a document attached in Chat, in one place for the composer and the host.
 */

/**
 * Largest document read. It is the cap the local reader already enforces (`FILE_EXTRACT_MAX_BYTES`,
 * `packages/host/src/file-extract/limits.ts`), and the host's test fails if the two ever differ.
 */
export const CHAT_DOCUMENT_MAX_BYTES = 25_000_000;

/**
 * Most characters of one document that go to the model in the message. A longer document is cut on
 * a line boundary, the model and the person are told by how much, and the whole text stays on the
 * desk as a file the file tools can read. About 15 000 tokens, so three documents leave room for the
 * conversation in a 128k window.
 */
export const CHAT_DOCUMENT_TEXT_MAX_CHARS = 60_000;

/** Documents in one message. Three, so the budget above cannot be multiplied past a window. */
export const CHAT_DOCUMENTS_PER_MESSAGE = 3;

/** The desk folder a document's text is saved in. */
export const CHAT_DOCUMENT_DESK_DIR = "uploads";

/** The one request field the upload route reads. */
export const CHAT_DOCUMENT_FIELD = "file";

/** `POST` target for one document. The host registers it; the composer calls it through `apiFetch`. */
export const CHAT_DOCUMENT_ROUTE = "/api/v1/chat/documents";

/** `POST` target that saves a read document's text as a private desk file, when the message is sent. */
export const CHAT_DOCUMENT_SAVE_ROUTE = "/api/v1/chat/documents/save";

/**
 * The most characters of a pasted or attached plain text file (`.txt .md .csv .json`) that go to the
 * model in one message. The same budget as a document, so a text file cannot blow the window that a
 * document is held to.
 */
export const CHAT_TEXT_ATTACHMENT_MAX_CHARS = CHAT_DOCUMENT_TEXT_MAX_CHARS;

/**
 * Error codes the route answers with, so the renderer can show its own catalog copy in either
 * language instead of the host's English sentence.
 */
export const CHAT_DOCUMENT_ERROR_CODES = [
  "document_too_large",
  "document_unsupported",
  "document_mismatch",
  "document_needs_ocr",
  "document_encrypted",
  "document_empty",
  "document_unreadable",
  "document_slow",
  "too_many_jobs",
] as const;

export type ChatDocumentErrorCode = (typeof CHAT_DOCUMENT_ERROR_CODES)[number];

/** Why the desk copy of a document was not written. The route answers one of these, never a message. */
export const CHAT_DOCUMENT_SAVE_FAILURES = ["quota", "too_large", "too_many_files", "unavailable", "denied"] as const;

export type ChatDocumentSaveFailure = (typeof CHAT_DOCUMENT_SAVE_FAILURES)[number];

export function isChatDocumentErrorCode(value: unknown): value is ChatDocumentErrorCode {
  return typeof value === "string" && (CHAT_DOCUMENT_ERROR_CODES as ReadonlyArray<string>).includes(value);
}
