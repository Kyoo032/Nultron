import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DocxDocument, documentFromPlainText, readDocx, splitClauses } from "@agentforge/core/docx";
import { buildEvidence } from "./evidence";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../core/src/docx/fixtures");
const ACA = new Uint8Array(readFileSync(join(FIXTURES, "lender-initial-aca-draft.docx")));

describe("buildEvidence on a real Word file", () => {
  it("places a quote at its paragraph and clause, whatever the document's own numbering", async () => {
    const doc = await readDocx(ACA);
    const evidence = buildEvidence([{ id: "S1", name: "aca.docx", doc, pages: null }]);
    const clauses = splitClauses(doc);
    const checked = doc.paragraphs.filter((paragraph) => paragraph.text.trim().length >= 40).slice(0, 25);
    expect(checked.length).toBeGreaterThan(5);
    for (const paragraph of checked) {
      const quote = paragraph.text.trim().slice(0, 40);
      const found = evidence.verify(quote, "S1");
      expect(found, paragraph.anchor).not.toBeNull();
      const owner = clauses.find((clause) => clause.paragraphs.includes(paragraph.anchor));
      expect(found?.located.clauseId, paragraph.anchor).toBe(owner?.id ?? null);
      // The text of a paragraph can repeat (a defined term in two places); the first hit is the one reported.
      expect(doc.paragraphs.findIndex((other) => other.text.includes(quote))).toBeLessThanOrEqual(paragraph.index);
    }
  });
});

describe("buildEvidence", () => {
  const withTable = (doc: DocxDocument): DocxDocument => ({
    ...doc,
    tables: [{ index: 0, after: "¶0", rows: [["Facility fee", "Rp 5.000.000"]] }],
  });
  const doc = withTable(
    documentFromPlainText("1. Fees\n\nThe Borrower shall pay the fee below.\n\nThe Lender may terminate."),
  );
  const evidence = buildEvidence([
    { id: "S1", name: "a.pdf", doc, pages: { "¶0": 1, "¶1": 1, "¶2": 2 } },
    { id: "S2", name: "b.docx", doc: documentFromPlainText("Another file about Bank Sinar."), pages: null },
  ]);

  it("finds a quote in a table row and names the table", () => {
    const found = evidence.verify("Facility fee | Rp 5.000.000", "S1");
    expect(found?.located).toEqual({ docId: "S1", anchor: "T0", clauseId: "§1", page: 1 });
  });

  it("gives the page a paragraph is on, when the reader marked pages", () => {
    expect(evidence.verify("The Lender may terminate.", "S1")?.located).toMatchObject({ anchor: "¶2", page: 2 });
    expect(evidence.verify("Another file about Bank Sinar.", "S2")?.located.page).toBeNull();
  });

  it("finds a quote in another file than the one named, and reports where it really is", () => {
    expect(evidence.verify("Another file about Bank Sinar.", "S1")?.located.docId).toBe("S2");
  });

  it("matches across a paragraph break, at the paragraph the quote starts in", () => {
    const found = evidence.verify("The Borrower shall pay the fee below. The Lender may terminate.", "S1");
    expect(found?.located.anchor).toBe("¶1");
  });

  it("does not find words that are not there, or a quote too short to prove anything", () => {
    expect(evidence.verify("The Lender must repay everything at once", "S1")).toBeNull();
    expect(evidence.verify("Rp 5", "S1")).toBeNull();
  });

  it("reads the text around a quote, and finds a party's name written anywhere in the files", () => {
    const found = evidence.verify("The Borrower shall pay the fee below.", "S1");
    expect(found && evidence.window(found, 20)).toContain("The Borrower shall pay the fee below.");
    expect(evidence.mentions("bank  SINAR")).toBe(true);
    expect(evidence.mentions("Somebody Else Ltd")).toBe(false);
    expect(evidence.mentions("")).toBe(false);
    expect(evidence.hasDoc("S2")).toBe(true);
    expect(evidence.hasDoc("S9")).toBe(false);
    expect(evidence.textOf("S9")).toBe("");
  });

  it("is empty-safe: no files, nothing found", () => {
    const none = buildEvidence([]);
    expect(none.verify("any quote that is long enough", "S1")).toBeNull();
    expect(none.docIds).toEqual([]);
  });
});
