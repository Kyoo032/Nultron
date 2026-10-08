import { describe, expect, it } from "vitest";
import type { LegalExtractModelResponse } from "@agentforge/core/legal";
import { type CallOutput, mergeCallOutputs } from "./extract-merge";

const fact = (field: string, value: string, quote: string, docId: string, status = "found") =>
  ({ field, label: "", value, status, quote, docId, anchor: "" }) as LegalExtractModelResponse["facts"][number];
const missing = (field: string) => fact(field, "", "", "", "missing");
const flag = (title: string, quote: string, docId: string, severity = "medium") =>
  ({
    title,
    why: "",
    severity,
    against: "unknown",
    quote,
    docId,
    anchor: "",
  }) as LegalExtractModelResponse["redFlags"][number];

function call(index: number, docIds: string[], parts: Partial<LegalExtractModelResponse>): CallOutput {
  return {
    index,
    docIds,
    response: { documentType: "", parties: [], files: [], side: null, facts: [], redFlags: [], ...parts },
    problem: null,
    raw: "",
  };
}

describe("mergeCallOutputs: facts", () => {
  it("keeps a fact once however many calls state it", () => {
    const same = fact("payment", "Rp 1.500.000.000", "The Borrower shall pay Rp 1.500.000.000", "S1");
    const merged = mergeCallOutputs([
      call(0, ["S1"], { facts: [same] }),
      call(1, ["S1"], { facts: [{ ...same, value: " Rp 1.500.000.000 " }] }),
    ]);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]).toMatchObject({ id: "payment:S1", call: 0 });
  });

  it("keeps two files' different values for the same field, one per file, so a conflict can be reported", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], { facts: [fact("effective-date", "14 August 2026", "dated 14 August 2026 between", "S1")] }),
      call(1, ["S2"], { facts: [fact("effective-date", "1 September 2026", "dated 1 September 2026 between", "S2")] }),
    ]);
    expect(merged.facts.map((item) => item.id)).toEqual(["effective-date:S1", "effective-date:S2"]);
  });

  it("numbers a second, different value for the same field in the same file", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], {
        facts: [
          fact("term", "12 months", "within twelve (12) months", "S1"),
          fact("term", "24 months", "extended by twenty-four (24) months", "S1"),
        ],
      }),
    ]);
    expect(merged.facts.map((item) => item.id)).toEqual(["term:S1", "term:S1#2"]);
  });

  it("never reports a field missing when some call found it, and reports an unfound field missing once", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], { facts: [missing("payment"), missing("term")] }),
      call(1, ["S2"], {
        facts: [fact("payment", "Rp 5 juta", "membayar Rp 5 juta setiap bulan", "S2"), missing("term")],
      }),
    ]);
    expect(merged.facts.map((item) => `${item.id}:${item.status}`)).toEqual(["term:-:missing", "payment:S2:found"]);
  });

  it("clears whatever a missing fact carries and drops a missing notable", () => {
    const stray = { ...missing("liability"), value: "unlimited", quote: "made up", docId: "S1" };
    const merged = mergeCallOutputs([call(0, ["S1"], { facts: [stray, missing("notable")] })]);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]).toMatchObject({ field: "liability", value: "", quote: "", docId: "" });
  });

  it("names a notable fact by the words it quotes and orders facts by field", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], {
        facts: [
          fact("notable", "Change of control", "A change of control ends the facility.", "S1"),
          fact("governing-law", "Indonesia", "governed by the laws of Indonesia", "S1"),
          fact("parties", "A and B", "between A and B", "S1"),
        ],
      }),
    ]);
    expect(merged.facts.map((item) => item.field)).toEqual(["parties", "governing-law", "notable"]);
    expect(merged.facts[2]?.id).toMatch(/^notable:S1:[0-9a-f]{8}$/);
  });
});

describe("mergeCallOutputs: the rest", () => {
  it("keeps every red flag once, highest severity first, with ids that follow their quote", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], {
        redFlags: [
          flag("Uncapped", "indemnify without limit", "S1", "low"),
          flag("Exclusivity", "exclusive supplier for ten years", "S1", "high"),
        ],
      }),
      call(1, ["S1"], { redFlags: [flag("Uncapped", "indemnify without limit", "S1", "low")] }),
    ]);
    expect(merged.redFlags.map((item) => item.title)).toEqual(["Exclusivity", "Uncapped"]);
    expect(merged.redFlags[0]?.id).toMatch(/^flag:S1:[0-9a-f]{8}$/);
  });

  it("gives two flags on the same words different ids", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], {
        redFlags: [flag("One", "the same words here", "S1"), flag("Two", "the same words here", "S1")],
      }),
    ]);
    expect(new Set(merged.redFlags.map((item) => item.id)).size).toBe(2);
  });

  it("merges a party named twice, preferring the entry that has a quote", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], { parties: [{ name: "Aurora Holdings", role: "Borrower", quote: "", docId: "S1" }] }),
      call(1, ["S2"], {
        parties: [
          { name: "PT Aurora Holdings", role: "Borrower", quote: "PT Aurora Holdings (the Borrower)", docId: "S2" },
        ],
      }),
    ]);
    expect(merged.parties).toHaveLength(1);
    expect(merged.parties[0]).toMatchObject({
      name: "Aurora Holdings",
      quote: "PT Aurora Holdings (the Borrower)",
      docId: "S2",
    });
  });

  it("keeps the first role a file was given, the first document type, and the surest side pick", () => {
    const merged = mergeCallOutputs([
      call(0, ["S1"], {
        documentType: "",
        files: [{ docId: "S1", role: "draft", reason: "first" }],
        side: { party: "Aurora", confidence: "low", quote: "" },
      }),
      call(1, ["S1", "S2"], {
        documentType: "Loan agreement",
        files: [
          { docId: "S1", role: "signed", reason: "second" },
          { docId: "S2", role: "reference", reason: "" },
        ],
        side: { party: "Aurora Holdings", confidence: "high", quote: "we act for Aurora Holdings" },
      }),
    ]);
    expect(merged.documentType).toBe("Loan agreement");
    expect(merged.files.map((file) => [file.docId, file.role])).toEqual([
      ["S1", "draft"],
      ["S2", "reference"],
    ]);
    expect(merged.side).toMatchObject({ party: "Aurora Holdings", confidence: "high" });
  });

  it("skips a call whose answer could not be read", () => {
    const merged = mergeCallOutputs([
      { index: 0, docIds: ["S1"], response: null, problem: "not valid JSON", raw: "" },
      call(1, ["S2"], { facts: [fact("term", "12 months", "for twelve (12) months", "S2")] }),
    ]);
    expect(merged.facts).toHaveLength(1);
  });
});
