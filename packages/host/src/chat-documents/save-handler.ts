/**
 * `POST /api/v1/chat/documents/save`: the document's text as a private desk file, when the message is sent.
 *
 * The composer posts back the text the read route gave it (the whole masked text) with the file's name.
 * The host cleans and masks it again (a hostile client gets no way to skip the mask), cuts it for the
 * model, and writes `uploads/~<user>/<name>.md` through the desk root, versioned and under the quota.
 * The folder comes from the signed-in person (`getTenant`), never from the request, and in server mode
 * only that person can read it back (`desk-files/private-uploads.ts`).
 *
 * It answers the notes the message carries above the attachment's header, the cut text that goes in
 * the block, and whether the file was saved. A refusal to save (quota, limits) is an answer, not an
 * error: the attachment still goes, and the notes say it was not saved.
 *
 * No gateway call, so no gate. Body: the HTTP adapter's 26 MB cap; the text itself is capped at the
 * reader's own Markdown limit.
 */
import { ApiError, maskPii } from "@agentforge/core";
import { isChatDocumentName, CHAT_DOCUMENT_TEXT_MAX_CHARS } from "@agentforge/core/chat-documents";
import { jsonError, jsonOk } from "../errors";
import { FILE_EXTRACT_MAX_MARKDOWN_CHARS } from "../file-extract/limits";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";
import { saveDeskCopy } from "./desk-copy";
import { chatDocumentError } from "./errors";
import { documentNotes } from "./notes";
import { cleanDocumentText, cutOnLine } from "./text";

const MAX_NAME_CHARS = 255;
const FORMAT = /^[a-z0-9]{1,8}$/;

type SaveInput = {
  readonly name: string;
  readonly format: string;
  readonly bytes: number;
  readonly masked: number;
  readonly text: string;
};

function whole(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function requireInput(request: HostRequest): SaveInput {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("invalid_request", "A JSON object body is required", 400);
  }
  const { name, format, text, bytes, masked } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_CHARS) {
    throw new ApiError("invalid_request", "name must be the file's name", 400);
  }
  if (!isChatDocumentName(name)) {
    throw new ApiError("document_unsupported", "That file type cannot be read here.", 400);
  }
  if (typeof format !== "string" || !FORMAT.test(format)) {
    throw new ApiError("invalid_request", "format must be the file's format", 400);
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new ApiError("document_empty", "There is no text to save.", 400);
  }
  if (text.length > FILE_EXTRACT_MAX_MARKDOWN_CHARS) {
    throw new ApiError("document_too_large", "That text is over the size limit.", 413);
  }
  return { name, format, text, bytes: whole(bytes), masked: whole(masked) };
}

export async function handlePostChatDocumentSave(request: HostRequest): Promise<HostResult> {
  try {
    const input = requireInput(request);
    const tenant = await getTenant(request);
    const fullText = maskPii(cleanDocumentText(input.text));
    const { text: sentText, cut } = cutOnLine(fullText, CHAT_DOCUMENT_TEXT_MAX_CHARS);
    const copy = await saveDeskCopy(tenant, input.name, fullText);
    const notes = documentNotes({
      format: input.format,
      bytes: input.bytes,
      chars: fullText.length,
      sentChars: sentText.length,
      masked: input.masked,
      saved: copy.ok ? { path: copy.path, partial: copy.partial } : null,
      saveError: copy.ok ? null : copy.error,
    });
    return jsonOk({
      document: {
        /** The host's notes, written above the attachment's header in the message. */
        notes,
        /** The text for the attachment block, cut to the model's budget. */
        text: sentText,
        chars: fullText.length,
        sentChars: sentText.length,
        truncated: cut,
        saved: copy.ok ? { path: copy.path, version: copy.version } : null,
        savedPartial: copy.ok ? copy.partial : false,
        saveError: copy.ok ? null : copy.error,
      },
    });
  } catch (error) {
    return jsonError(chatDocumentError(error));
  }
}
