/**
 * `POST /api/v1/chat/documents`: one document from the Chat composer, read on this machine.
 *
 * It answers the text Chat will send (cut to the model's budget) and what it counted. The desk copy of
 * the text is saved when the message is sent (`save-handler.ts`), so attaching and then removing a
 * document leaves no desk file behind. The one thing kept here is the file's original bytes, for a Word,
 * Excel or PDF file (`original.ts`): this request is the only place they exist. The answer carries the
 * kept original's id, or why it was not kept. Nothing is sent to a model here, so there is deliberately
 * no `requireGatewayAllowed()`: a closed gate must never stop a person reading a file that never leaves
 * their machine (the same call `finance/import` makes).
 *
 * Which limits apply, all of them existing ones:
 *   - request body: 26 MB at the HTTP adapter (`MAX_BODY_BYTES`); the IPC bridge has no cap of its own;
 *   - the file: 25 MB (`CHAT_DOCUMENT_MAX_BYTES`, equal to the reader's), 20 s to answer;
 *   - native conversions: at most 2 at once hosted (3 on a desk), held until the native call itself
 *     ends, not until the deadline, and 429 `too_many_jobs` past that (`file-extract/native-gate.ts`);
 *   - concurrency: `documentLimiter`, bounded on the hosted server and off on a desk;
 *   - request rate: the hosted per-IP and per-session buckets in `rate-limit.ts`.
 *
 * One upload convention, the one the dataset, legal and finance routes use: a single multipart file
 * under the field `file`, surfaced by the adapter (or the IPC bridge) as `request.files`.
 */
import { ApiError } from "@agentforge/core";
import { CHAT_DOCUMENT_FIELD, CHAT_DOCUMENT_MAX_BYTES, isChatDocumentName } from "@agentforge/core/chat-documents";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostFile, HostRequest, HostResult } from "../types";
import { chatDocumentError } from "./errors";
import { keepOriginal } from "./original";
import { readChatDocument } from "./read";

function requireUpload(request: HostRequest): HostFile {
  const file = request.files?.find((item) => item.field === CHAT_DOCUMENT_FIELD) ?? request.files?.[0];
  if (!file) {
    throw new ApiError("invalid_request", `Attach one document under the field "${CHAT_DOCUMENT_FIELD}"`, 400);
  }
  if (file.bytes.byteLength === 0) {
    throw new ApiError("document_empty", "That file is empty.", 400);
  }
  if (file.bytes.byteLength > CHAT_DOCUMENT_MAX_BYTES) {
    throw new ApiError("document_too_large", "That file is over the size limit.", 413);
  }
  if (!isChatDocumentName(file.filename)) {
    throw new ApiError("document_unsupported", "That file type cannot be read here.", 400);
  }
  return file;
}

export async function handlePostChatDocument(request: HostRequest): Promise<HostResult> {
  try {
    const file = requireUpload(request);
    // The original is kept for the person who attached it, so the request needs that person (a 401 on the
    // hosted server with no session; the desk's one owner otherwise).
    const tenant = await getTenant(request);
    const read = await readChatDocument(file, { signal: request.abortSignal });
    const original = await keepOriginal(tenant, file, read.format);
    return jsonOk({
      document: {
        name: file.filename,
        format: read.format,
        bytes: read.bytes,
        /** What the model gets, cut to its budget. */
        text: read.sentText,
        /** The whole masked text, only when it was cut; the composer hands it back to be saved. */
        ...(read.truncated ? { fullText: read.fullText } : {}),
        chars: read.fullText.length,
        sentChars: read.sentText.length,
        truncated: read.truncated,
        tables: read.tables,
        pii: { count: read.masked },
        /** The kept original's artifact id, or null when none was kept (`originalSkipped` says why). */
        originalId: original?.id ?? null,
        originalSkipped: original?.skipped ?? null,
      },
    });
  } catch (error) {
    return jsonError(chatDocumentError(error));
  }
}
