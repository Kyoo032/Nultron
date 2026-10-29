import { describe, expect, it } from "vitest";
import { calcDrift, calcFormulaChecks } from "../__fixtures__/calc-formulas";
import { classifyRatioRows, type RatioRowInput } from "./classify";
import { computeRatios, ratioValue } from "./compute";
import { ratioAllowedNumbers, ratioPromptFacts } from "./facts";
import { ratioMetricMeta } from "./keys";
import { ratioCalcTable, ratioInputsTable } from "./report-tables";
import { manufakturRows } from "./__fixtures__/manufaktur";

const manufaktur = computeRatios(classifyRatioRows(manufakturRows()), { daysPerYear: 365 });

function rows(entries: readonly (readonly [string, string, number, number])[]): RatioRowInput[] {
  return entries.flatMap(([label, section, first, second]) => [
    { label, section, period: "2023", amount: first, currency: "IDR" },
    { label, section, period: "2024", amount: second, currency: "IDR" },
  ]);
}

const DEFICIT: readonly (readonly [string, string, number, number])[] = [
  ["Kas", "ASET / Aset Lancar", 100, 100],
  ["Utang Usaha", "LIABILITAS DAN EKUITAS / Liabilitas Jangka Pendek", 150, 150],
  ["Saldo Laba", "LIABILITAS DAN EKUITAS / Ekuitas", -50, -50],
];

describe("equity multiplier", () => {
  it("is total assets over equity, 24.647 / 10.727 miliar in 2024", () => {
    expect(ratioValue(manufaktur, "equityMultiplier", "2024")).toBeCloseTo(24_647 / 10_727, 9);
  });

  it("closes the DuPont identity: net margin x asset turnover x equity multiplier is ROE", () => {
    const margin = (ratioValue(manufaktur, "netMarginPct", "2024") ?? Number.NaN) / 100;
    const turnover = ratioValue(manufaktur, "assetTurnover", "2024") ?? Number.NaN;
    const multiplier = ratioValue(manufaktur, "equityMultiplier", "2024") ?? Number.NaN;
    const roe = (ratioValue(manufaktur, "returnOnEquityPct", "2024") ?? Number.NaN) / 100;
    expect(margin * turnover * multiplier).toBeCloseTo(roe, 9);
  });

  it("is not a figure when equity is zero", () => {
    const empty = computeRatios(
      classifyRatioRows(
        rows([
          ["Kas", "ASET / Aset Lancar", 100, 100],
          ["Utang Usaha", "LIABILITAS DAN EKUITAS / Liabilitas Jangka Pendek", 100, 100],
          ["Saldo Laba", "LIABILITAS DAN EKUITAS / Ekuitas", 0, 0],
        ]),
      ),
    );
    expect(ratioValue(empty, "totalEquity", "2024")).toBe(0);
    expect(ratioValue(empty, "equityMultiplier", "2024")).toBeNull();
  });

  it("reads negative equity as the other equity ratios do: computed, not blanked", () => {
    const deficit = computeRatios(classifyRatioRows(rows(DEFICIT)));
    expect(ratioValue(deficit, "totalEquity", "2024")).toBe(-50);
    expect(ratioValue(deficit, "debtToEquityTotal", "2024")).toBe(-3);
    expect(ratioValue(deficit, "equityMultiplier", "2024")).toBeCloseTo(-2, 9);
  });

  it("writes the same figure to the Calc sheet on negative equity, with no drift", () => {
    const deficit = computeRatios(classifyRatioRows(rows(DEFICIT)));
    const checks = calcFormulaChecks(ratioInputsTable(deficit, "en"), ratioCalcTable(deficit, "en"));
    const multiplier = checks.filter((check) => check.label === "Equity multiplier");
    expect(multiplier.length).toBeGreaterThan(0);
    expect(calcDrift(checks)).toEqual([]);
  });
});

describe("operating cycle", () => {
  it("adds inventory days and receivable days", () => {
    const inventoryDays = (365 * 4_725) / 23_960;
    const receivableDays = (5_180 * 365) / 33_750;
    expect(ratioValue(manufaktur, "operatingCycleDays", "2024")).toBeCloseTo(inventoryDays + receivableDays, 6);
  });

  it("is not a figure when either half is missing", () => {
    const noStock = computeRatios(
      classifyRatioRows(
        rows([
          ["Piutang Usaha", "ASET / Aset Lancar", 40, 50],
          ["Penjualan", "", 1_000, 1_200],
        ]),
      ),
    );
    expect(ratioValue(noStock, "receivableDays", "2024")).not.toBeNull();
    expect(ratioValue(noStock, "operatingCycleDays", "2024")).toBeNull();
  });
});

describe("degree of operating leverage", () => {
  const shop = computeRatios(
    classifyRatioRows(
      rows([
        ["Penjualan", "", 1_000, 1_200],
        ["Harga Pokok Penjualan", "", -600, -700],
        ["Beban Penjualan", "BEBAN USAHA", 300, 350],
      ]),
    ),
  );

  it("is the change in EBIT over the change in revenue: +50% on +20% is 2.5", () => {
    expect(ratioValue(shop, "ebit", "2023")).toBe(100);
    expect(ratioValue(shop, "ebit", "2024")).toBe(150);
    expect(ratioValue(shop, "operatingLeverage", "2024")).toBeCloseTo(2.5, 9);
  });

  it("has no reading for the first period", () => {
    expect(ratioValue(shop, "operatingLeverage", "2023")).toBeNull();
  });

  it("reads the same figure when the newest year is listed first", () => {
    const newestFirst = computeRatios(
      classifyRatioRows(
        rows([
          ["Penjualan", "", 1_000, 1_200],
          ["Harga Pokok Penjualan", "", -600, -700],
          ["Beban Penjualan", "BEBAN USAHA", 300, 350],
        ]).reverse(),
      ),
    );
    expect(newestFirst.periods).toEqual(["2023", "2024"]);
    expect(ratioValue(newestFirst, "operatingLeverage", "2024")).toBeCloseTo(2.5, 9);
    expect(ratioValue(newestFirst, "operatingLeverage", "2023")).toBeNull();
  });

  it("matches its own definition on the two-year manufacturing sheet", () => {
    const ebit = (period: string) => ratioValue(manufaktur, "ebit", period) ?? Number.NaN;
    const revenue = (period: string) => ratioValue(manufaktur, "revenue", period) ?? Number.NaN;
    const expected = (ebit("2024") / ebit("2023") - 1) / (revenue("2024") / revenue("2023") - 1);
    expect(ratioValue(manufaktur, "operatingLeverage", "2024")).toBeCloseTo(expected, 9);
  });

  it("is not a figure when the prior EBIT is exactly zero", () => {
    const even = computeRatios(
      classifyRatioRows(
        rows([
          ["Penjualan", "", 1_000, 1_200],
          ["Harga Pokok Penjualan", "", -700, -800],
          ["Beban Penjualan", "BEBAN USAHA", 300, 350],
        ]),
      ),
    );
    expect(ratioValue(even, "ebit", "2023")).toBe(0);
    expect(ratioValue(even, "operatingLeverage", "2024")).toBeNull();
  });

  it("is not a figure when the prior EBIT is a loss or revenue did not move", () => {
    const loss = computeRatios(
      classifyRatioRows(
        rows([
          ["Penjualan", "", 1_000, 1_200],
          ["Harga Pokok Penjualan", "", -900, -700],
          ["Beban Penjualan", "BEBAN USAHA", 300, 350],
        ]),
      ),
    );
    const flat = computeRatios(
      classifyRatioRows(
        rows([
          ["Penjualan", "", 1_000, 1_000],
          ["Harga Pokok Penjualan", "", -600, -550],
          ["Beban Penjualan", "BEBAN USAHA", 300, 300],
        ]),
      ),
    );
    expect(ratioValue(loss, "operatingLeverage", "2024")).toBeNull();
    expect(ratioValue(flat, "operatingLeverage", "2024")).toBeNull();
  });
});

describe("the new ratios reach the reader, the model and the guard", () => {
  const keys = ["equityMultiplier", "operatingCycleDays", "operatingLeverage"];

  it("are labelled in both languages", () => {
    for (const key of keys) {
      const meta = ratioMetricMeta(key);
      expect(meta?.label.en).toBeTruthy();
      expect(meta?.label.id).toBeTruthy();
      expect(meta?.formula.en).toBeTruthy();
      expect(meta?.formula.id).toBeTruthy();
    }
  });

  it("are in the fact sheet and in the allowed numbers", () => {
    const facts = ratioPromptFacts(manufaktur, "en");
    const allowed = ratioAllowedNumbers(manufaktur);
    for (const key of keys) {
      expect(facts).toContain(`${key}.2024`);
      const value = ratioValue(manufaktur, key, "2024");
      expect(value).not.toBeNull();
      expect(allowed.some((number) => Math.abs(number - (value as number)) < 1e-9)).toBe(true);
    }
  });
});
