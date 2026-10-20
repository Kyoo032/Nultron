/**
 * The attachment chip in the composer: a plain one for text and media, and the document chip with its
 * three states (reading, ready, failed). The environment is node, so this renders to markup and holds
 * the testids and the words the verify recipe and the person depend on; the click behaviour is the
 * two callbacks, driven in the browser (`features/chat.md`, "Documents").
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerAttachmentChip } from "@/components/composer-attachment-chip";
import type { ChatDocumentResult, DocumentRead } from "./composer-documents";
import { applyLocale, resetLocaleForTests } from "./i18n";

const READY: ChatDocumentResult = {
  format: "pdf",
  bytes: 1_258_291,
  text: "t",
  fullText: null,
  chars: 5_000,
  sentChars: 5_000,
  truncated: false,
  masked: 0,
  originalId: null,
  originalSkipped: null,
  figures: null,
  figuresSkipped: null,
};

function chip(kind: string, name: string, read?: DocumentRead, size = 1_258_291): string {
  const file = new File([new Uint8Array(4)], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return renderToStaticMarkup(
    <ComposerAttachmentChip
      item={{ id: "one", file, kind: kind as "document", read }}
      onRemove={() => {}}
      onRetry={() => {}}
    />,
  );
}

afterEach(() => resetLocaleForTests());

describe("a plain attachment", () => {
  it("keeps the chip, its name and a named remove control", () => {
    const html = chip("text", "notes.txt");
    expect(html).toContain('data-testid="composer-attachment"');
    expect(html).toContain('data-kind="text"');
    expect(html).toContain("notes.txt");
    expect(html).toContain('data-testid="composer-attachment-remove"');
    expect(html).toContain('aria-label="Remove notes.txt"');
    expect(html).not.toContain("composer-attachment-spinner");
  });
});

describe("a document that is being read", () => {
  it("shows a spinner and the name, with the remove control still there", () => {
    const html = chip("document", "Q3 report.pdf", { status: "reading" });
    expect(html).toContain('data-testid="composer-attachment"');
    expect(html).toContain('data-kind="document"');
    expect(html).toContain('data-state="reading"');
    expect(html).toContain('data-testid="composer-attachment-spinner"');
    expect(html).toContain("Q3 report.pdf");
    expect(html).toContain("PDF");
    expect(html).toContain("1.2 MB");
    expect(html).toContain('data-testid="composer-attachment-remove"');
    expect(html).not.toContain("composer-attachment-error");
  });

  it("reads a document with no state yet as reading", () => {
    expect(chip("document", "a.docx")).toContain('data-state="reading"');
  });
});

describe("a document that was read", () => {
  it("shows no spinner and no notes when nothing needs saying", () => {
    const html = chip("document", "Q3 report.pdf", { status: "ready", result: READY });
    expect(html).toContain('data-state="ready"');
    expect(html).not.toContain("composer-attachment-spinner");
    expect(html).not.toContain("composer-attachment-note");
    expect(html).not.toContain("composer-attachment-error");
  });

  it("says how much was cut", () => {
    const html = chip("document", "Q3 report.pdf", {
      status: "ready",
      result: { ...READY, chars: 340_000, sentChars: 60_000, truncated: true },
    });
    expect(html).toContain('data-testid="composer-attachment-note"');
    expect(html).toContain("Only the first 60,000 of 340,000 characters are sent.");
  });

  it("makes no claim about the desk copy: it is written when the message is sent, and the host says how it went", () => {
    const html = chip("document", "Q3 report.pdf", {
      status: "ready",
      result: { ...READY, chars: 340_000, sentChars: 60_000, truncated: true },
    });
    expect(html).not.toContain("on your desk");
    expect(html).not.toContain("Not saved");
    expect(html).not.toContain("uploads/");
  });

  it("says nothing about a document that fits and has nothing hidden", () => {
    const html = chip("document", "a.docx", { status: "ready", result: READY });
    expect(html).not.toContain("composer-attachment-note");
  });

  it("counts the personal details it hid, one and many", () => {
    const many = chip("document", "a.docx", { status: "ready", result: { ...READY, masked: 3 } });
    expect(many).toContain("3 personal details hidden before sending.");
    const one = chip("document", "a.docx", { status: "ready", result: { ...READY, masked: 1 } });
    expect(one).toContain("1 personal detail hidden before sending.");
  });

  it("says in one short note that only the text was kept, when the original was not", () => {
    const html = chip("document", "a.docx", { status: "ready", result: { ...READY, originalSkipped: "too_large" } });
    expect(html).toContain('data-testid="composer-attachment-note"');
    expect(html).toContain("Only the text was kept, not the original file.");
    expect(html).not.toContain("Original file");
  });

  it("says nothing about the original when it was kept", () => {
    const html = chip("document", "a.docx", {
      status: "ready",
      result: { ...READY, originalId: "0b6f0e7a-3c1d-4f5e-9a2b-7c8d9e0f1a2b" },
    });
    expect(html).not.toContain("Only the text was kept");
    expect(html).not.toContain("composer-attachment-note");
  });
});

describe("a document that could not be read", () => {
  it("shows the reason as an alert, with a remove control, and no spinner", () => {
    const html = chip("document", "scan.pdf", { status: "failed", error: "needs_ocr" });
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('data-testid="composer-attachment-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("This PDF is a scan with no text to read.");
    expect(html).toContain('data-testid="composer-attachment-remove"');
    expect(html).not.toContain("composer-attachment-spinner");
  });

  it("offers Try again only when trying again could work", () => {
    expect(chip("document", "a.pdf", { status: "failed", error: "slow" })).toContain(
      'data-testid="composer-attachment-retry"',
    );
    expect(chip("document", "a.pdf", { status: "failed", error: "failed" })).toContain(
      'data-testid="composer-attachment-retry"',
    );
    expect(chip("document", "a.pdf", { status: "failed", error: "needs_ocr" })).not.toContain(
      "composer-attachment-retry",
    );
    expect(chip("document", "a.pdf", { status: "failed", error: "encrypted" })).not.toContain(
      "composer-attachment-retry",
    );
  });

  it("states the size limit in the too-large copy", () => {
    expect(chip("document", "big.pdf", { status: "failed", error: "too_large" })).toContain("25 MB");
  });
});

describe("in Bahasa Indonesia", () => {
  it("shows the reason and the remove name in Indonesian", () => {
    applyLocale("id");
    const html = chip("document", "scan.pdf", { status: "failed", error: "encrypted" });
    expect(html).toContain("dilindungi kata sandi");
    expect(html).toContain('aria-label="Hapus scan.pdf"');
  });

  it("says that only the text was kept in Indonesian", () => {
    applyLocale("id");
    const html = chip("document", "a.docx", { status: "ready", result: { ...READY, originalSkipped: "quota" } });
    expect(html).toContain("Hanya teksnya yang disimpan, bukan berkas aslinya.");
  });

  it("says the cut in Indonesian", () => {
    applyLocale("id");
    const html = chip("document", "a.pdf", {
      status: "ready",
      result: { ...READY, chars: 340_000, sentChars: 60_000, truncated: true },
    });
    expect(html).toContain("karakter pertama yang dikirim");
  });
});
