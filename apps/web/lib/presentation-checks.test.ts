import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  presentationCheckLine,
  readOutlineChecks,
  readSlideCountInput,
} from "./presentation-checks";

afterEach(() => resetLocaleForTests());

describe("readOutlineChecks", () => {
  it("reads the checks the host returned beside an outline", () => {
    expect(
      readOutlineChecks({
        title: "Vendor switch",
        slides: [],
        checks: [
          { check: "slide_count", slides: [], expected: 3, found: 4 },
          { check: "duplicate_title", slides: [1, 3] },
        ],
      }),
    ).toEqual([
      { check: "slide_count", slides: [], expected: 3, found: 4 },
      { check: "duplicate_title", slides: [1, 3] },
    ]);
  });

  it("returns none for a clean outline or anything that is not a list", () => {
    for (const data of [null, undefined, "text", {}, { checks: "x" }, { checks: {} }, { checks: [] }]) {
      expect(readOutlineChecks(data)).toEqual([]);
    }
  });

  it("drops a note it cannot read instead of showing a half sentence", () => {
    expect(
      readOutlineChecks({
        checks: [
          null,
          "x",
          { check: "made_up", slides: [1] },
          { check: "slide_fit" },
          { check: "slide_fit", slides: [2, 0, -1, 1.5, "3"] },
          { check: "slide_count", slides: [], expected: -2, found: "4" },
        ],
      }),
    ).toEqual([
      { check: "slide_fit", slides: [2] },
      { check: "slide_count", slides: [] },
    ]);
  });
});

describe("presentationCheckLine", () => {
  it("writes each note in English, with slide numbers as the filmstrip counts them (the title is slide 1)", () => {
    applyLocale("en");
    expect(presentationCheckLine({ check: "slide_count", slides: [], expected: 7, found: 8 })).toBe(
      "You asked for 8 slides; this deck has 9.",
    );
    expect(presentationCheckLine({ check: "slide_count", slides: [], found: 15 })).toBe(
      "This deck has 16 slides; 15 is the most.",
    );
    expect(presentationCheckLine({ check: "slide_content", slides: [1, 4] })).toBe(
      "No heading or text on slides: 2, 5",
    );
    expect(presentationCheckLine({ check: "duplicate_title", slides: [2, 3] })).toBe(
      "The same heading on slides: 3, 4",
    );
    expect(presentationCheckLine({ check: "slide_fit", slides: [6] })).toBe("May not fit the slide when downloaded: 7");
  });

  it("writes each note in Indonesian", () => {
    applyLocale("id");
    expect(presentationCheckLine({ check: "slide_count", slides: [], expected: 7, found: 8 })).toBe(
      "Anda meminta 8 slide, tetapi deck ini berisi 9.",
    );
    expect(presentationCheckLine({ check: "duplicate_title", slides: [2, 3] })).toBe(
      "Judul kembar di slide: 3, 4",
    );
    expect(presentationCheckLine({ check: "slide_fit", slides: [6] })).toBe(
      "Mungkin tidak muat di slide saat diunduh: 7",
    );
  });

  it("leaves no placeholder unfilled in either language", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const note of [
        { check: "slide_count", slides: [], expected: 3, found: 5 },
        { check: "slide_count", slides: [], found: 15 },
        { check: "slide_content", slides: [1] },
        { check: "duplicate_title", slides: [1, 2] },
        { check: "slide_fit", slides: [1] },
      ] as const) {
        expect(presentationCheckLine({ ...note, slides: [...note.slides] }), `${locale} ${note.check}`).not.toMatch(
          /[{}]|presentation\./,
        );
      }
    }
  });
});

describe("readSlideCountInput", () => {
  it("treats an empty field as no count", () => {
    expect(readSlideCountInput("")).toEqual({ value: null, invalid: false });
    expect(readSlideCountInput("   ")).toEqual({ value: null, invalid: false });
  });

  it("accepts a whole number inside the range the host accepts", () => {
    expect(readSlideCountInput(String(MIN_SLIDE_COUNT))).toEqual({ value: 2, invalid: false });
    expect(readSlideCountInput(" 9 ")).toEqual({ value: 9, invalid: false });
    expect(readSlideCountInput(String(MAX_SLIDE_COUNT))).toEqual({ value: 15, invalid: false });
  });

  it("marks a number outside the range or not a number invalid, and sends nothing", () => {
    for (const text of ["0", "1", "16", "99", "1.5", "-3", "abc", "1e1"]) {
      expect(readSlideCountInput(text), text).toEqual({ value: null, invalid: true });
    }
  });
});
