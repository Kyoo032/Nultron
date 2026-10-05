import { describe, expect, it } from "vitest";
import { DATA_TOP_REGION, DATA_TOP_UNITS, SALES_CSV, SALES_ROWS } from "./fixtures";

describe("the Data fixture", () => {
  const rows = SALES_CSV.split("\n").map((line) => line.split(","));

  it("is a header and exactly 20 rows of five columns", () => {
    expect(rows[0]).toEqual(["region", "product", "units", "unit_price", "month"]);
    expect(SALES_ROWS).toBe(20);
    expect(rows.every((row) => row.length === 5)).toBe(true);
  });

  it("totals the units per region as the expectations say", () => {
    const totals = new Map<string, number>();
    for (const [region, , units] of rows.slice(1)) {
      totals.set(region as string, (totals.get(region as string) ?? 0) + Number(units));
    }
    expect(Object.fromEntries(totals)).toEqual({ North: 475, South: 300, East: 610, West: 200 });
    const [top] = [...totals].sort((a, b) => b[1] - a[1]);
    expect(top).toEqual([DATA_TOP_REGION, Number(DATA_TOP_UNITS)]);
  });
});
