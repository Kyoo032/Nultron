import { describe, expect, it } from "vitest";
import { fitFiguresToCap, joinSheetTexts } from "./join-sheets";

describe("holding text to a cap", () => {
  it("returns short text untouched and long text cut at a line end", () => {
    expect(fitFiguresToCap("a: 1\nb: 2", 100)).toBe("a: 1\nb: 2");
    expect(fitFiguresToCap("aaaa\nbbbb\ncccc", 11)).toBe("aaaa\nbbbb");
  });

  it("keeps the first line even when that line alone is over the cap", () => {
    expect(fitFiguresToCap("abcdefghij\nxyz", 4)).toBe("abcd");
  });
});

describe("joining the sheets of one file", () => {
  it("starts every sheet with its Sheet: line, which is how the scorer tells them apart", () => {
    const joined = joinSheetTexts(
      [
        { name: "Budget", text: "Sheet: Budget\nRent: 100" },
        { name: "Actual", text: "Rent: 120" },
      ],
      1000,
    );
    expect(joined.text).toBe("Sheet: Budget\nRent: 100\nSheet: Actual\nRent: 120");
    expect(joined.used).toEqual(["Budget", "Actual"]);
    expect(joined.skipped).toEqual([]);
  });

  it("adds no Sheet: line to a file with one sheet", () => {
    expect(joinSheetTexts([{ name: "Only", text: "Rent: 100" }], 1000).text).toBe("Rent: 100");
  });

  it("leaves out whole sheets that do not fit, and says which, instead of cutting one in half", () => {
    const big = `Sheet: Big\n${"x: 1\n".repeat(200)}`;
    const joined = joinSheetTexts(
      [
        { name: "A", text: "Sheet: A\na: 1" },
        { name: "Big", text: big },
        { name: "C", text: "Sheet: C\nc: 3" },
      ],
      60,
    );
    expect(joined.used).toEqual(["A", "C"]);
    expect(joined.skipped).toEqual(["Big"]);
    expect(joined.text).toBe("Sheet: A\na: 1\nSheet: C\nc: 3");
  });

  it("skips a sheet that read as nothing", () => {
    const joined = joinSheetTexts(
      [
        { name: "A", text: "a: 1" },
        { name: "Empty", text: "   " },
      ],
      100,
    );
    expect(joined.used).toEqual(["A"]);
  });
});
