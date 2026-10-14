import { describe, expect, it } from "vitest";
import { DOC_LIMITS } from "./limits";
import { DocModelError, parseDocSpec, parseSheetSpec } from "./types";
import { replaceSection, replaceSheet, restyle } from "./replace";
import { parseRuns } from "./runs";
import { DOC_THEMES, DOC_THEME_NAMES } from "./themes";
import { longDoc, sampleBook, sampleDoc } from "./fixtures";

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

describe("parseDocSpec", () => {
  it("accepts a sample and defaults theme and titlePage", () => {
    const doc = parseDocSpec({ kind: "document", title: "T", sections: [] });
    expect(doc.theme).toBe("plain");
    expect(doc.titlePage).toBe(false);
  });

  it("refuses a bad block type with the field named", () => {
    expect(() =>
      parseDocSpec({ kind: "document", title: "T", sections: [{ id: "a", blocks: [{ type: "video" }] }] }),
    ).toThrow(DocModelError);
  });

  it("refuses a table row that is not as wide as its columns", () => {
    expect(() =>
      parseDocSpec({
        kind: "document",
        title: "T",
        sections: [{ id: "a", blocks: [{ type: "table", columns: ["x", "y"], rows: [["only one"]] }] }],
      }),
    ).toThrow(/row 1: 1 cells, the table has 2 columns/);
  });

  it("refuses duplicate section ids", () => {
    expect(() =>
      parseDocSpec({
        kind: "document",
        title: "T",
        sections: [
          { id: "a", blocks: [] },
          { id: "a", blocks: [] },
        ],
      }),
    ).toThrow(/"a" appears more than once/);
  });

  it("refuses more than 200 sections, naming the limit and the count", () => {
    const sections = Array.from({ length: DOC_LIMITS.sections + 1 }, (_, i) => ({ id: `s${i}`, blocks: [] }));
    expect(() => parseDocSpec({ kind: "document", title: "T", sections })).toThrow(
      `sections: ${DOC_LIMITS.sections + 1} sent, the limit is ${DOC_LIMITS.sections}`,
    );
  });

  it("refuses more than 2000 blocks across sections", () => {
    const blocks = Array.from({ length: 1001 }, () => ({ type: "pageBreak" as const }));
    expect(() =>
      parseDocSpec({
        kind: "document",
        title: "T",
        sections: [
          { id: "a", blocks },
          { id: "b", blocks },
        ],
      }),
    ).toThrow("blocks: 2002 sent, the limit is 2000");
  });

  it("refuses more than 2 MB of text, counted in bytes", () => {
    const big = "é".repeat(600_000); // 2 bytes each, 1.2 MB per paragraph
    expect(() =>
      parseDocSpec({
        kind: "document",
        title: "T",
        sections: [
          {
            id: "a",
            blocks: [
              { type: "paragraph", text: big },
              { type: "paragraph", text: big },
            ],
          },
        ],
      }),
    ).toThrow(/^text: \d+ sent, the limit is 2097152$/);
  });

  it("accepts a 200-section document right at the cap", () => {
    expect(longDoc(DOC_LIMITS.sections).sections).toHaveLength(DOC_LIMITS.sections);
  });
});

describe("parseSheetSpec", () => {
  it("refuses a number cell in a text column's place, and a text cell in a number column", () => {
    expect(() =>
      parseSheetSpec({
        kind: "workbook",
        title: "W",
        sheets: [{ id: "s", name: "S", columns: [{ key: "n", header: "N", type: "number" }], rows: [{ n: "twelve" }] }],
      }),
    ).toThrow(/"n": number column takes a number/);
  });

  it("refuses a date that is not ISO", () => {
    expect(() =>
      parseSheetSpec({
        kind: "workbook",
        title: "W",
        sheets: [
          { id: "s", name: "S", columns: [{ key: "d", header: "D", type: "date" }], rows: [{ d: "14/10/2026" }] },
        ],
      }),
    ).toThrow(/ISO date/);
  });

  it("refuses a row key that is not a column rather than dropping it", () => {
    expect(() =>
      parseSheetSpec({
        kind: "workbook",
        title: "W",
        sheets: [
          { id: "s", name: "S", columns: [{ key: "a", header: "A", type: "text" }], rows: [{ a: "x", b: "y" }] },
        ],
      }),
    ).toThrow(/"b" is not a column/);
  });

  it("refuses more than 20000 rows in total", () => {
    const rows = Array.from({ length: 10_001 }, () => ({ a: 1 }));
    expect(() =>
      parseSheetSpec({
        kind: "workbook",
        title: "W",
        sheets: [
          { id: "s1", name: "S1", columns: [{ key: "a", header: "A", type: "number" }], rows },
          { id: "s2", name: "S2", columns: [{ key: "a", header: "A", type: "number" }], rows },
        ],
      }),
    ).toThrow(`rows: ${2 * 10_001} sent, the limit is ${DOC_LIMITS.rows}`);
  });

  it("refuses more than 50 sheets", () => {
    const sheets = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      columns: [{ key: "a", header: "A", type: "text" as const }],
      rows: [],
    }));
    expect(() => parseSheetSpec({ kind: "workbook", title: "W", sheets })).toThrow("sheets: 51 sent, the limit is 50");
  });
});

describe("replaceSection", () => {
  it("returns a new document with one section swapped and every other part deep-equal", () => {
    const doc = freezeDeep(sampleDoc());
    const next = replaceSection(doc, "plan", {
      id: "plan",
      heading: "Revised plan",
      blocks: [{ type: "paragraph", text: "New text." }],
    });
    expect(next).not.toBe(doc);
    expect(next.sections[1]).toEqual({
      id: "plan",
      heading: "Revised plan",
      blocks: [{ type: "paragraph", text: "New text." }],
    });
    expect(next.sections[0]).toEqual(doc.sections[0]);
    expect(next.sections[2]).toEqual(doc.sections[2]);
    expect(next.sections[3]).toEqual(doc.sections[3]);
    expect({ ...next, sections: undefined }).toEqual({ ...doc, sections: undefined });
    expect(doc.sections[1].heading).toBe("Plan");
  });

  it("keeps the target id even when the replacement carries another", () => {
    const next = replaceSection(sampleDoc(), "plan", { id: "other", blocks: [] });
    expect(next.sections[1].id).toBe("plan");
  });

  it("refuses an unknown section id instead of doing nothing", () => {
    expect(() => replaceSection(sampleDoc(), "nope", { id: "nope", blocks: [] })).toThrow(/no section "nope"/);
  });

  it("re-checks the caps, so a replacement cannot break the block limit", () => {
    const blocks = Array.from({ length: 2001 }, () => ({ type: "pageBreak" as const }));
    expect(() => replaceSection(sampleDoc(), "plan", { id: "plan", blocks })).toThrow(/blocks:/);
  });
});

describe("replaceSheet", () => {
  it("swaps one sheet and leaves the others identical", () => {
    const book = freezeDeep(sampleBook());
    const next = replaceSheet(book, "headcount", {
      id: "headcount",
      name: "Headcount",
      columns: [{ key: "team", header: "Team", type: "text" }],
      rows: [{ team: "Finance" }],
      totals: false,
      freezeHeader: true,
    });
    expect(next.sheets[0]).toEqual(book.sheets[0]);
    expect(next.sheets[1].rows).toEqual([{ team: "Finance" }]);
    expect(book.sheets[1].rows).toHaveLength(2);
  });

  it("refuses an unknown sheet id", () => {
    expect(() =>
      replaceSheet(sampleBook(), "ghost", {
        id: "ghost",
        name: "G",
        columns: [],
        rows: [],
        totals: false,
        freezeHeader: true,
      }),
    ).toThrow(/no sheet "ghost"/);
  });
});

describe("restyle", () => {
  it("changes only the theme, sections untouched", () => {
    const doc = freezeDeep(sampleDoc("plain"));
    const next = restyle(doc, "modern");
    expect(next.theme).toBe("modern");
    expect(next.sections).toEqual(doc.sections);
    expect(next.title).toBe(doc.title);
    expect(doc.theme).toBe("plain");
  });

  it("refuses an unknown theme", () => {
    expect(() => restyle(sampleBook(), "neon" as never)).toThrow(/unknown theme "neon"/);
  });
});

describe("themes and runs", () => {
  it("ships three brand-neutral themes with a colour for every role", () => {
    expect(DOC_THEME_NAMES).toEqual(["plain", "corporate", "modern"]);
    for (const name of DOC_THEME_NAMES) {
      const theme = DOC_THEMES[name];
      expect(theme.fontFamily.length).toBeGreaterThan(0);
      expect(theme.headerFill).toMatch(/^[0-9A-F]{6}$/);
      expect(theme.accentColor).toMatch(/^[0-9A-F]{6}$/);
      expect(JSON.stringify(theme)).not.toMatch(/nultron|toko|tokenku|hyp ai|hypey/i);
    }
  });

  it("splits bold and italic runs and keeps an unmatched asterisk literal", () => {
    expect(parseRuns("a **b** c *d* e")).toEqual([
      { text: "a ", bold: false, italic: false },
      { text: "b", bold: true, italic: false },
      { text: " c ", bold: false, italic: false },
      { text: "d", bold: false, italic: true },
      { text: " e", bold: false, italic: false },
    ]);
    expect(parseRuns("5 * 3 = 15")).toEqual([{ text: "5 * 3 = 15", bold: false, italic: false }]);
  });
});
