import { describe, expect, it } from "vitest";
import { type LegalExtractEditsFile, type LegalExtractRecord, legalExtractViewSchema } from "@agentforge/core/legal";
import { addComment, applyEdits, buildExtractView, confirmedFacts, confirmedFactsNote } from "./extract-view";

const where = { clauseId: null, page: null, anchor: "¶1" };

function record(overrides: Partial<LegalExtractRecord> = {}): LegalExtractRecord {
  return {
    version: 1,
    matterId: "m1",
    createdAt: 1,
    model: "m",
    locale: "en",
    prompt: "",
    documentType: "Loan agreement",
    read: {
      calls: 1,
      repairs: 0,
      files: [
        { docId: "S1", name: "a.docx", sha256: "aa", chars: 10, chunks: { read: 1, total: 1 }, status: "read" },
        { docId: "S2", name: "b.docx", sha256: "bb", chars: 10, chunks: { read: 1, total: 1 }, status: "read" },
      ],
      partialDocs: [],
    },
    files: [],
    parties: [],
    facts: [
      {
        id: "effective-date:S1",
        field: "effective-date",
        label: "Effective date",
        value: "14 August 2026",
        status: "verified",
        quote: "dated 14 August 2026",
        docId: "S1",
        ...where,
      },
      {
        id: "effective-date:S2",
        field: "effective-date",
        label: "Effective date",
        value: "1 September 2026",
        status: "verified",
        quote: "dated 1 September 2026",
        docId: "S2",
        ...where,
      },
      {
        id: "payment:-",
        field: "payment",
        label: "Payment",
        value: "",
        status: "not-in-documents",
        quote: "",
        docId: "",
        anchor: "",
        clauseId: null,
        page: null,
      },
    ],
    redFlags: [
      {
        id: "flag:S1:abcd1234",
        title: "Uncapped",
        why: "No cap on the indemnity.",
        severity: "high",
        against: "unknown",
        againstParty: "PT Aurora Holdings",
        status: "verified",
        quote: "indemnify without limit",
        docId: "S1",
        ...where,
      },
    ],
    conflicts: [],
    coverage: [],
    checks: { passed: true, rounds: 0, verdicts: [] },
    side: {
      party: null,
      ask: true,
      candidates: [{ party: "PT Aurora Holdings", role: "borrower", counterparty: "Bank Sinar" }],
      source: "ask",
    },
    ...overrides,
  };
}

const NO_EDITS: LegalExtractEditsFile = { version: 1, edits: [], comments: [] };
const MATTER = {
  side: { role: "", party: "", counterparty: "" },
  docs: [
    { id: "S1", sha256: "aa" },
    { id: "S2", sha256: "bb" },
  ],
};

describe("buildExtractView", () => {
  it("is the record, unedited, and parses as the view the UI reads", () => {
    const view = buildExtractView(record(), NO_EDITS, MATTER);
    expect(legalExtractViewSchema.safeParse(view).success).toBe(true);
    expect(view.facts.every((fact) => fact.edited === false && fact.originalValue === null)).toBe(true);
    expect(view.comments).toEqual([]);
    expect(view.stale).toBe(false);
    expect(view.orphanedEdits).toEqual([]);
  });

  it("applies an edit to a fact, marks it edited, and keeps the original value and the quote", () => {
    const file: LegalExtractEditsFile = {
      ...NO_EDITS,
      edits: [{ itemId: "effective-date:S1", value: "15 August 2026", editedAt: 9, editedBy: "local" }],
    };
    const fact = buildExtractView(record(), file, MATTER).facts[0];
    expect(fact).toMatchObject({
      value: "15 August 2026",
      edited: true,
      originalValue: "14 August 2026",
      editedAt: 9,
      editedBy: "local",
      quote: "dated 14 August 2026",
      status: "verified",
    });
  });

  it("applies an edit to a red flag's explanation", () => {
    const file: LegalExtractEditsFile = {
      ...NO_EDITS,
      edits: [
        {
          itemId: "flag:S1:abcd1234",
          value: "The client accepted this in the term sheet.",
          editedAt: 9,
          editedBy: "local",
        },
      ],
    };
    const flag = buildExtractView(record(), file, MATTER).redFlags[0];
    expect(flag).toMatchObject({
      why: "The client accepted this in the term sheet.",
      edited: true,
      originalValue: "No cap on the indemnity.",
      title: "Uncapped",
    });
  });

  it("survives a re-extraction: the edit lands on the same item in the new record, whatever the model now says", () => {
    const file: LegalExtractEditsFile = {
      ...NO_EDITS,
      edits: [{ itemId: "effective-date:S1", value: "15 August 2026", editedAt: 9, editedBy: "local" }],
    };
    const reextracted = record({
      facts: record().facts.map((fact) =>
        fact.id === "effective-date:S1"
          ? { ...fact, value: "14th of August 2026", status: "unverified" as const }
          : fact,
      ),
    });
    const fact = buildExtractView(reextracted, file, MATTER).facts[0];
    expect(fact).toMatchObject({ value: "15 August 2026", edited: true, originalValue: "14th of August 2026" });
  });

  it("keeps an edit whose item a later extraction no longer has, and lists it as orphaned", () => {
    const file: LegalExtractEditsFile = {
      ...NO_EDITS,
      edits: [{ itemId: "term:S3", value: "5 years", editedAt: 9, editedBy: "local" }],
    };
    expect(buildExtractView(record(), file, MATTER).orphanedEdits).toEqual(["term:S3"]);
  });

  it("looks for conflicts in the values the owner now holds", () => {
    const before = buildExtractView(record(), NO_EDITS, MATTER);
    expect(before.conflicts.map((conflict) => conflict.field)).toEqual(["effective-date"]);
    const settled = buildExtractView(
      record(),
      {
        ...NO_EDITS,
        edits: [{ itemId: "effective-date:S2", value: "14 August 2026", editedAt: 9, editedBy: "local" }],
      },
      MATTER,
    );
    expect(settled.conflicts).toEqual([]);
  });

  it("shows the side as it stands: on the matter, declined, or still to ask", () => {
    expect(buildExtractView(record(), NO_EDITS, MATTER).side).toMatchObject({ ask: true, source: "ask" });
    const onMatter = buildExtractView(record(), NO_EDITS, {
      ...MATTER,
      side: { role: "borrower", party: "PT Aurora Holdings", counterparty: "Bank Sinar" },
    });
    expect(onMatter.side).toEqual({ party: "PT Aurora Holdings", ask: false, candidates: [], source: "matter" });
    expect(onMatter.redFlags[0]?.against).toBe("you");
    expect(buildExtractView(record(), NO_EDITS, { ...MATTER, sideDeclined: true }).side).toMatchObject({
      ask: false,
      source: "declined",
    });
  });

  it("says the extraction is stale once a file is added, removed or replaced", () => {
    expect(
      buildExtractView(record(), NO_EDITS, { ...MATTER, docs: [...MATTER.docs, { id: "S3", sha256: "cc" }] }).stale,
    ).toBe(true);
    expect(
      buildExtractView(record(), NO_EDITS, { ...MATTER, docs: [MATTER.docs[0] as (typeof MATTER.docs)[number]] }).stale,
    ).toBe(true);
    expect(
      buildExtractView(record(), NO_EDITS, {
        ...MATTER,
        docs: [{ id: "S1", sha256: "zz" }, MATTER.docs[1] as (typeof MATTER.docs)[number]],
      }).stale,
    ).toBe(true);
  });
});

describe("applyEdits", () => {
  it("sets, replaces and removes edits by item, refusing an item that is not in the extraction", () => {
    const first = applyEdits(record(), NO_EDITS, [{ itemId: "payment:-", value: "  Rp 5 juta  " }], 5, "local");
    expect(first.edits).toEqual([{ itemId: "payment:-", value: "Rp 5 juta", editedAt: 5, editedBy: "local" }]);
    const second = applyEdits(
      record(),
      first,
      [
        { itemId: "payment:-", value: "Rp 6 juta" },
        { itemId: "flag:S1:abcd1234", value: "Accepted." },
      ],
      6,
      "local",
    );
    expect(second.edits.map((edit) => [edit.itemId, edit.value])).toEqual([
      ["payment:-", "Rp 6 juta"],
      ["flag:S1:abcd1234", "Accepted."],
    ]);
    const cleared = applyEdits(record(), second, [{ itemId: "payment:-", value: null }], 7, "local");
    expect(cleared.edits.map((edit) => edit.itemId)).toEqual(["flag:S1:abcd1234"]);
    expect(() => applyEdits(record(), NO_EDITS, [{ itemId: "term:S9", value: "x" }], 1, "local")).toThrow(
      /not an item of this extraction/,
    );
  });

  it("does not change the file it was given", () => {
    const file = Object.freeze({ ...NO_EDITS, edits: Object.freeze([]) as never });
    expect(() => applyEdits(record(), file, [{ itemId: "payment:-", value: "x" }], 1, "local")).not.toThrow();
    expect(file.edits).toEqual([]);
  });
});

describe("addComment", () => {
  it("appends a comment to an item, and refuses an unknown item", () => {
    const next = addComment(record(), NO_EDITS, { itemId: "payment:-", text: " Ask the client. " }, 5, "local", "c1");
    expect(next.comments).toEqual([{ id: "c1", itemId: "payment:-", text: "Ask the client.", at: 5, by: "local" }]);
    expect(() => addComment(record(), NO_EDITS, { itemId: "nope", text: "x" }, 5, "local", "c2")).toThrow(
      /not an item/,
    );
  });

  it("caps the comments one item takes", () => {
    let file = NO_EDITS;
    for (let index = 0; index < 50; index += 1) {
      file = addComment(record(), file, { itemId: "payment:-", text: `note ${index}` }, index, "local", `c${index}`);
    }
    expect(() => addComment(record(), file, { itemId: "payment:-", text: "one more" }, 99, "local", "c99")).toThrow(
      /at most 50 comments/,
    );
  });
});

describe("confirmedFacts", () => {
  it("lists only the facts the owner edited, and words them for the review", () => {
    const view = buildExtractView(
      record(),
      {
        ...NO_EDITS,
        edits: [{ itemId: "effective-date:S1", value: "15 August 2026", editedAt: 9, editedBy: "local" }],
      },
      MATTER,
    );
    const facts = confirmedFacts(view);
    expect(facts).toEqual([
      {
        field: "effective-date",
        label: "Effective date",
        value: "15 August 2026",
        docId: "S1",
        quote: "dated 14 August 2026",
      },
    ]);
    expect(confirmedFactsNote(facts)).toBe(
      "USER-CONFIRMED FACTS (the owner corrected these; treat them as given): Effective date (S1): 15 August 2026.",
    );
    expect(confirmedFactsNote([])).toBe("");
  });
});
