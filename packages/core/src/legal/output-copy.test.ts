import { describe, expect, it } from "vitest";
import { LEGAL_ALL_FIELDS } from "./facts";
import { fillCopy, legalOutputCopy } from "./output-copy";

const EN = legalOutputCopy("en");
const ID = legalOutputCopy("id");

function leafKeys(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return [prefix];
}

describe("legal output copy", () => {
  it("has the same keys in English and Indonesian", () => {
    expect(leafKeys(ID).sort()).toEqual(leafKeys(EN).sort());
  });

  it("says Word and PDF are accepted, in both languages", () => {
    expect(EN.unsupportedFile).toMatch(/\.docx/);
    expect(EN.unsupportedFile).toMatch(/PDF/);
    expect(ID.unsupportedFile).toMatch(/\.docx/);
    expect(ID.unsupportedFile).toMatch(/PDF/);
  });

  it("names the phases the extraction and the ask routes emit", () => {
    for (const phase of ["reading", "extracting", "checking", "answering", "saving"]) {
      expect(EN.phase[phase], phase).toBeTruthy();
      expect(ID.phase[phase], phase).toBeTruthy();
    }
  });

  it("labels every field in both languages", () => {
    for (const field of LEGAL_ALL_FIELDS) {
      expect(EN.fieldLabels[field], field).toBeTruthy();
      expect(ID.fieldLabels[field], field).toBeTruthy();
    }
  });

  it("fills the placeholders its messages carry", () => {
    expect(fillCopy(EN.matterTooLarge, { calls: 41 })).toContain("41");
    expect(fillCopy(ID.readingPart, { current: 2, total: 5 })).toBe("Membaca bagian 2 dari 5");
    expect(fillCopy(EN.partFailed, { part: 3 })).toMatch(/3/);
  });
});
