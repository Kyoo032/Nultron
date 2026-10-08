/**
 * The composer's accept list and the host's reader cannot drift: both are built from core's table,
 * and these tests fail if the table names something the reader cannot open or the reader's caps and
 * the composer's disagree.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_DOCUMENT_MAX_BYTES,
  DOCUMENT_FORMAT_BY_EXTENSION,
} from "@agentforge/core/chat-documents";
import { FILE_EXTRACT_MAX_BYTES, detectFormat } from "../file-extract";
import { loadAnydoc } from "../file-extract/anydoc";

describe("the composer's documents and the host's reader", () => {
  it("share one byte cap", () => {
    expect(CHAT_DOCUMENT_MAX_BYTES).toBe(FILE_EXTRACT_MAX_BYTES);
  });

  it("name every extension to a format the native converter knows", () => {
    const anydoc = loadAnydoc();
    for (const [extension, format] of Object.entries(DOCUMENT_FORMAT_BY_EXTENSION)) {
      expect(anydoc.formatFromExtension(extension), extension).toBe(format);
    }
  });

  it("name every extension for the fallback reader too, from the same table", () => {
    for (const extension of CHAT_DOCUMENT_EXTENSIONS) {
      const expected = DOCUMENT_FORMAT_BY_EXTENSION[extension];
      const bytes = expected === "rtf" ? new TextEncoder().encode("{\\rtf1 hi}") : signatureFor(expected);
      expect(detectFormat(`file.${extension}`, bytes, null), extension).toBe(expected);
    }
  });
});

/** The first bytes of each container, enough for `detectFormat`'s name-versus-bytes check. */
function signatureFor(format: string): Uint8Array {
  if (format === "pdf") {
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  }
  if (format === "doc" || format === "ppt") {
    return new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]);
  }
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
}
