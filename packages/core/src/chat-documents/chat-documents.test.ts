import { describe, expect, it } from "vitest";
import {
  CHAT_DOCUMENT_ACCEPT,
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_DOCUMENT_MAX_BYTES,
  CHAT_DOCUMENT_TEXT_MAX_CHARS,
  CHAT_DOCUMENTS_PER_MESSAGE,
  DOCUMENT_FORMAT_BY_EXTENSION,
  documentExtension,
  isChatDocumentErrorCode,
  isChatDocumentName,
} from "./index";

describe("the documents Chat reads", () => {
  it("lists every format the reader converts, except csv", () => {
    expect([...CHAT_DOCUMENT_EXTENSIONS].sort()).toEqual(
      ["doc", "docx", "epub", "odp", "ods", "odt", "pdf", "ppt", "pptx", "rtf", "xls", "xlsm", "xlsx"].sort(),
    );
    expect(CHAT_DOCUMENT_EXTENSIONS).not.toContain("csv");
    expect(DOCUMENT_FORMAT_BY_EXTENSION.csv).toBe("csv");
  });

  it("builds the accept list from the same extensions, dotted", () => {
    const accept = CHAT_DOCUMENT_ACCEPT.split(",");
    expect(accept).toHaveLength(CHAT_DOCUMENT_EXTENSIONS.length);
    for (const extension of CHAT_DOCUMENT_EXTENSIONS) {
      expect(accept).toContain(`.${extension}`);
    }
  });

  it("reads a legacy or macro workbook as a workbook", () => {
    expect(DOCUMENT_FORMAT_BY_EXTENSION.xls).toBe("xlsx");
    expect(DOCUMENT_FORMAT_BY_EXTENSION.xlsm).toBe("xlsx");
  });

  it("names a document by its extension, whatever the case or the folders in the name", () => {
    expect(documentExtension("Q3 Report.PDF")).toBe("pdf");
    expect(documentExtension("C:\\files\\plan.docx")).toBe("docx");
    expect(documentExtension("archive.tar.pdf")).toBe("pdf");
    expect(documentExtension("noextension")).toBe("");
    expect(documentExtension(".hidden")).toBe("");
    expect(isChatDocumentName("Q3 Report.PDF")).toBe(true);
    expect(isChatDocumentName("deck.pptx")).toBe(true);
    expect(isChatDocumentName("book.epub")).toBe(true);
  });

  it("leaves text, csv, media and unknown names alone", () => {
    for (const name of ["notes.txt", "notes.md", "data.csv", "data.json", "photo.png", "clip.mp4", "run.exe", "x"]) {
      expect(isChatDocumentName(name)).toBe(false);
    }
  });

  it("keeps the caps sane", () => {
    expect(CHAT_DOCUMENT_MAX_BYTES).toBe(25_000_000);
    expect(CHAT_DOCUMENT_TEXT_MAX_CHARS).toBeGreaterThan(10_000);
    expect(CHAT_DOCUMENTS_PER_MESSAGE * CHAT_DOCUMENT_TEXT_MAX_CHARS).toBeLessThanOrEqual(200_000);
  });

  it("knows its own error codes and nothing else", () => {
    expect(isChatDocumentErrorCode("document_needs_ocr")).toBe(true);
    expect(isChatDocumentErrorCode("too_many_jobs")).toBe(true);
    expect(isChatDocumentErrorCode("anything_else")).toBe(false);
    expect(isChatDocumentErrorCode(undefined)).toBe(false);
  });
});
