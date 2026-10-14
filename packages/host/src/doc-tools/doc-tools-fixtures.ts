/**
 * Shared by the document tool tests: signed-in people on two companies, and readers that open a stored
 * file the way Word, Excel and a PDF reader would, so a test counts the parts of the real file rather
 * than trusting the tool's own answer.
 */
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { db, ensurePortalOwner } from "@agentforge/db";
import { getTenant } from "../tenant";

export const DOC_PERSON = { id: "doc-session", tenantId: "doc-tenant", orgId: "doc-org", userId: "doc-user" };

/** Another person in the same company: a second user on the same desk. */
export const DOC_PERSON_B = { id: "doc-session-b", tenantId: "doc-tenant", orgId: "doc-org", userId: "doc-user-b" };

/** A person in a second company on the same server. */
export const DOC_PERSON_C = { id: "doc-session-c", tenantId: "doc-tenant-c", orgId: "doc-org-c", userId: "doc-user-c" };

export type DocPerson = typeof DOC_PERSON;

/** A signed-in person's tenant, created on first use. */
export async function docTenant(person: DocPerson = DOC_PERSON) {
  await ensurePortalOwner(db, {
    tenantId: person.tenantId,
    orgId: person.orgId,
    userId: person.userId,
    role: person.userId === DOC_PERSON.userId ? "owner" : "member",
  });
  return getTenant({ session: person });
}

/** The text of the main part of a stored Word file: the document body, every run of text in order. */
export async function docxBodyText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml === undefined) {
    throw new Error("not a Word file: no word/document.xml");
  }
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]).join("");
}

/** The sheet names of a stored workbook, in tab order. */
export async function xlsxSheetNames(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("xl/workbook.xml")?.async("string");
  if (xml === undefined) {
    throw new Error("not a workbook: no xl/workbook.xml");
  }
  return [...xml.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => match[1]);
}

/** The page count of a stored PDF, read by pdf-lib (it throws on a file that is not a PDF). */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/** The bytes an artifact row holds: its body is base64 for every Office and PDF type. */
export function bodyBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** A small document spec the tests share: two sections, one table, plain theme. */
export function sampleDocInput() {
  return {
    title: "Quarterly review",
    sections: [
      { id: "intro", heading: "Introduction", blocks: [{ type: "paragraph", text: "Sales grew this quarter." }] },
      {
        id: "numbers",
        heading: "Numbers",
        blocks: [
          { type: "bullets", items: ["Revenue up", "Costs flat"] },
          {
            type: "table",
            columns: ["Month", "Sales"],
            rows: [
              ["Jan", 100],
              ["Feb", 120],
            ],
          },
        ],
      },
      { id: "close", heading: "Close", blocks: [{ type: "paragraph", text: "Next quarter we expand." }] },
    ],
  };
}

/** A small workbook spec the tests share: one sheet with two typed columns. */
export function sampleWorkbookInput() {
  return {
    title: "Budget",
    sheets: [
      {
        id: "costs",
        name: "Costs",
        columns: [
          { key: "item", header: "Item", type: "text" },
          { key: "amount", header: "Amount", type: "currency" },
        ],
        rows: [
          { item: "Rent", amount: 1200 },
          { item: "Staff", amount: 3400 },
        ],
        totals: true,
      },
    ],
  };
}
