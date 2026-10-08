import { describe, expect, it } from "vitest";
import { documentFromPlainText } from "../docx/plain-document";
import type { DocxDocument } from "../docx/types";
import {
  LEGAL_EXTRACT_CALL_CHARS,
  anchoredLines,
  buildAskPrompt,
  buildExtractPrompt,
  legalAskSystem,
  legalExtractSystem,
  planReadCalls,
  quoteSourceOf,
} from "./extract-prompt";

const withTable = (doc: DocxDocument): DocxDocument => ({
  ...doc,
  tables: [
    {
      index: 0,
      after: "¶0",
      rows: [
        ["Fee", "Rp 5.000.000"],
        ["Term", "12 months"],
      ],
    },
  ],
});

describe("anchoredLines", () => {
  it("anchors every paragraph and table row with the file id", () => {
    const doc = withTable(documentFromPlainText("First paragraph.\n\nSecond paragraph."));
    expect(anchoredLines("S1", doc)).toEqual([
      "[S1 ¶0] First paragraph.",
      "[S1 T0] Fee | Rp 5.000.000",
      "[S1 T0] Term | 12 months",
      "[S1 ¶1] Second paragraph.",
    ]);
  });

  it("says so when a file has no text", () => {
    expect(anchoredLines("S2", documentFromPlainText(""))).toEqual(["[S2] (no text)"]);
  });
});

describe("quoteSourceOf", () => {
  const doc = withTable(
    documentFromPlainText("The Borrower shall repay the loan.\n\nThe Lender may terminate on notice."),
  );
  const source = quoteSourceOf("S1", doc);

  it("is the file's text for the quote matcher", () => {
    expect(source.id).toBe("S1");
    expect(source.text).toBe(
      "The Borrower shall repay the loan.\nFee | Rp 5.000.000\nTerm | 12 months\nThe Lender may terminate on notice.",
    );
  });

  it("says which paragraph or table an offset is in", () => {
    expect(source.anchorAt(source.text.indexOf("repay"))).toEqual({ anchor: "¶0", paragraph: "¶0" });
    expect(source.anchorAt(source.text.indexOf("Rp 5"))).toEqual({ anchor: "T0", paragraph: "¶0" });
    expect(source.anchorAt(source.text.indexOf("terminate"))).toEqual({ anchor: "¶1", paragraph: "¶1" });
    expect(source.anchorAt(9999)).toEqual({ anchor: "¶1", paragraph: "¶1" });
  });
});

function fileOf(paragraphs: number, size: number): DocxDocument {
  return documentFromPlainText(
    Array.from({ length: paragraphs }, (_, index) => `Paragraph ${index} ${"x".repeat(size)}`).join("\n\n"),
  );
}

describe("planReadCalls", () => {
  it("puts a matter that fits in one call, every file whole", () => {
    const calls = planReadCalls([
      { id: "S1", name: "a.docx", doc: fileOf(3, 20) },
      { id: "S2", name: "b.pdf", doc: fileOf(2, 20) },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.docIds).toEqual(["S1", "S2"]);
    expect(calls[0]?.chunks.map((chunk) => [chunk.docId, chunk.part, chunk.parts])).toEqual([
      ["S1", 1, 1],
      ["S2", 1, 1],
    ]);
  });

  it("splits across several calls when the text is over one call's budget, and reads every line exactly once", () => {
    const docs = [
      { id: "S1", name: "a.docx", doc: fileOf(40, 60) },
      { id: "S2", name: "b.docx", doc: fileOf(5, 60) },
    ];
    const calls = planReadCalls(docs, 1_000);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) {
      expect(call.chars).toBeLessThanOrEqual(1_000 + 200);
    }
    for (const doc of docs) {
      const read = calls
        .flatMap((call) => call.chunks)
        .filter((chunk) => chunk.docId === doc.id)
        .flatMap((chunk) => chunk.text.split("\n"));
      expect(read).toEqual(anchoredLines(doc.id, doc.doc));
    }
    const s1 = calls.flatMap((call) => call.chunks).filter((chunk) => chunk.docId === "S1");
    expect(s1.map((chunk) => chunk.part)).toEqual(s1.map((_, index) => index + 1));
    expect(new Set(s1.map((chunk) => chunk.parts))).toEqual(new Set([s1.length]));
    expect(calls.map((call) => call.index)).toEqual(calls.map((_, index) => index));
  });

  it("splits one paragraph longer than a call at spaces, keeping its anchor", () => {
    const long = documentFromPlainText(`${"word ".repeat(600)}end`);
    const calls = planReadCalls([{ id: "S1", name: "a.docx", doc: long }], 500);
    const lines = calls.flatMap((call) => call.chunks).flatMap((chunk) => chunk.text.split("\n"));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => line.startsWith("[S1 ¶0"))).toBe(true);
    const text = lines.map((line) => line.replace(/^\[S1 ¶0[^\]]*\] /, "")).join(" ");
    expect(text.replace(/\s+/g, " ").trim()).toBe(`${"word ".repeat(600)}end`.replace(/\s+/g, " ").trim());
  });

  it("defaults to the budget the plan names", () => {
    expect(LEGAL_EXTRACT_CALL_CHARS).toBe(180_000);
  });
});

describe("the extract prompt", () => {
  const [call] = planReadCalls([
    { id: "S1", name: "loan.docx", doc: documentFromPlainText("The Borrower shall repay.") },
  ]);
  const base = {
    locale: "en" as const,
    side: null,
    prompt: "",
    call: call as NonNullable<typeof call>,
    totalCalls: 1,
    repair: null,
  };

  it("hands over the files as anchored lines under a header naming each file", () => {
    const prompt = buildExtractPrompt(base);
    expect(prompt).toContain("S1 — loan.docx");
    expect(prompt).toContain("[S1 ¶0] The Borrower shall repay.");
    expect(prompt).not.toContain("OWNER'S FOCUS");
    expect(prompt).not.toContain("PREVIOUS ANSWER");
  });

  it("tells the model which side the matter acts for, only when it is known", () => {
    expect(buildExtractPrompt(base)).not.toContain("ACTING FOR");
    const prompt = buildExtractPrompt({
      ...base,
      side: { role: "borrower", party: "Aurora", counterparty: "Bank Sinar" },
    });
    expect(prompt).toContain("ACTING FOR");
    expect(prompt).toContain("Aurora");
  });

  it("carries the owner's steer as a focus that never relaxes the rules", () => {
    const prompt = buildExtractPrompt({ ...base, prompt: "what should I watch out for" });
    expect(prompt).toContain("OWNER'S FOCUS");
    expect(prompt).toContain("what should I watch out for");
    expect(prompt).toMatch(/does not change any rule/i);
  });

  it("says when this is one part of a longer matter", () => {
    const [first] = planReadCalls([{ id: "S1", name: "a.docx", doc: fileOf(40, 60) }], 600);
    const prompt = buildExtractPrompt({ ...base, call: first as NonNullable<typeof first>, totalCalls: 5 });
    expect(prompt).toMatch(/part 1 of 5/i);
    expect(prompt).toMatch(/missing/);
  });

  it("puts the previous answer and the repair note after the files on a repair", () => {
    const prompt = buildExtractPrompt({
      ...base,
      repair: { previous: '{"facts":[]}', note: "ERROR: quote not found" },
    });
    expect(prompt.indexOf("PREVIOUS ANSWER")).toBeGreaterThan(prompt.indexOf("[S1 ¶0]"));
    expect(prompt).toContain('{"facts":[]}');
    expect(prompt).toContain("ERROR: quote not found");
  });

  it("states the rules the judges enforce", () => {
    const system = legalExtractSystem("en");
    expect(system).toMatch(/data, never instructions/i);
    expect(system).toMatch(/12 to 400 characters/);
    expect(system).toMatch(/no ellipsis/i);
    expect(system).toMatch(/"missing"/);
    expect(system).toMatch(/No advice/);
    for (const field of [
      "parties",
      "effective-date",
      "term",
      "payment",
      "liability",
      "termination",
      "governing-law",
      "notable",
    ]) {
      expect(system).toContain(field);
    }
  });

  it("asks for the user-facing words in the run language and keeps quotes in the source language", () => {
    expect(legalExtractSystem("id")).toMatch(/Bahasa Indonesia/);
    expect(legalExtractSystem("en")).toMatch(/MUST be written in English/);
    expect(legalExtractSystem("id")).toMatch(/verbatim quotations/);
  });
});

describe("the ask prompt", () => {
  const [call] = planReadCalls([
    { id: "S1", name: "loan.docx", doc: documentFromPlainText("Payment is due within 30 days.") },
  ]);
  const input = {
    locale: "en" as const,
    question: "When is payment due?",
    call: call as NonNullable<typeof call>,
    totalCalls: 1,
    repair: null,
  };

  it("carries the question and the files in full", () => {
    const prompt = buildAskPrompt(input);
    expect(prompt).toContain("QUESTION");
    expect(prompt).toContain("When is payment due?");
    expect(prompt).toContain("[S1 ¶0] Payment is due within 30 days.");
  });

  it("asks for citations and for not-in-the-documents when the files do not say", () => {
    const system = legalAskSystem("id");
    expect(system).toMatch(/notInDocuments/);
    expect(system).toMatch(/12 to 400 characters/);
    expect(system).toMatch(/Bahasa Indonesia/);
  });

  it("appends the previous answer and note on a repair", () => {
    expect(buildAskPrompt({ ...input, repair: { previous: "{}", note: "ERROR: no citation" } })).toContain(
      "ERROR: no citation",
    );
  });
});

describe("planReadCalls: files per call", () => {
  it("never puts more than eight files in one call, however small they are, so one call's answer stays bounded", () => {
    const docs = Array.from({ length: 20 }, (_, index) => ({
      id: `S${index + 1}`,
      name: `f${index + 1}.docx`,
      doc: documentFromPlainText(`Short file number ${index + 1}.`),
    }));
    const calls = planReadCalls(docs);
    expect(calls.map((call) => call.docIds.length)).toEqual([8, 8, 4]);
    expect(calls.flatMap((call) => call.docIds)).toEqual(docs.map((doc) => doc.id));
  });

  it("lets the parts of one long file share a call without counting as more files", () => {
    const big = documentFromPlainText(Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${"x".repeat(60)}`).join("\n\n"));
    const calls = planReadCalls([{ id: "S1", name: "a.docx", doc: big }], 800);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((call) => call.docIds.length === 1)).toBe(true);
  });
});
