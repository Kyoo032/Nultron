import { describe, expect, it } from "vitest";
import { type ConflictFact, type ConflictKind, findConflicts } from "./conflicts";

const kindOf =
  (kinds: Record<string, ConflictKind>) =>
  (key: string): ConflictKind =>
    kinds[key] ?? "text";

const fact = (key: string, value: string, source?: string): ConflictFact =>
  source === undefined ? { key, value } : { key, value, source };

describe("findConflicts: dates", () => {
  const kinds = kindOf({ "effective-date": "date" });

  it("reports two different dates for one key, with where each came from", () => {
    const found = findConflicts(
      [fact("effective-date", "14 Agustus 2026", "S1"), fact("effective-date", "1 September 2026", "S2")],
      kinds,
      "id",
    );
    expect(found).toEqual([
      {
        key: "effective-date",
        kind: "date",
        values: [
          { value: "14 Agustus 2026", sources: ["S1"] },
          { value: "1 September 2026", sources: ["S2"] },
        ],
      },
    ]);
  });

  it("does not report one date written two ways", () => {
    expect(
      findConflicts(
        [
          fact("effective-date", "14 Agustus 2026", "S1"),
          fact("effective-date", "2026-08-14", "S2"),
          fact("effective-date", "14/08/2026", "S3"),
        ],
        kinds,
        "id",
      ),
    ).toEqual([]);
  });

  it("compares a date with no year on day and month", () => {
    expect(
      findConflicts([fact("effective-date", "14 Agustus"), fact("effective-date", "14 Agustus 2026")], kinds, "id"),
    ).toEqual([]);
    expect(
      findConflicts([fact("effective-date", "14 Agustus"), fact("effective-date", "15 Agustus 2026")], kinds, "id"),
    ).toHaveLength(1);
  });
});

describe("findConflicts: amounts", () => {
  const kinds = kindOf({ payment: "amount", cap: "amount" });

  it("reports two different amounts", () => {
    const found = findConflicts(
      [fact("payment", "Rp 1.500.000.000", "S1"), fact("payment", "Rp 2.000.000.000", "S2")],
      kinds,
      "id",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "payment", kind: "amount" });
    expect(found[0]?.values.map((entry) => entry.value)).toEqual(["Rp 1.500.000.000", "Rp 2.000.000.000"]);
  });

  it("does not report one amount written two ways", () => {
    expect(findConflicts([fact("payment", "Rp 1,5 miliar"), fact("payment", "Rp 1.500.000.000")], kinds, "id")).toEqual(
      [],
    );
    expect(findConflicts([fact("payment", "USD 2.5 million"), fact("payment", "USD 2,500,000")], kinds, "en")).toEqual(
      [],
    );
  });

  it("reports the same number in two currencies", () => {
    expect(findConflicts([fact("payment", "USD 100,000"), fact("payment", "IDR 100.000")], kinds, "en")).toHaveLength(
      1,
    );
  });

  it("is exact by default and rounding-tolerant when asked", () => {
    const facts = [fact("cap", "Rp 1.500.000.000"), fact("cap", "Rp 1.505.000.000")];
    expect(findConflicts(facts, kinds, "id")).toHaveLength(1);
    expect(findConflicts(facts, kinds, "id", { tolerance: "rounded" })).toEqual([]);
  });

  it("falls back to comparing the text when a value holds no amount", () => {
    expect(findConflicts([fact("payment", "to be agreed"), fact("payment", "To be agreed")], kinds, "en")).toEqual([]);
    expect(findConflicts([fact("payment", "to be agreed"), fact("payment", "Rp 5.000.000")], kinds, "en")).toHaveLength(
      1,
    );
  });
});

describe("findConflicts: durations", () => {
  const kinds = kindOf({ term: "duration" });

  it("reads units: 12 months is one year", () => {
    expect(
      findConflicts([fact("term", "12 months"), fact("term", "1 year"), fact("term", "satu tahun")], kinds, "en"),
    ).toEqual([]);
  });

  it("reports different terms", () => {
    const found = findConflicts([fact("term", "12 months", "S1"), fact("term", "24 bulan", "S2")], kinds, "id");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "term", kind: "duration" });
  });
});

describe("findConflicts: text", () => {
  const kinds = kindOf({ "governing-law": "text" });

  it("ignores case, spacing and quote marks", () => {
    expect(
      findConflicts(
        [fact("governing-law", "Laws of Indonesia"), fact("governing-law", "  laws  of\nindonesia ")],
        kinds,
        "en",
      ),
    ).toEqual([]);
  });

  it("treats one value containing the other as the same", () => {
    expect(
      findConflicts(
        [fact("governing-law", "Laws of Indonesia"), fact("governing-law", "the laws of Indonesia")],
        kinds,
        "en",
      ),
    ).toEqual([]);
  });

  it("reports values that differ", () => {
    expect(
      findConflicts(
        [fact("governing-law", "Laws of Indonesia"), fact("governing-law", "Laws of Singapore")],
        kinds,
        "en",
      ),
    ).toHaveLength(1);
  });
});

describe("findConflicts: grouping", () => {
  const kinds = kindOf({ payment: "amount" });

  it("keeps one entry per distinct value and merges where the equal ones came from", () => {
    const found = findConflicts(
      [
        fact("payment", "Rp 1.000.000", "S1"),
        fact("payment", "Rp 2.000.000", "S2"),
        fact("payment", "Rp 1.000.000", "S3"),
        fact("payment", "Rp 1 juta", "S2"),
      ],
      kinds,
      "id",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.values).toEqual([
      { value: "Rp 1.000.000", sources: ["S1", "S3", "S2"] },
      { value: "Rp 2.000.000", sources: ["S2"] },
    ]);
  });

  it("reports each conflicted key once, in order of first appearance", () => {
    const found = findConflicts(
      [fact("b", "x one", "S1"), fact("a", "y one", "S1"), fact("b", "x two", "S2"), fact("a", "y two", "S2")],
      kindOf({}),
      "en",
    );
    expect(found.map((conflict) => conflict.key)).toEqual(["b", "a"]);
  });

  it("finds nothing in one fact, repeated facts, or facts with blank values", () => {
    expect(findConflicts([fact("payment", "Rp 1.000.000")], kinds, "id")).toEqual([]);
    expect(
      findConflicts([fact("payment", "Rp 1.000.000", "S1"), fact("payment", "Rp 1.000.000", "S2")], kinds, "id"),
    ).toEqual([]);
    expect(findConflicts([fact("payment", "Rp 1.000.000"), fact("payment", "   ")], kinds, "id")).toEqual([]);
    expect(findConflicts([], kinds, "id")).toEqual([]);
  });

  it("leaves the facts it was given alone", () => {
    const facts = [fact("payment", "Rp 1.000.000", "S1"), fact("payment", "Rp 2.000.000", "S2")];
    const before = JSON.stringify(facts);
    findConflicts(facts, kinds, "id");
    expect(JSON.stringify(facts)).toBe(before);
  });
});
