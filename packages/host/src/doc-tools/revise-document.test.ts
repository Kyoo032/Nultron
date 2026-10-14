/**
 * `revise_document`: one part of a saved file changes, and the result is a new file.
 *
 * The original is never overwritten: a revision is a new artifact with the same title and " (revised)",
 * and its stored spec keeps every other part exactly as the original had it. The visibility cases run in
 * server mode, where another person's file and another company's file both answer "not found".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PDF_MIME, XLSX_MIME, DOCX_MIME } from "@agentforge/core/artifacts";
import { sql } from "@agentforge/db";
import { artifactStore, type ArtifactStore } from "../artifacts";
import { readEditableSpec } from "./doc-meta";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import { createDocumentForTenant, createWorkbookForTenant } from "./create-document";
import { reviseDocumentForTenant } from "./revise-document";
import {
  bodyBytes,
  DOC_PERSON_B,
  DOC_PERSON_C,
  docTenant,
  isPdf,
  sampleDocInput,
  sampleWorkbookInput,
} from "./doc-tools-fixtures";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

let tenant: Awaited<ReturnType<typeof docTenant>>;
let store: ArtifactStore;

beforeAll(async () => {
  tenant = await docTenant();
  store = artifactStore();
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

async function madeDocument() {
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, tenant);
  if (!made.ok) {
    throw new Error(`setup failed: ${made.message}`);
  }
  return made.artifactId;
}

describe("revise_document: one section", () => {
  it("saves a new file with the section replaced, and leaves the other sections as they were", async () => {
    const originalId = await madeDocument();
    const before = store.get(tenant, originalId);
    const beforeSpec = before ? readEditableSpec(before) : null;

    const result = await reviseDocumentForTenant(
      {
        artifactId: originalId,
        sectionId: "numbers",
        section: { heading: "Numbers, corrected", blocks: [{ type: "paragraph", text: "Revenue was 220." }] },
      },
      tenant,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.artifactId).not.toBe(originalId);
    expect(result.title).toBe("Quarterly review (revised)");

    const revised = store.get(tenant, result.artifactId);
    const revisedSpec = revised ? readEditableSpec(revised) : null;
    expect(revisedSpec?.kind).toBe("document");
    if (revisedSpec?.kind !== "document" || beforeSpec?.kind !== "document") {
      return;
    }
    expect(revisedSpec.spec.sections[1]?.heading).toBe("Numbers, corrected");
    expect(revisedSpec.spec.sections[0]).toEqual(beforeSpec.spec.sections[0]);
    expect(revisedSpec.spec.sections[2]).toEqual(beforeSpec.spec.sections[2]);
    expect(revised?.meta.parentArtifactId).toBe(originalId);
  });

  it("leaves the original file exactly as it was", async () => {
    const originalId = await madeDocument();
    const before = store.get(tenant, originalId);
    await reviseDocumentForTenant(
      { artifactId: originalId, sectionId: "close", section: { blocks: [{ type: "paragraph", text: "Changed." }] } },
      tenant,
    );
    const after = store.get(tenant, originalId);
    expect(after?.body).toBe(before?.body);
    expect(after?.title).toBe("Quarterly review");
    expect(after?.meta).toEqual(before?.meta);
  });

  it("refuses an unknown section id and says which ids exist", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant(
      { artifactId: originalId, sectionId: "nope", section: { blocks: [] } },
      tenant,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/no section "nope"/);
  });

  it("refuses a section part without its id, in words the model can act on", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant({ artifactId: originalId, section: { blocks: [] } }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.ok === false && result.message).toMatch(/sectionId/);
  });
});

describe("revise_document: restyle and format", () => {
  it("restyles the whole file to another theme, as a new file", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant({ artifactId: originalId, theme: "modern" }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const revised = store.get(tenant, result.artifactId);
    expect(revised?.mime).toBe(DOCX_MIME);
    const spec = revised ? readEditableSpec(revised) : null;
    expect(spec?.kind === "document" && spec.spec.theme).toBe("modern");
  });

  it("exports a Word file as a PDF, and the PDF is a real PDF", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant({ artifactId: originalId, format: "pdf" }, tenant);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.format).toBe("pdf");
    const revised = store.get(tenant, result.artifactId);
    expect(revised?.mime).toBe(PDF_MIME);
    expect(isPdf(bodyBytes(revised?.body ?? ""))).toBe(true);
    expect(result.filename).toBe("quarterly-review-revised.pdf");
  });

  it("refuses to change nothing", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant({ artifactId: originalId }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "nothing_to_change" });
  });

  it("refuses a format that is not docx or pdf", async () => {
    const originalId = await madeDocument();
    const result = await reviseDocumentForTenant({ artifactId: originalId, format: "xlsx" }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "bad_format" });
  });
});

describe("revise_document: a workbook", () => {
  it("replaces one sheet and keeps the file an Excel workbook", async () => {
    const made = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, tenant);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const result = await reviseDocumentForTenant(
      {
        artifactId: made.artifactId,
        sheetId: "costs",
        sheet: {
          name: "Costs 2",
          columns: [{ key: "item", header: "Item", type: "text" }],
          rows: [{ item: "Rent" }],
        },
      },
      tenant,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const revised = store.get(tenant, result.artifactId);
    expect(revised?.mime).toBe(XLSX_MIME);
    const spec = revised ? readEditableSpec(revised) : null;
    expect(spec?.kind === "workbook" && spec.spec.sheets[0]?.name).toBe("Costs 2");
  });

  it("refuses a format change on a workbook", async () => {
    const made = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, tenant);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const result = await reviseDocumentForTenant({ artifactId: made.artifactId, format: "pdf" }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "bad_format" });
  });
});

describe("revise_document: visibility on the hosted app", () => {
  it("answers not found for another person's file on the same desk, and for another company's", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const originalId = await madeDocument();
    const other = await docTenant(DOC_PERSON_B);
    const elsewhere = await docTenant(DOC_PERSON_C);

    const sameDesk = await reviseDocumentForTenant({ artifactId: originalId, theme: "modern" }, other);
    const otherCompany = await reviseDocumentForTenant({ artifactId: originalId, theme: "modern" }, elsewhere);
    expect(sameDesk).toMatchObject({ ok: false, reason: "not_found" });
    expect(otherCompany).toMatchObject({ ok: false, reason: "not_found" });

    const owner = await reviseDocumentForTenant({ artifactId: originalId, theme: "modern" }, tenant);
    expect(owner.ok).toBe(true);
  });

  it("answers not found for an id that does not exist", async () => {
    const result = await reviseDocumentForTenant(
      { artifactId: "00000000-0000-0000-0000-000000000000", theme: "modern" },
      tenant,
    );
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("revise_document: a file the tools did not make", () => {
  it("refuses a file with no stored spec, and says it cannot be revised here", async () => {
    const legacy = store.create(tenant, {
      mode: "documents",
      kind: "draft",
      title: "Old file",
      mime: DOCX_MIME,
      body: Buffer.from("not really a docx").toString("base64"),
    });
    const result = await reviseDocumentForTenant({ artifactId: legacy.id, theme: "modern" }, tenant);
    expect(result).toMatchObject({ ok: false, reason: "not_editable" });
  });
});
