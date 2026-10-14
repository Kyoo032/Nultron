/**
 * `import_document`: a stored Word, Excel or PDF file is read into the editable model and saved again as
 * an editable artifact of the same format. The answer lists the section (or sheet) ids and headings, so
 * the model can revise one part with `revise_document`.
 *
 * The source is a stored artifact on purpose: a chat upload keeps only its extracted text, not the file's
 * bytes (`chat-documents/save-handler.ts`), so there are no uploaded bytes to import yet.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import { sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { sampleDoc, sampleBook } from "../doc-model/fixtures";
import { renderDocx } from "../doc-model/render-docx";
import { renderPdf } from "../doc-model/render-pdf";
import { renderXlsx } from "../doc-model/render-xlsx";
import { readEditableSpec } from "./doc-meta";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { importDocumentForTenant } from "./import-document";
import { bodyBytes, DOC_PERSON_C, docTenant, isPdf, pdfPageCount } from "./doc-tools-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

let tenant: Awaited<ReturnType<typeof docTenant>>;

beforeAll(async () => {
  tenant = await docTenant();
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  sql.prepare("DELETE FROM tenant_storage").run();
  sql.prepare("DELETE FROM artifacts").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

/** A stored Office or PDF file, written the way a finished export would be stored: base64 in the body. */
function storeFile(
  mime: typeof DOCX_MIME | typeof XLSX_MIME | typeof PDF_MIME,
  bytes: Uint8Array,
  title = "Imported source",
) {
  return artifactStore().create(tenant, {
    mode: "documents",
    kind: "draft",
    title,
    mime,
    body: Buffer.from(bytes).toString("base64"),
  });
}

describe("import_document", () => {
  it("imports a Word file the renderer made, and returns its section ids with headings", async () => {
    const source = storeFile(DOCX_MIME, await renderDocx(sampleDoc("corporate")));
    const result = await importDocumentForTenant({ artifactId: source.id }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe("docx");
    expect(result.artifactId).not.toBe(source.id);
    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.parts.every((part) => part.id.length > 0)).toBe(true);
    expect(result.parts.map((part) => part.heading)).toContain(sampleDoc("corporate").sections[0]?.heading);

    const imported = artifactStore().get(tenant, result.artifactId);
    expect(imported?.mime).toBe(DOCX_MIME);
    const spec = imported ? readEditableSpec(imported) : null;
    expect(spec?.kind).toBe("document");
    expect(imported?.meta.parentArtifactId).toBe(source.id);
  });

  it("imports an Excel file, and returns its sheet ids with names", async () => {
    const source = storeFile(XLSX_MIME, await renderXlsx(sampleBook("modern")));
    const result = await importDocumentForTenant({ artifactId: source.id }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe("xlsx");
    expect(result.parts.length).toBe(sampleBook("modern").sheets.length);
    const imported = artifactStore().get(tenant, result.artifactId);
    expect(imported?.mime).toBe(XLSX_MIME);
    const spec = imported ? readEditableSpec(imported) : null;
    expect(spec?.kind).toBe("workbook");
  });

  it("imports a PDF, and saves it as a PDF again", async () => {
    const source = storeFile(PDF_MIME, await renderPdf(sampleDoc("plain")));
    const result = await importDocumentForTenant({ artifactId: source.id }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe("pdf");
    const imported = artifactStore().get(tenant, result.artifactId);
    expect(isPdf(bodyBytes(imported?.body ?? ""))).toBe(true);
    expect(await pdfPageCount(bodyBytes(imported?.body ?? ""))).toBeGreaterThanOrEqual(1);
  });

  it("refuses a file that is not Word, Excel or PDF", async () => {
    const notes = artifactStore().create(tenant, {
      mode: "documents",
      kind: "draft",
      title: "Notes",
      mime: "text/markdown",
      body: "# Notes",
    });
    const result = await importDocumentForTenant({ artifactId: notes.id }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("refuses bytes that are not really the file type they claim, and says the file could not be read", async () => {
    const fake = storeFile(DOCX_MIME, Buffer.from("this is plain text, not a Word file"));
    const result = await importDocumentForTenant({ artifactId: fake.id }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    expect(result.ok === false && result.message.length).toBeGreaterThan(0);
  });

  it("answers not found for an id that does not exist", async () => {
    const result = await importDocumentForTenant({ artifactId: "00000000-0000-0000-0000-000000000000" }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("answers not found for another company's file on the hosted app", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const source = storeFile(DOCX_MIME, await renderDocx(sampleDoc("plain")));
    const elsewhere = await docTenant(DOC_PERSON_C);
    const result = await importDocumentForTenant({ artifactId: source.id }, elsewhere);
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });
});
