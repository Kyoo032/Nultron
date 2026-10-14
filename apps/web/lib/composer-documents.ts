/**
 * An attached document, from the composer's side.
 *
 * Two host calls, one when the file is attached and one when the message is sent:
 *
 *   1. `POST /api/v1/chat/documents` reads the file locally and answers the text Chat will send (cut to
 *      the model's budget) and what it counted. It writes nothing, so a document that is attached and
 *      then removed leaves no file behind.
 *   2. `POST /api/v1/chat/documents/save` runs when Send is pressed. It saves the whole text as a
 *      private desk file and answers the host's notes (what the file is, where it is saved, how much was
 *      cut) and the text for the block. The notes go ABOVE the `--- name ---` header, outside the block,
 *      so they are the host's voice and a document cannot forge one from inside.
 *
 * This file is everything the composer needs around those calls: the requests, the shape of an
 * attachment's read state (reading, ready or failed), the catalog copy for each way a call can fail,
 * and the small pure rules the composer asks (which documents still need reading, whether Send must
 * wait, whether another document fits in the message).
 *
 * Nothing here reads a document's bytes in the browser: the file goes to the host as a multipart
 * upload, through `apiFetch`, which is HTTP on the web and the IPC bridge in the packaged app. A plain
 * text file is read in the browser as it always was, and held to the same budget (`cutTextAttachment`).
 */
import {
  CHAT_DOCUMENT_FIELD,
  CHAT_DOCUMENT_MAX_BYTES,
  CHAT_DOCUMENT_ROUTE,
  CHAT_DOCUMENT_SAVE_ROUTE,
  CHAT_DOCUMENTS_PER_MESSAGE,
  cutTextAttachment,
} from "@agentforge/core/chat-documents";
import { deleteArtifact } from "./artifacts-client";
import { apiFetch } from "./api-client";
import { t } from "./i18n";

/** Why the host did not keep a Word, Excel or PDF file's original (`original.ts` on the host). */
const ORIGINAL_SKIP_REASONS = ["too_large", "quota", "unavailable"] as const;
export type OriginalSkipReason = (typeof ORIGINAL_SKIP_REASONS)[number];

/** An artifact id as the host mints it: a lowercase UUID. */
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the host answered when it read one document, as the composer keeps it. */
export type ChatDocumentResult = {
  readonly format: string;
  /** Size of the uploaded file, as the host received it. */
  readonly bytes: number;
  /** The text Chat sends: masked, and cut to the model's budget. */
  readonly text: string;
  /** The whole masked text, only when `text` was cut; the save call hands it back to be written. */
  readonly fullText: string | null;
  /** Characters in the whole document. */
  readonly chars: number;
  /** Characters of it that are in `text`. */
  readonly sentChars: number;
  readonly truncated: boolean;
  /** Personal details the host masked. */
  readonly masked: number;
  /** The artifact that keeps the file's own bytes, private to the person who attached it (K-D21). */
  readonly originalId: string | null;
  /** Why the original was not kept, for a format that has one. */
  readonly originalSkipped: OriginalSkipReason | null;
};

/** What the host answered when the message was sent: its notes, and the text for the attachment block. */
export type SavedChatDocument = {
  /** The host's bracketed lines, ending with a blank line, for the message above the block's header. */
  readonly notes: string;
  readonly text: string;
};

/** The catalog keys under `chat.document.errors`. */
export type DocumentErrorKey =
  | "too_large"
  | "unsupported"
  | "mismatch"
  | "needs_ocr"
  | "encrypted"
  | "empty"
  | "unreadable"
  | "slow"
  | "busy"
  | "failed"
  /** The desk copy could not be asked for when Send was pressed, so the message did not go. */
  | "send";

export type DocumentRead =
  | { readonly status: "reading" }
  | { readonly status: "ready"; readonly result: ChatDocumentResult }
  | { readonly status: "failed"; readonly error: DocumentErrorKey };

/** A read or a save that failed, carrying the catalog key rather than a sentence. */
export class ChatDocumentError extends Error {
  readonly key: DocumentErrorKey;

  constructor(key: DocumentErrorKey) {
    super(key);
    this.name = "ChatDocumentError";
    this.key = key;
  }
}

const KEY_BY_CODE: Readonly<Record<string, DocumentErrorKey>> = {
  document_too_large: "too_large",
  document_unsupported: "unsupported",
  document_mismatch: "mismatch",
  document_needs_ocr: "needs_ocr",
  document_encrypted: "encrypted",
  document_empty: "empty",
  document_unreadable: "unreadable",
  document_slow: "slow",
  too_many_jobs: "busy",
};

/** The catalog key for the host's `error.code`. A bare 413 (a proxy's own refusal) reads as too large. */
export function documentErrorKey(code: unknown, status: number): DocumentErrorKey {
  if (typeof code === "string" && KEY_BY_CODE[code]) {
    return KEY_BY_CODE[code];
  }
  return status === 413 ? "too_large" : "failed";
}

/** Only these are worth a second try: the file is fine, the moment was not. */
export function isRetryable(key: DocumentErrorKey): boolean {
  return key === "slow" || key === "busy" || key === "failed";
}

/** The catalog key for a failed save: a general failure there is "could not be sent", not "could not be read". */
function saveErrorKey(code: unknown, status: number): DocumentErrorKey {
  const key = documentErrorKey(code, status);
  return key === "failed" ? "send" : key;
}

/** The sentence for a failed read or save, in the person's language. */
export function documentErrorMessage(key: DocumentErrorKey): string {
  return t(`chat.document.errors.${key}`, { mb: CHAT_DOCUMENT_MAX_BYTES / 1_000_000 });
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function documentOf(payload: unknown): Record<string, unknown> | null {
  const document = (payload as { document?: unknown } | null)?.document;
  return document && typeof document === "object" ? (document as Record<string, unknown>) : null;
}

function originalIdOf(value: unknown): string | null {
  return typeof value === "string" && ARTIFACT_ID.test(value) ? value : null;
}

function originalSkipOf(value: unknown): OriginalSkipReason | null {
  return ORIGINAL_SKIP_REASONS.find((reason) => reason === value) ?? null;
}

/** Never trust the wire: a malformed answer is null, so the composer says "could not read" instead. */
export function parseChatDocument(payload: unknown): ChatDocumentResult | null {
  const record = documentOf(payload);
  if (!record || typeof record.text !== "string" || typeof record.format !== "string") {
    return null;
  }
  const pii = record.pii as { count?: unknown } | null | undefined;
  return {
    format: record.format,
    bytes: count(record.bytes),
    text: record.text,
    fullText: typeof record.fullText === "string" ? record.fullText : null,
    chars: count(record.chars),
    sentChars: count(record.sentChars),
    truncated: record.truncated === true,
    masked: count(pii?.count),
    originalId: originalIdOf(record.originalId),
    originalSkipped: originalSkipOf(record.originalSkipped),
  };
}

/** The save call's answer, or null when it is not what was promised. */
export function parseSavedChatDocument(payload: unknown): SavedChatDocument | null {
  const record = documentOf(payload);
  if (!record || typeof record.notes !== "string" || typeof record.text !== "string") {
    return null;
  }
  return { notes: record.notes, text: record.text };
}

function errorCodeOf(payload: unknown): unknown {
  return (payload as { error?: { code?: unknown } } | null)?.error?.code;
}

/**
 * Send one document to the host and get its text back. Rejects with {@link ChatDocumentError}.
 * An empty file or one over the cap is refused here, so an obvious mistake never leaves the machine;
 * the host checks the same things again, plus the real bytes.
 */
export async function readChatDocument(file: File): Promise<ChatDocumentResult> {
  if (file.size === 0) {
    throw new ChatDocumentError("empty");
  }
  if (file.size > CHAT_DOCUMENT_MAX_BYTES) {
    throw new ChatDocumentError("too_large");
  }
  const form = new FormData();
  form.append(CHAT_DOCUMENT_FIELD, file, file.name);
  let response: Response;
  try {
    response = await apiFetch(CHAT_DOCUMENT_ROUTE, { method: "POST", body: form });
  } catch {
    throw new ChatDocumentError("failed");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ChatDocumentError(documentErrorKey(errorCodeOf(payload), response.status));
  }
  const parsed = parseChatDocument(payload);
  if (!parsed) {
    throw new ChatDocumentError("failed");
  }
  return parsed;
}

/**
 * The block a document becomes in the message: the same `--- name ---` header a text file gets, so
 * the host's injection guard, the thread's file card and a reload all treat it the same way.
 */
export function attachmentBlock(name: string, body: string): string {
  return `--- ${name.replace(/[\r\n]+/g, " ")} ---\n${body}`;
}

type Held = { readonly id: string; readonly kind: string; readonly read?: DocumentRead };

/**
 * Save a document that was read, as the message is sent. The host writes the whole text as the
 * person's private desk file and answers its notes and the text for the block. Rejects with
 * {@link ChatDocumentError}, so the composer can say why and leave the draft where it is: a failed
 * save is a failed send, never a message that quietly goes without the file.
 */
export async function saveChatDocument(name: string, result: ChatDocumentResult): Promise<SavedChatDocument> {
  let response: Response;
  try {
    response = await apiFetch(CHAT_DOCUMENT_SAVE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        format: result.format,
        bytes: result.bytes,
        masked: result.masked,
        text: result.fullText ?? result.text,
        originalId: result.originalId,
        originalSkipped: result.originalSkipped,
      }),
    });
  } catch {
    throw new ChatDocumentError("send");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ChatDocumentError(saveErrorKey(errorCodeOf(payload), response.status));
  }
  const saved = parseSavedChatDocument(payload);
  if (!saved) {
    throw new ChatDocumentError("send");
  }
  return saved;
}

/**
 * Removing a chip before Send takes the original the host kept at attach with it (K-D21), so it does not
 * stay in the person's storage. Nothing is deleted while a send is in flight (`sendInFlight`): the message
 * may already name that original. A delete that fails is logged, never shown, and never stops the chip from
 * going; the original then stays as the person's own artifact.
 */
export async function discardChipOriginal(read: DocumentRead | undefined, sendInFlight: boolean): Promise<void> {
  if (sendInFlight || read?.status !== "ready" || read.result.originalId === null) {
    return;
  }
  try {
    await deleteArtifact(read.result.originalId);
  } catch (error) {
    console.warn("Chat: a removed file's kept original could not be deleted", error);
  }
}

/**
 * What one inlined attachment becomes in the message: the host's notes (when it has any), a blank
 * line, then the `--- name ---` block. The notes sit above the header, outside the block.
 *
 * A document was read by the host when it was attached and is saved now, so its text and notes are
 * the host's; a document that was never read is null, and is never read as text here (its bytes are
 * binary). A text file is read in the browser as it always was, cut to the same budget as a document
 * (`cutTextAttachment`), with a note when it was. Rejects with {@link ChatDocumentError} when a document
 * cannot be saved.
 */
export async function inlineBlock(held: {
  readonly file: File;
  readonly kind: string;
  readonly read?: DocumentRead;
}): Promise<string | null> {
  const { name } = held.file;
  if (held.kind === "document") {
    if (held.read?.status !== "ready") {
      return null;
    }
    const saved = await saveChatDocument(name, held.read.result);
    return `${saved.notes}${attachmentBlock(name, saved.text)}`;
  }
  const cut = cutTextAttachment(await held.file.text());
  return `${cut.notes}${attachmentBlock(name, cut.text)}`;
}

/** Documents with no read state yet and no read in flight: the ones to start now. */
export function pendingDocumentIds(files: ReadonlyArray<Held>, inFlight: ReadonlySet<string>): string[] {
  return files
    .filter((item) => item.kind === "document" && item.read === undefined && !inFlight.has(item.id))
    .map((item) => item.id);
}

/** Send waits while any document is still reading or has failed: sending it would drop it silently. */
export function documentsBlockSend(files: ReadonlyArray<Held>): boolean {
  return files.some((item) => item.kind === "document" && item.read?.status !== "ready");
}

/** True when adding `incoming` more documents would put the message past its limit. */
export function documentsOverLimit(files: ReadonlyArray<Held>, incoming: number): boolean {
  const held = files.filter((item) => item.kind === "document").length;
  return held + incoming > CHAT_DOCUMENTS_PER_MESSAGE;
}

/**
 * A read state brought back from the unsent-draft stash. A read that was in flight when the pane
 * went away has no one to hear its answer, so it starts again; a finished one is kept as it was.
 */
export function restoreDocumentRead(value: unknown): DocumentRead | undefined {
  const status = (value as { status?: unknown } | null)?.status;
  return status === "ready" || status === "failed" ? (value as DocumentRead) : undefined;
}
