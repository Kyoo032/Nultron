import { describe, expect, it } from "vitest";
import {
  amountsIn,
  extractNumbers,
  isFreeNumber,
  matchesAllowed,
  maskClauseReferences,
  numbersTraced,
} from "./numbers";

const brief = (text: string, locale: "en" | "id" = "en") =>
  amountsIn(text, locale).map(({ value, unit, currency }) => ({ value, unit, currency }));

describe("the finance guard's reader, re-exported", () => {
  it("is the same reader", () => {
    expect(extractNumbers("Rp 1.500.000.000")[0]?.value).toBe(1_500_000_000);
    expect(isFreeNumber({ text: "3", value: 3, unit: "", index: 0 })).toBe(true);
    expect(matchesAllowed(100, [100.2])).toBe(true);
  });
});

describe("amountsIn", () => {
  it("reads Rp 1.500.000.000 as rupiah", () => {
    expect(brief("The cap is Rp 1.500.000.000 per year.", "id")).toEqual([
      { value: 1_500_000_000, unit: "currency", currency: "IDR" },
    ]);
  });

  it("reads USD 5,000,000 and $2,000", () => {
    expect(brief("USD 5,000,000")).toEqual([{ value: 5_000_000, unit: "currency", currency: "USD" }]);
    expect(brief("a fee of $2,000")).toEqual([{ value: 2000, unit: "currency", currency: "USD" }]);
  });

  it("reads magnitude words by the run locale", () => {
    expect(brief("Rp 1,5 miliar", "id")).toEqual([{ value: 1_500_000_000, unit: "currency", currency: "IDR" }]);
    expect(brief("USD 2.5 million")).toEqual([{ value: 2_500_000, unit: "currency", currency: "USD" }]);
    expect(brief("revenue of 18.4B")).toEqual([{ value: 18_400_000_000, unit: "number", currency: "" }]);
    expect(brief("Rp 250 juta", "id")).toEqual([{ value: 250_000_000, unit: "currency", currency: "IDR" }]);
  });

  it("expands a magnitude suffix that follows a short word (expandMagnitudes alone leaves 'of 18.4B')", () => {
    expect(brief("worth about the 18.4B").map((amount) => amount.value)).toEqual([18_400_000_000]);
    // In Indonesian a bare M is a billion; read without expanding it would be a million.
    expect(brief("ada 2,5M", "id").map((amount) => amount.value)).toEqual([2_500_000_000]);
    expect(brief("antara Rp 1 juta dan 5 juta", "id").map((amount) => amount.value)).toEqual([1_000_000, 5_000_000]);
  });

  it("does not read a clause reference as a figure", () => {
    expect(brief("See §7.2, Section 12.3 and Clause 4.1(b).")).toEqual([]);
    expect(brief("Pasal 15 ayat 2 dan Bab 20", "id")).toEqual([]);
    expect(brief("Article 17 and Annex 40")).toEqual([]);
  });

  it("does not read a date or a clock time as a figure", () => {
    expect(brief("14 Agustus 2026 pukul 15.00 dan 2026-08-14", "id")).toEqual([]);
  });

  it("reads percent, months and counts", () => {
    expect(brief("5% and 7,5 persen")).toEqual([
      { value: 5, unit: "percent", currency: "" },
      { value: 7.5, unit: "percent", currency: "" },
    ]);
    expect(brief("24 bulan", "id")).toEqual([{ value: 24, unit: "months", currency: "" }]);
  });

  it("marks small counts and calendar years free, and nothing else", () => {
    const free = (text: string) => amountsIn(text, "en").map((amount) => amount.free);
    expect(free("3 days")).toEqual([true]);
    expect(free("30 days")).toEqual([false]);
    expect(free("in 2026")).toEqual([true]);
    expect(free("Rp 2026")).toEqual([false]);
    expect(free("3%")).toEqual([false]);
  });

  it("gives both readings of an ambiguous 4.804", () => {
    const [amount] = amountsIn("4.804", "id");
    expect([amount?.value, amount?.alternate]).toEqual([4804, 4.804]);
  });

  it("reads nothing from empty text", () => {
    expect(amountsIn("", "en")).toEqual([]);
  });
});

describe("maskClauseReferences", () => {
  it("blanks references at equal length", () => {
    const text = "per §7.2 and Pasal 15 ayat 2, 30 days";
    const masked = maskClauseReferences(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).toContain("30 days");
    expect(masked).not.toMatch(/7\.2|15/);
  });
});

describe("numbersTraced", () => {
  it("traces a figure the evidence states", () => {
    const result = numbersTraced(
      "Liability is capped at Rp 1.500.000.000.",
      "The maximum liability of the Supplier is Rp 1.500.000.000 per contract year.",
      "id",
    );
    expect(result).toMatchObject({ traced: true, untraced: [], checked: 1 });
  });

  it("names a figure the evidence does not state", () => {
    const result = numbersTraced(
      "Liability is capped at Rp 1.600.000.000.",
      "maximum liability Rp 1.500.000.000",
      "id",
    );
    expect(result.traced).toBe(false);
    expect(result.untraced.map((amount) => amount.value)).toEqual([1_600_000_000]);
  });

  it("traces across number formatting and magnitude words", () => {
    expect(numbersTraced("USD 5,000,000", "a sum of USD 5.000.000", "en").traced).toBe(true);
    expect(numbersTraced("1,5 miliar", "Rp 1.500.000.000", "id").traced).toBe(true);
    expect(numbersTraced("5 million", "5,000,000", "en").traced).toBe(true);
    expect(numbersTraced("Rp 250 juta", "sebesar Rp 250.000.000", "id").traced).toBe(true);
  });

  it("does not take a percentage for a day count or an amount", () => {
    expect(numbersTraced("15%", "within 15 days", "en").traced).toBe(false);
    expect(numbersTraced("15 days", "a rate of 15%", "en").traced).toBe(false);
    expect(numbersTraced("15%", "a rate of 15 percent", "en").traced).toBe(true);
    expect(numbersTraced("15%", "tarif 15 persen", "id").traced).toBe(true);
  });

  it("does not take one currency for another, but lets a bare figure stand for either", () => {
    expect(numbersTraced("USD 5,000,000", "IDR 5.000.000", "en").traced).toBe(false);
    expect(numbersTraced("USD 5,000,000", "5,000,000", "en").traced).toBe(true);
    expect(numbersTraced("5,000,000", "USD 5,000,000", "en").traced).toBe(true);
  });

  it("is exact by default and tolerant when asked", () => {
    const claim = "Rp 1.500.000.000";
    const evidence = "Rp 1.505.000.000";
    expect(numbersTraced(claim, evidence, "id").traced).toBe(false);
    expect(numbersTraced(claim, evidence, "id", { tolerance: "rounded" }).traced).toBe(true);
    expect(numbersTraced("Rp 1.500.000.000", "Rp 1.510.000.000", "id", { tolerance: "rounded" }).traced).toBe(false);
  });

  it("ignores clause references, dates and small counts in the claim", () => {
    const result = numbersTraced(
      "Under §7.2 and Pasal 15, the 3 parties must act by 14 Agustus 2026 within 30 days",
      "within 30 days",
      "id",
    );
    expect(result).toMatchObject({ traced: true, checked: 1 });
  });

  it("traces nothing when the claim has no figures", () => {
    expect(numbersTraced("the Supplier shall deliver", "", "en")).toEqual({ traced: true, untraced: [], checked: 0 });
  });

  it("reports every untraced figure in claim order", () => {
    const result = numbersTraced("Rp 100.000, 45 days and 20%", "Rp 100.000", "id");
    expect(result.untraced.map((amount) => [amount.value, amount.unit])).toEqual([
      [45, "count"],
      [20, "percent"],
    ]);
    expect(result.checked).toBe(3);
  });

  it("traces either reading of an ambiguous figure", () => {
    expect(numbersTraced("4.804 units", "4,804 units", "id").traced).toBe(true);
    expect(numbersTraced("4.804 units", "4.804 units", "en").traced).toBe(true);
  });
});
