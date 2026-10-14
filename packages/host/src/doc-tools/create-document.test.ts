/**
 * `create_document` and `create_workbook`: a spec in, a saved Word, PDF or Excel artifact out.
 *
 * Every case opens the stored file the way its own program would, so a file that only looks right in the
 * tool's answer fails here. The spec is read back from the artifact's metadata to prove it is editable.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import { sql } from "@agentforge/db";
import { artifactStore } from "../artifacts";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { createDocumentForTenant, createWorkbookForTenant } from "./create-document";
import {
  bodyBytes,
  docTenant,
  docxBodyText,
  isPdf,
  pdfPageCount,
  sampleDocInput,
  sampleWorkbookInput,
  xlsxSheetNames,
} from "./doc-tools-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

let tenant: Awaited<ReturnType<typeof docTenant>>;

beforeAll(async () => {
  tenant = await docTenant();
});

afterEach(() => {
  sql.prepare("DELETE FROM tenant_storage").run();
  sql.prepare("DELETE FROM artifacts").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

describe("create_document", () => {
  it("saves a Word file whose bytes open and whose spec is kept for later edits", async () => {
    const result = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe("docx");
    expect(result.summary).toMatch(/Word/);

    const stored = artifactStore().get(tenant, result.artifactId);
    expect(stored?.mime).toBe(DOCX_MIME);
    expect(stored?.title).toBe("Quarterly review");
    expect(stored?.mode).toBe("documents");
    expect(stored?.kind).toBe("draft");
    expect(stored?.meta.spec).toBeDefined();
    expect(JSON.stringify(stored?.meta)).not.toContain("Sales grew this quarter");

    const text = await docxBodyText(bodyBytes(stored?.body ?? ""));
    expect(text).toContain("Introduction");
    expect(text).toContain("Next quarter we expand.");
  });

  it("saves a PDF whose bytes are a real PDF with the pages the spec needs", async () => {
    const result = await createDocumentForTenant({ format: "pdf", spec: sampleDocInput() }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const stored = artifactStore().get(tenant, result.artifactId);
    expect(stored?.mime).toBe(PDF_MIME);
    const bytes = bodyBytes(stored?.body ?? "");
    expect(isPdf(bytes)).toBe(true);
    expect(await pdfPageCount(bytes)).toBeGreaterThanOrEqual(1);
    expect(result.filename).toBe("quarterly-review.pdf");
  });

  it("takes a theme and records it in the stored spec", async () => {
    const result = await createDocumentForTenant(
      { format: "docx", spec: sampleDocInput(), theme: "corporate" },
      tenant,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const stored = artifactStore().get(tenant, result.artifactId);
    expect(stored?.meta.spec).toBeDefined();
    expect(result.ok && result.artifactId).toBeTruthy();
  });

  it("refuses a format that is neither docx nor pdf, in words the model can act on", async () => {
    const result = await createDocumentForTenant({ format: "word", spec: sampleDocInput() }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "bad_format" });
    expect(result.ok === false && result.message).toMatch(/docx or pdf/);
    expect(artifactStore().list(tenant)).toHaveLength(0);
  });

  it("refuses a spec the document model rejects, and names the field", async () => {
    const result = await createDocumentForTenant(
      { format: "docx", spec: { title: "Bad", sections: [{ id: "bad id!", blocks: [] }] } },
      tenant,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/sections\.0\.id/);
    expect(artifactStore().list(tenant)).toHaveLength(0);
  });
});

describe("create_workbook", () => {
  it("saves an Excel file whose sheets open and whose spec is kept for later edits", async () => {
    const result = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const stored = artifactStore().get(tenant, result.artifactId);
    expect(stored?.mime).toBe(XLSX_MIME);
    expect(stored?.meta.spec).toBeDefined();
    expect(await xlsxSheetNames(bodyBytes(stored?.body ?? ""))).toEqual(["Costs"]);
    expect(result.ok && result.summary).toMatch(/1 sheet/);
  });

  it("refuses a column type that does not match the cells, and names the cell", async () => {
    const book = sampleWorkbookInput();
    const result = await createWorkbookForTenant(
      { spec: { ...book, sheets: [{ ...book.sheets[0], rows: [{ item: "Rent", amount: "lots" }] }] } },
      tenant,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/amount/);
    expect(artifactStore().list(tenant)).toHaveLength(0);
  });
});
