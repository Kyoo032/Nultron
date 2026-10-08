import { describe, expect, it } from "vitest";
import { coverageGaps, hasCoverageGaps } from "./coverage";

const REQUIRED = ["parties", "effective-date", "term", "payment"] as const;

describe("coverageGaps", () => {
  it("is empty when every required item is there", () => {
    const gaps = coverageGaps(
      REQUIRED,
      REQUIRED.map((id) => ({ id })),
    );
    expect(gaps).toEqual({ missing: [], duplicated: [], unexpected: [] });
    expect(hasCoverageGaps(gaps)).toBe(false);
  });

  it("names what is missing, in the order required", () => {
    const gaps = coverageGaps(REQUIRED, [{ id: "term" }, { id: "parties" }]);
    expect(gaps.missing).toEqual(["effective-date", "payment"]);
    expect(hasCoverageGaps(gaps)).toBe(true);
  });

  it("names what appears twice and what was not asked for", () => {
    const gaps = coverageGaps(REQUIRED, [
      { id: "parties" },
      { id: "effective-date" },
      { id: "term" },
      { id: "payment" },
      { id: "payment" },
      { id: "notable" },
    ]);
    expect(gaps.duplicated).toEqual(["payment"]);
    expect(gaps.unexpected).toEqual(["notable"]);
    expect(gaps.missing).toEqual([]);
    expect(hasCoverageGaps(gaps)).toBe(true);
  });

  it("matches ids without regard to case or surrounding space", () => {
    const gaps = coverageGaps(REQUIRED, [
      { id: " Parties" },
      { id: "EFFECTIVE-DATE " },
      { id: "term" },
      { id: "payment" },
    ]);
    expect(gaps).toEqual({ missing: [], duplicated: [], unexpected: [] });
  });

  it("counts an item the model marked missing as covered (it answered)", () => {
    expect(coverageGaps(["parties"], [{ id: "parties" }]).missing).toEqual([]);
  });

  it("reports every required item missing against no items", () => {
    expect(coverageGaps(REQUIRED, []).missing).toEqual([...REQUIRED]);
  });

  it("works for files read: every file id must be accounted for", () => {
    expect(coverageGaps(["S1", "S2", "S3"], [{ id: "S1" }, { id: "S3" }]).missing).toEqual(["S2"]);
  });

  it("does not repeat a missing id that is required twice", () => {
    expect(coverageGaps(["a", "a", "b"], [{ id: "b" }]).missing).toEqual(["a"]);
  });
});
