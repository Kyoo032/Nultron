import { describe, expect, it } from "vitest";
import { documentFromPlainText, plainTextPages } from "./plain-document";
import { splitClauses } from "./sections";
import { documentText, findQuote } from "./text";

const CONTRACT = [
  "<!-- page 1 -->",
  "LOAN AGREEMENT",
  "",
  'This Agreement is made on 14 August 2026 between PT Aurora Holdings (the "Borrower") and Bank Sinar (the "Lender").',
  "",
  "1. Definitions",
  '"Facility" means the term loan made available under clause 2.',
  "",
  "<!-- page 2 -->",
  "2. The Facility",
  "2.1 The Lender grants the Borrower a facility of Rp 1.500.000.000.",
  "The Borrower shall repay it within",
  "twelve (12) months of the first drawdown.",
].join("\n");

describe("documentFromPlainText", () => {
  const doc = documentFromPlainText(CONTRACT);

  it("makes a paragraph per block, dropping page markers and blank lines, and keeps a wrapped block's lines", () => {
    expect(doc.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "LOAN AGREEMENT",
      'This Agreement is made on 14 August 2026 between PT Aurora Holdings (the "Borrower") and Bank Sinar (the "Lender").',
      '1. Definitions\n"Facility" means the term loan made available under clause 2.',
      "2. The Facility",
      "2.1 The Lender grants the Borrower a facility of Rp 1.500.000.000.\nThe Borrower shall repay it within\ntwelve (12) months of the first drawdown.",
    ]);
    expect(doc.paragraphs.map((paragraph) => paragraph.anchor)).toEqual(["¶0", "¶1", "¶2", "¶3", "¶4"]);
  });

  it("opens a new paragraph at a numbered line even with no blank line before it", () => {
    expect(
      documentFromPlainText(
        "2. The Facility\n2.1 The Lender grants a loan.\n(a) in euros;\n(b) in dollars.",
      ).paragraphs.map((p) => p.number),
    ).toEqual(["2", "2.1", "(a)", "(b)"]);
  });

  it("does not read a wrapped figure at a line start as a clause", () => {
    const wrapped = documentFromPlainText("The fee is\n1.500.000.000 in total, payable monthly.");
    expect(wrapped.paragraphs).toHaveLength(1);
  });

  it("reads clause numbers the way the Word reader does, so clauses split", () => {
    expect(doc.paragraphs[2]?.number).toBe("1");
    expect(doc.paragraphs[4]?.number).toBe("2.1");
    const ids = splitClauses(doc).map((clause) => clause.id);
    expect(ids).toContain("§2.1");
    expect(ids).toContain("§1");
  });

  it("carries the counters, defined terms and an empty revision history", () => {
    expect(doc.stats).toMatchObject({ paragraphs: 5, tables: 0, insertions: 0, deletions: 0, comments: 0 });
    expect(doc.stats.words).toBeGreaterThan(40);
    expect(doc.revisions).toEqual([]);
    expect(doc.comments).toEqual([]);
    expect(doc.tables).toEqual([]);
    expect(doc.definedTerms.map((term) => term.term)).toContain("Facility");
  });

  it("lets findQuote and documentText work on a paragraph that wraps over lines", () => {
    expect(findQuote(doc, "within twelve (12) months of the first drawdown")?.anchor).toBe("¶4");
    expect(documentText(doc)).toContain("[¶1] This Agreement is made on 14 August 2026");
  });

  it("does not mutate its input and returns an empty document for empty text", () => {
    const text = "One.\n\nTwo.";
    documentFromPlainText(text);
    expect(text).toBe("One.\n\nTwo.");
    const empty = documentFromPlainText("  \n \n");
    expect(empty.paragraphs).toEqual([]);
    expect(empty.stats.paragraphs).toBe(0);
  });
});

describe("plainTextPages", () => {
  it("gives each paragraph the page its marker put it on, and page 1 when there are no markers", () => {
    expect(plainTextPages(CONTRACT)).toEqual({ "¶0": 1, "¶1": 1, "¶2": 1, "¶3": 2, "¶4": 2 });
    expect(plainTextPages("A.\n\nB.")).toEqual({ "¶0": 1, "¶1": 1 });
  });

  it("follows a page marker that sits in the middle of a block", () => {
    expect(plainTextPages("first line\n<!-- page 2 -->\nsecond line")).toEqual({ "¶0": 1, "¶1": 2 });
  });
});

describe("documentFromPlainText: a block that is not a paragraph", () => {
  it("does not look for defined terms in a block of tens of thousands of characters, so a crafted file cannot stall the host", () => {
    const definition = '"Term" means a thing. ';
    const crafted = definition.repeat(4_000);
    const started = Date.now();
    const doc = documentFromPlainText(crafted);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(doc.definedTerms).toEqual([]);
    expect(doc.paragraphs).toHaveLength(1);
    expect(documentFromPlainText('"Facility" means the loan.').definedTerms.map((term) => term.term)).toEqual(["Facility"]);
  });
});
