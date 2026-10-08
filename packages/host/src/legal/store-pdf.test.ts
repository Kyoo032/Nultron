import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { documentText } from "@agentforge/core/docx";
import { legalOutputCopy } from "@agentforge/core/legal";
import { buildTextPdf } from "@agentforge/core/pdf/test-fixtures";
import { type CreateMatterInput, type LegalStore, createLegalStore } from "./store";
import { PDF_MIME, parseLegalFileOrThrow } from "./store-files";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-1",
  userId: "local",
  role: "owner",
};
const otherDesk: TenantContext = { ...tenant, workspaceId: "ws-2" };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../core/src/docx/fixtures");
const ACA = new Uint8Array(readFileSync(join(FIXTURES, "lender-initial-aca-draft.docx")));

const INPUT: CreateMatterInput = {
  title: "Project Aurora",
  side: { role: "", party: "", counterparty: "" },
  workType: "review",
  deliverables: ["issues-memo"],
};

const LOAN_PDF = buildTextPdf([
  "1. Payment",
  "2.1 The Borrower shall pay Rp 1.500.000.000 within twelve (12) months.",
  "Second page: governing law is the law of Indonesia.",
]);
const SCANNED_PDF = buildTextPdf(["", ""]);

describe("legal store: PDF intake", () => {
  let dir: string;
  let store: LegalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "af-legal-pdf-"));
    store = createLegalStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a PDF as files/S1.pdf with a parsed document clause tools can read", async () => {
    const matter = store.create(tenant, INPUT);
    const { card, matter: next } = await store.addFile(tenant, matter.id, {
      filename: "Loan (v1).PDF",
      bytes: LOAN_PDF,
    });
    expect(card).toMatchObject({
      id: "S1",
      name: "Loan_v1_.PDF",
      path: "files/S1.pdf",
      mime: PDF_MIME,
      role: "context",
      status: "read",
    });
    expect(card.paragraphs).toBeGreaterThan(0);
    expect(next.docs).toHaveLength(1);
    expect(existsSync(join(dir, tenant.workspaceId, matter.id, "files", "S1.pdf"))).toBe(true);
    expect(existsSync(join(dir, tenant.workspaceId, matter.id, "files", "S1.docx"))).toBe(false);

    const doc = await store.readDoc(tenant, matter.id, "S1");
    expect(documentText(doc as NonNullable<typeof doc>)).toContain("The Borrower shall pay Rp 1.500.000.000");
    expect(Array.from(store.readBytes(tenant, matter.id, "S1") ?? [])).toEqual(Array.from(LOAN_PDF));
  });

  it("keeps Word and PDF side by side, and removes a PDF's bytes and cache with it", async () => {
    const matter = store.create(tenant, INPUT);
    await store.addFile(tenant, matter.id, { filename: "aca.docx", bytes: ACA });
    await store.addFile(tenant, matter.id, { filename: "loan.pdf", bytes: LOAN_PDF });
    const folder = join(dir, tenant.workspaceId, matter.id);
    expect(existsSync(join(folder, "files", "S1.docx"))).toBe(true);
    expect(existsSync(join(folder, "files", "S2.pdf"))).toBe(true);
    const after = store.removeFile(tenant, matter.id, "S2");
    expect(after.docs.map((doc) => doc.id)).toEqual(["S1"]);
    expect(existsSync(join(folder, "files", "S2.pdf"))).toBe(false);
    expect(existsSync(join(folder, "parsed", "S2.json"))).toBe(false);
    expect(existsSync(join(folder, "files", "S1.docx"))).toBe(true);
  });

  it("refuses a scan as needs_ocr, in the run language, and leaves nothing behind", async () => {
    const matter = store.create(tenant, INPUT);
    await expect(store.addFile(tenant, matter.id, { filename: "scan.pdf", bytes: SCANNED_PDF })).rejects.toMatchObject({
      code: "needs_ocr",
      status: 400,
      message: legalOutputCopy("en").needsOcr,
    });
    expect(store.get(tenant, matter.id)?.docs).toEqual([]);
    expect(existsSync(join(dir, tenant.workspaceId, matter.id, "files", "S1.pdf"))).toBe(false);
  });

  it("refuses a damaged PDF and anything that is neither Word nor PDF with the one unsupported-file message", async () => {
    const matter = store.create(tenant, INPUT);
    const damaged = new Uint8Array(Buffer.from("%PDF-1.4\nthis is not a real pdf\n"));
    await expect(store.addFile(tenant, matter.id, { filename: "bad.pdf", bytes: damaged })).rejects.toMatchObject({
      code: "unsupported_content_type",
      message: legalOutputCopy("en").pdfUnreadable,
    });
    await expect(
      store.addFile(tenant, matter.id, { filename: "notes.txt", bytes: Buffer.from("plain text") }),
    ).rejects.toMatchObject({
      code: "unsupported_content_type",
      message: legalOutputCopy("en").unsupportedFile,
    });
    expect(legalOutputCopy("en").unsupportedFile).toBe("Only Word (.docx) and PDF files are accepted.");
  });

  it("goes by the bytes, not the name: a PDF called .docx is still read as a PDF", async () => {
    const matter = store.create(tenant, INPUT);
    const { card } = await store.addFile(tenant, matter.id, { filename: "oops.docx", bytes: LOAN_PDF });
    expect(card).toMatchObject({ path: "files/S1.pdf", mime: PDF_MIME });
  });

  it("rejects the same PDF twice by content", async () => {
    const matter = store.create(tenant, INPUT);
    await store.addFile(tenant, matter.id, { filename: "loan.pdf", bytes: LOAN_PDF });
    await expect(store.addFile(tenant, matter.id, { filename: "again.pdf", bytes: LOAN_PDF })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("parseLegalFileOrThrow", () => {
  it("keeps the page of each paragraph when the reader marks pages (the pdfjs fallback does)", async () => {
    const parsed = await parseLegalFileOrThrow(LOAN_PDF, {
      loadAnydoc: () => {
        throw new Error("no native converter on this platform");
      },
    });
    expect(parsed.format).toBe("pdf");
    expect(parsed.pages).not.toBeNull();
    const pages = Object.values(parsed.pages ?? {});
    expect(Math.min(...pages)).toBe(1);
    expect(Math.max(...pages)).toBe(3);
  });

  it("has no page map when the reader does not mark pages (the native converter's PDFs)", async () => {
    const parsed = await parseLegalFileOrThrow(LOAN_PDF);
    expect(parsed.format).toBe("pdf");
    expect(parsed.pages).toBeNull();
  });

  it("reads Word as before", async () => {
    const parsed = await parseLegalFileOrThrow(ACA);
    expect(parsed.format).toBe("docx");
    expect(parsed.pages).toBeNull();
    expect(parsed.doc.paragraphs.length).toBeGreaterThan(0);
  });
});

describe("legal store: the extraction's files", () => {
  let dir: string;
  let store: LegalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "af-legal-extract-"));
    store = createLegalStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (matterId: string) => ({
    version: 1 as const,
    matterId,
    createdAt: 1,
    model: "m",
    locale: "en" as const,
    prompt: "",
    documentType: "Loan agreement",
    read: { calls: 1, repairs: 0, files: [], partialDocs: [] },
    files: [],
    parties: [],
    facts: [],
    redFlags: [],
    conflicts: [],
    coverage: [],
    checks: { passed: true, rounds: 0, verdicts: [] },
    side: { party: null, ask: false, candidates: [], source: "none" as const },
  });

  it("answers empty before the first extraction, then round-trips extract, edits and asks", () => {
    const matter = store.create(tenant, INPUT);
    expect(store.getExtract(tenant, matter.id)).toBeNull();
    expect(store.getExtractEdits(tenant, matter.id)).toEqual({ version: 1, edits: [], comments: [] });
    expect(store.getAsks(tenant, matter.id)).toEqual({ version: 1, asks: [] });

    store.saveExtract(tenant, matter.id, record(matter.id));
    store.saveExtractEdits(tenant, matter.id, {
      version: 1,
      edits: [{ itemId: "payment:S1", value: "Rp 2 miliar", editedAt: 5, editedBy: "local" }],
      comments: [],
    });
    expect(store.getExtract(tenant, matter.id)?.documentType).toBe("Loan agreement");
    expect(store.getExtractEdits(tenant, matter.id).edits).toHaveLength(1);
  });

  it("keeps them inside the matter folder, so deleting the matter deletes them", () => {
    const matter = store.create(tenant, INPUT);
    store.saveExtract(tenant, matter.id, record(matter.id));
    store.saveExtractEdits(tenant, matter.id, { version: 1, edits: [], comments: [] });
    store.saveAsks(tenant, matter.id, { version: 1, asks: [] });
    const folder = join(dir, tenant.workspaceId, matter.id);
    for (const name of ["extract.json", "extract-edits.json", "asks.json"]) {
      expect(existsSync(join(folder, name)), name).toBe(true);
    }
    expect(store.remove(tenant, matter.id)).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });

  it("does not let another desk read or write them, and refuses an extraction for a different matter", () => {
    const matter = store.create(tenant, INPUT);
    store.saveExtract(tenant, matter.id, record(matter.id));
    expect(() => store.getExtract(otherDesk, matter.id)).toThrow(/not found/i);
    expect(() => store.saveExtractEdits(otherDesk, matter.id, { version: 1, edits: [], comments: [] })).toThrow(
      /not found/i,
    );
    expect(() => store.saveExtract(tenant, matter.id, record("some-other-matter"))).toThrow(/does not belong/);
  });

  it("treats a hand-edited, malformed file as an error rather than trusting it", () => {
    const matter = store.create(tenant, INPUT);
    writeFileSync(
      join(dir, tenant.workspaceId, matter.id, "extract.json"),
      JSON.stringify({ version: 1, facts: "nope" }),
    );
    expect(() => store.getExtract(tenant, matter.id)).toThrow(/malformed/);
  });
});
