import { describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { CHAT_DOCUMENT_ERROR_CODES, isChatDocumentErrorCode } from "@agentforge/core/chat-documents";
import { FileExtractError, type FileExtractErrorCode } from "../file-extract";
import { chatDocumentError } from "./errors";

const EVERY_CODE: ReadonlyArray<FileExtractErrorCode> = [
  "unsupported",
  "format_mismatch",
  "needs_ocr",
  "malformed",
  "encrypted",
  "resource_limit",
  "missing_part",
  "too_large",
  "timeout",
  "empty",
];

describe("chatDocumentError", () => {
  it("maps every reader failure to one of the codes the composer has copy for", () => {
    for (const code of EVERY_CODE) {
      const mapped = chatDocumentError(new FileExtractError(code));
      expect(mapped).toBeInstanceOf(ApiError);
      expect(isChatDocumentErrorCode(mapped.code), code).toBe(true);
    }
  });

  it("says too large with 413 and everything else with 400", () => {
    expect(chatDocumentError(new FileExtractError("too_large")).status).toBe(413);
    for (const code of EVERY_CODE.filter((item) => item !== "too_large")) {
      expect(chatDocumentError(new FileExtractError(code)).status, code).toBe(400);
    }
  });

  it("keeps the five cases a person can act on distinct", () => {
    const codes = new Map(EVERY_CODE.map((code) => [code, chatDocumentError(new FileExtractError(code)).code]));
    expect(codes.get("too_large")).toBe("document_too_large");
    expect(codes.get("unsupported")).toBe("document_unsupported");
    expect(codes.get("format_mismatch")).toBe("document_mismatch");
    expect(codes.get("needs_ocr")).toBe("document_needs_ocr");
    expect(codes.get("encrypted")).toBe("document_encrypted");
    expect(codes.get("empty")).toBe("document_empty");
    expect(codes.get("timeout")).toBe("document_slow");
    expect(codes.get("malformed")).toBe("document_unreadable");
  });

  it("passes the host's busy answer through unchanged", () => {
    const busy = new ApiError("too_many_jobs", "Too many document jobs are already queued.", 429);
    expect(chatDocumentError(busy)).toBe(busy);
  });

  it("turns anything unexpected into the unreadable answer, with no detail", () => {
    const mapped = chatDocumentError(new Error("ENOENT: C:\\Users\\rizky\\secret.pdf"));
    expect(mapped.code).toBe("document_unreadable");
    expect(mapped.message).not.toContain("secret");
  });

  it("never invents a code outside the shared list", () => {
    expect(CHAT_DOCUMENT_ERROR_CODES.length).toBeGreaterThan(5);
  });
});
