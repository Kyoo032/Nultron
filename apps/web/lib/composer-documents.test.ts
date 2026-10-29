import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DOCUMENT_MAX_BYTES,
  CHAT_DOCUMENT_SAVE_ROUTE,
  CHAT_DOCUMENTS_PER_MESSAGE,
  CHAT_TEXT_ATTACHMENT_MAX_CHARS,
  isHostNoteLine,
} from "@agentforge/core/chat-documents";

const apiFetch = vi.fn();
vi.mock("./api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  attachmentBlock,
  type ChatDocumentResult,
  discardChipOriginal,
  documentErrorKey,
  documentsBlockSend,
  documentsOverLimit,
  inlineBlock,
  isRetryable,
  parseChatDocument,
  parseSavedChatDocument,
  pendingDocumentIds,
  readChatDocument,
  restoreDocumentRead,
  saveChatDocument,
  type DocumentRead,
} from "./composer-documents";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

/** A kept original's artifact id, as the host answers it. */
const KEPT = "0b6f0e7a-3c1d-4f5e-9a2b-7c8d9e0f1a2b";

function fileOf(name: string, size = 10, type = "application/pdf"): File {
  return new File([new Uint8Array(size)], name, { type });
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** What the read route answers: the text cut to the budget, and the whole text only when it was cut. */
const GOOD = {
  document: {
    name: "a.pdf",
    format: "pdf",
    bytes: 10,
    text: "hello",
    chars: 5,
    sentChars: 5,
    truncated: false,
    tables: 0,
    pii: { count: 2 },
  },
};

const CUT = {
  document: {
    ...GOOD.document,
    text: "hel",
    fullText: "hello world",
    chars: 11,
    sentChars: 3,
    truncated: true,
  },
};

/** What the save route answers: the host's notes, the text for the block, and what became of the copy. */
const SAVED = {
  document: {
    notes:
      "[Document: PDF, 10 B, 5 characters.]\n[Attached file: data.]\n[Saved on this desk as uploads/~u/a.pdf.md.]\n\n",
    text: "hello",
    chars: 5,
    sentChars: 5,
    truncated: false,
    saved: { path: "uploads/~u/a.pdf.md", version: 1 },
    savedPartial: false,
    saveError: null,
  },
};

const RESULT: ChatDocumentResult = {
  format: "pdf",
  bytes: 10,
  text: "hello",
  fullText: null,
  chars: 5,
  sentChars: 5,
  truncated: false,
  masked: 2,
  originalId: null,
  originalSkipped: null,
  figures: null,
  figuresSkipped: null,
};

beforeEach(() => {
  apiFetch.mockReset();
  resetLocaleForTests();
});

afterEach(() => {
  resetLocaleForTests();
});

describe("parseChatDocument", () => {
  it("reads the route's answer", () => {
    expect(parseChatDocument(GOOD)).toEqual(RESULT);
  });

  it("keeps the whole text when the host cut it, so it can be saved", () => {
    const parsed = parseChatDocument(CUT);
    expect(parsed?.text).toBe("hel");
    expect(parsed?.fullText).toBe("hello world");
    expect(parsed?.truncated).toBe(true);
    expect(parsed?.chars).toBe(11);
    expect(parsed?.sentChars).toBe(3);
  });

  it("has no whole text when nothing was cut", () => {
    expect(parseChatDocument(GOOD)?.fullText).toBeNull();
  });

  it("never trusts the wire: a malformed answer is null", () => {
    expect(parseChatDocument(null)).toBeNull();
    expect(parseChatDocument({})).toBeNull();
    expect(parseChatDocument({ document: { text: 5 } })).toBeNull();
    expect(parseChatDocument({ document: { ...GOOD.document, format: 3 } })).toBeNull();
  });

  it("reads missing or odd counts as zero, and a non-string whole text as none", () => {
    const parsed = parseChatDocument({
      document: { format: "pdf", text: "t", bytes: -4, chars: "many", fullText: 9, pii: { count: "x" } },
    });
    expect(parsed).toMatchObject({ bytes: 0, chars: 0, sentChars: 0, masked: 0, fullText: null, truncated: false });
  });

  it("reads the kept original's id, or the reason it was not kept", () => {
    expect(
      parseChatDocument({ document: { ...GOOD.document, originalId: KEPT, originalSkipped: null } }),
    ).toMatchObject({
      originalId: KEPT,
      originalSkipped: null,
    });
    expect(
      parseChatDocument({ document: { ...GOOD.document, originalId: null, originalSkipped: "quota" } }),
    ).toMatchObject({ originalId: null, originalSkipped: "quota" });
  });

  it("never trusts the wire for the original: a malformed id or an unknown reason is none", () => {
    expect(parseChatDocument({ document: { ...GOOD.document, originalId: "../x" } })).toMatchObject({
      originalId: null,
    });
    expect(parseChatDocument({ document: { ...GOOD.document, originalSkipped: "nope" } })).toMatchObject({
      originalSkipped: null,
    });
    expect(parseChatDocument(GOOD)).toMatchObject({ originalId: null, originalSkipped: null });
  });
});

describe("parseSavedChatDocument", () => {
  it("reads the notes and the text for the block", () => {
    expect(parseSavedChatDocument(SAVED)).toEqual({ notes: SAVED.document.notes, text: "hello" });
  });

  it("never trusts the wire", () => {
    expect(parseSavedChatDocument(null)).toBeNull();
    expect(parseSavedChatDocument({ document: { text: "x" } })).toBeNull();
    expect(parseSavedChatDocument({ document: { notes: "n", text: 4 } })).toBeNull();
  });
});

describe("saveChatDocument", () => {
  it("posts the name and the whole text as JSON to the save route", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await saveChatDocument("a.pdf", { ...RESULT, text: "hel", fullText: "hello world", truncated: true });
    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(CHAT_DOCUMENT_SAVE_ROUTE);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "a.pdf",
      format: "pdf",
      bytes: 10,
      masked: 2,
      text: "hello world",
      originalId: null,
      originalSkipped: null,
    });
  });

  it("sends the kept original's id back with the save, so the host can name it in the notes", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await saveChatDocument("a.pdf", { ...RESULT, originalId: KEPT });
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ originalId: KEPT, originalSkipped: null });
  });

  it("sends the reason the original was not kept, so the host can say so in the notes", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await saveChatDocument("a.docx", { ...RESULT, format: "docx", originalSkipped: "too_large" });
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ originalId: null, originalSkipped: "too_large" });
  });

  it("posts the text that was read when nothing was cut", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await saveChatDocument("a.pdf", RESULT);
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toBe("hello");
  });

  it("answers the notes and the cut text", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await expect(saveChatDocument("a.pdf", RESULT)).resolves.toEqual({ notes: SAVED.document.notes, text: "hello" });
  });

  it("turns the host's refusal into the catalog key for its code", async () => {
    apiFetch.mockResolvedValue(reply(413, { error: { code: "document_too_large", message: "x" } }));
    await expect(saveChatDocument("a.pdf", RESULT)).rejects.toMatchObject({ key: "too_large" });
  });

  it("says the file could not be sent when the network drops or the answer is not what was promised", async () => {
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(saveChatDocument("a.pdf", RESULT)).rejects.toMatchObject({ key: "send" });
    apiFetch.mockResolvedValueOnce(reply(200, { nonsense: true }));
    await expect(saveChatDocument("a.pdf", RESULT)).rejects.toMatchObject({ key: "send" });
    apiFetch.mockResolvedValueOnce(reply(500, { error: { code: "internal_error", message: "x" } }));
    await expect(saveChatDocument("a.pdf", RESULT)).rejects.toMatchObject({ key: "send" });
  });
});

describe("discardChipOriginal", () => {
  const READY_KEPT: DocumentRead = { status: "ready", result: { ...RESULT, originalId: KEPT } };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes a removed chip's kept original, once, through the artifacts route", async () => {
    apiFetch.mockResolvedValue(reply(200, { ok: true }));
    await discardChipOriginal(READY_KEPT, false);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/v1/artifacts/${KEPT}`);
    expect(init.method).toBe("DELETE");
  });

  it("leaves the original alone while the message that names it is going", async () => {
    await discardChipOriginal(READY_KEPT, true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("has nothing to delete for a chip with no kept original, or one that is still reading or failed", async () => {
    await discardChipOriginal({ status: "ready", result: RESULT }, false);
    await discardChipOriginal(undefined, false);
    await discardChipOriginal({ status: "reading" }, false);
    await discardChipOriginal({ status: "failed", error: "needs_ocr" }, false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("logs a failed delete and never throws, so the chip is still removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiFetch.mockResolvedValueOnce(reply(404, { error: { code: "not_found", message: "Not found" } }));
    await expect(discardChipOriginal(READY_KEPT, false)).resolves.toBeUndefined();
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(discardChipOriginal(READY_KEPT, false)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("attachmentBlock", () => {
  it("delimits the text with the file name, the way a text file is", () => {
    expect(attachmentBlock("Q3 report.pdf", "body")).toBe("--- Q3 report.pdf ---\nbody");
  });

  it("keeps a name with a line break on one line, so the header stays a header", () => {
    expect(attachmentBlock("a\nb.pdf", "x")).toBe("--- a b.pdf ---\nx");
  });
});

describe("inlineBlock", () => {
  it("reads a text file in the browser into a --- name --- block, as it always was", async () => {
    const file = new File(["hello\nthere"], "notes.txt", { type: "text/plain" });
    expect(await inlineBlock({ file, kind: "text" })).toBe("--- notes.txt ---\nhello\nthere");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("holds a long text file to the document budget and says it cut, above the block", async () => {
    const body = "line of text\n".repeat(Math.ceil((CHAT_TEXT_ATTACHMENT_MAX_CHARS * 2) / 13));
    const file = new File([body], "log.txt", { type: "text/plain" });
    const block = (await inlineBlock({ file, kind: "text" })) ?? "";
    const [notes = "", rest = ""] = block.split("\n\n--- log.txt ---\n");
    expect(isHostNoteLine(notes)).toBe(true);
    expect(notes).toContain("The rest was not kept.");
    expect(block.startsWith("[Cut: only the first")).toBe(true);
    expect(rest.length).toBeLessThanOrEqual(CHAT_TEXT_ATTACHMENT_MAX_CHARS);
    expect(body.startsWith(rest)).toBe(true);
  });

  it("saves a document that was read when it is sent, and puts the host's notes above its block", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    const file = fileOf("Q3 report.pdf");
    const ready: DocumentRead = { status: "ready", result: RESULT };
    const block = await inlineBlock({ file, kind: "document", read: ready });
    expect(block).toBe(`${SAVED.document.notes}--- Q3 report.pdf ---\nhello`);
    // The notes are above the header, outside the block, with a blank line between.
    expect(block?.indexOf("[Saved on this desk")).toBeLessThan(block?.indexOf("--- Q3 report.pdf ---") ?? -1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect((apiFetch.mock.calls[0] as [string])[0]).toBe(CHAT_DOCUMENT_SAVE_ROUTE);
  });

  it("sends the text the save route cut, not the text the read route did", async () => {
    apiFetch.mockResolvedValue(reply(200, { document: { ...SAVED.document, text: "hel" } }));
    const ready: DocumentRead = {
      status: "ready",
      result: { ...RESULT, text: "hello", fullText: "hello world", truncated: true },
    };
    const block = await inlineBlock({ file: fileOf("a.pdf"), kind: "document", read: ready });
    expect(block?.endsWith("--- a.pdf ---\nhel")).toBe(true);
  });

  it("rejects with the catalog key when the desk copy cannot be asked for, so the message is not sent", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    const ready: DocumentRead = { status: "ready", result: RESULT };
    await expect(inlineBlock({ file: fileOf("a.pdf"), kind: "document", read: ready })).rejects.toMatchObject({
      name: "ChatDocumentError",
      key: "send",
    });
  });

  it("is null for a document that is still reading or failed, so nothing binary is ever sent as text", async () => {
    const file = fileOf("a.pdf");
    expect(await inlineBlock({ file, kind: "document" })).toBeNull();
    expect(await inlineBlock({ file, kind: "document", read: { status: "reading" } })).toBeNull();
    expect(await inlineBlock({ file, kind: "document", read: { status: "failed", error: "empty" } })).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("documentErrorKey", () => {
  it("maps the host's codes to the catalog keys", () => {
    const cases: Array<[string, string]> = [
      ["document_too_large", "too_large"],
      ["document_unsupported", "unsupported"],
      ["document_mismatch", "mismatch"],
      ["document_needs_ocr", "needs_ocr"],
      ["document_encrypted", "encrypted"],
      ["document_empty", "empty"],
      ["document_unreadable", "unreadable"],
      ["document_slow", "slow"],
      ["too_many_jobs", "busy"],
    ];
    for (const [code, key] of cases) {
      expect(documentErrorKey(code, 400), code).toBe(key);
    }
  });

  it("reads a bare 413 as too large and anything else as a general failure", () => {
    expect(documentErrorKey(undefined, 413)).toBe("too_large");
    expect(documentErrorKey("something_else", 500)).toBe("failed");
    expect(documentErrorKey(undefined, 0)).toBe("failed");
  });

  it("offers a retry only when trying again could work", () => {
    expect(isRetryable("slow")).toBe(true);
    expect(isRetryable("busy")).toBe(true);
    expect(isRetryable("failed")).toBe(true);
    expect(isRetryable("needs_ocr")).toBe(false);
    expect(isRetryable("encrypted")).toBe(false);
    expect(isRetryable("too_large")).toBe(false);
  });

  it("has copy for every key in both languages", () => {
    const keys = [
      "too_large",
      "unsupported",
      "mismatch",
      "needs_ocr",
      "encrypted",
      "empty",
      "unreadable",
      "slow",
      "busy",
      "failed",
      "send",
    ];
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const key of keys) {
        const text = t(`chat.document.errors.${key}`);
        expect(text, `${locale} ${key}`).not.toBe(`chat.document.errors.${key}`);
        expect(text.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("readChatDocument", () => {
  it("posts the file to the document route as one multipart field", async () => {
    apiFetch.mockResolvedValue(reply(200, GOOD));
    const result = await readChatDocument(fileOf("a.pdf"));
    expect(result.text).toContain("hello");
    const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/chat/documents");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("refuses an empty file before anything is sent", async () => {
    await expect(readChatDocument(fileOf("empty.pdf", 0))).rejects.toMatchObject({ key: "empty" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a file over the cap before anything is sent", async () => {
    const big = { name: "big.pdf", size: CHAT_DOCUMENT_MAX_BYTES + 1, type: "application/pdf" } as File;
    await expect(readChatDocument(big)).rejects.toMatchObject({ key: "too_large" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("turns the host's refusal into the catalog key for its code", async () => {
    apiFetch.mockResolvedValue(reply(400, { error: { code: "document_needs_ocr", message: "x" } }));
    await expect(readChatDocument(fileOf("scan.pdf"))).rejects.toMatchObject({ key: "needs_ocr" });
  });

  it("says busy for the host's too_many_jobs", async () => {
    apiFetch.mockResolvedValue(reply(429, { error: { code: "too_many_jobs", message: "x" } }));
    await expect(readChatDocument(fileOf("a.pdf"))).rejects.toMatchObject({ key: "busy" });
  });

  it("says failed when the network drops or the answer is not what was promised", async () => {
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(readChatDocument(fileOf("a.pdf"))).rejects.toMatchObject({ key: "failed" });
    apiFetch.mockResolvedValueOnce(reply(200, { nonsense: true }));
    await expect(readChatDocument(fileOf("a.pdf"))).rejects.toMatchObject({ key: "failed" });
  });
});

type Held = { id: string; kind: string; read?: DocumentRead };
const doc = (id: string, read?: DocumentRead): Held => ({ id, kind: "document", read });
const READY: DocumentRead = { status: "ready", result: RESULT };

describe("which documents still need reading", () => {
  it("starts a read for a document with no state, once", () => {
    const files = [doc("a"), doc("b", READY), { id: "c", kind: "text" }, doc("d", { status: "reading" })];
    expect(pendingDocumentIds(files, new Set())).toEqual(["a"]);
    expect(pendingDocumentIds(files, new Set(["a"]))).toEqual([]);
  });

  it("blocks Send while any document is reading or has failed", () => {
    expect(documentsBlockSend([doc("a", READY)])).toBe(false);
    expect(documentsBlockSend([doc("a", READY), { id: "t", kind: "text" }])).toBe(false);
    expect(documentsBlockSend([doc("a", { status: "reading" })])).toBe(true);
    expect(documentsBlockSend([doc("a", { status: "failed", error: "empty" })])).toBe(true);
    expect(documentsBlockSend([doc("a")])).toBe(true);
    expect(documentsBlockSend([])).toBe(false);
  });

  it("restores a read that was in flight as one to start again, and keeps a finished one", () => {
    expect(restoreDocumentRead({ status: "reading" })).toBeUndefined();
    expect(restoreDocumentRead(READY)).toEqual(READY);
    expect(restoreDocumentRead(undefined)).toBeUndefined();
    expect(restoreDocumentRead({ status: "bogus" })).toBeUndefined();
  });
});

describe("how many documents one message holds", () => {
  it("allows up to the limit and counts what is already attached", () => {
    const held = Array.from({ length: CHAT_DOCUMENTS_PER_MESSAGE }, (_, index) => doc(String(index), READY));
    expect(documentsOverLimit(held, 0)).toBe(false);
    expect(documentsOverLimit(held, 1)).toBe(true);
    expect(documentsOverLimit([], CHAT_DOCUMENTS_PER_MESSAGE)).toBe(false);
    expect(documentsOverLimit([], CHAT_DOCUMENTS_PER_MESSAGE + 1)).toBe(true);
    expect(documentsOverLimit([{ id: "t", kind: "text" }], CHAT_DOCUMENTS_PER_MESSAGE)).toBe(false);
  });
});

const FIGURES = {
  figuresText: "Sheet: PL\nPendapatan (2024): 1250000",
  proseText: "",
  sheetNames: ["PL"],
  skipped: [],
};

describe("Finance figures on a document", () => {
  it("reads the figures and why there are none", () => {
    expect(parseChatDocument({ document: { ...GOOD.document, figures: FIGURES, figuresSkipped: null } })).toMatchObject(
      {
        figures: FIGURES,
        figuresSkipped: null,
      },
    );
    expect(
      parseChatDocument({ document: { ...GOOD.document, figures: null, figuresSkipped: "no_table" } }),
    ).toMatchObject({ figures: null, figuresSkipped: "no_table" });
  });

  it("treats an older host's answer, malformed figures or an unknown reason as none", () => {
    expect(parseChatDocument(GOOD)).toMatchObject({ figures: null, figuresSkipped: null });
    expect(
      parseChatDocument({ document: { ...GOOD.document, figures: { figuresText: 5 }, figuresSkipped: "nope" } }),
    ).toMatchObject({ figures: null, figuresSkipped: null });
  });

  it("sends the figures back with the save", async () => {
    apiFetch.mockResolvedValue(reply(200, SAVED));
    await saveChatDocument("a.xlsx", { ...RESULT, format: "xlsx", figures: FIGURES });
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).figures).toEqual(FIGURES);
  });

  it("sends no figures key for a read with none, or a stash kept before figures existed", async () => {
    apiFetch.mockImplementation(async () => reply(200, SAVED));
    await saveChatDocument("a.pdf", RESULT);
    const { figures: _dropped, ...older } = RESULT;
    await saveChatDocument("a.pdf", older as ChatDocumentResult);
    for (const call of apiFetch.mock.calls) {
      expect(JSON.parse(String((call as [string, RequestInit])[1].body))).not.toHaveProperty("figures");
    }
  });
});
