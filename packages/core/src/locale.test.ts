import { describe, expect, it } from "vitest";
import { APP_LOCALES, DEFAULT_APP_LOCALE, isAppLocale, localeFromAcceptLanguage, parseAppLocale } from "./locale";

describe("parseAppLocale", () => {
  it("accepts en and id only", () => {
    expect(APP_LOCALES).toEqual(["en", "id"]);
    expect(DEFAULT_APP_LOCALE).toBe("en");
    expect(isAppLocale("en")).toBe(true);
    expect(isAppLocale("id")).toBe(true);
    expect(isAppLocale("ID")).toBe(false);
    expect(isAppLocale("fr")).toBe(false);
    expect(parseAppLocale("id")).toBe("id");
    expect(parseAppLocale("en")).toBe("en");
    expect(parseAppLocale(undefined)).toBe("en");
    expect(parseAppLocale("de")).toBe("en");
  });
});

describe("localeFromAcceptLanguage", () => {
  it("reads Indonesian and English tags, with or without a region", () => {
    expect(localeFromAcceptLanguage("id")).toBe("id");
    expect(localeFromAcceptLanguage("id-ID")).toBe("id");
    expect(localeFromAcceptLanguage("en")).toBe("en");
    expect(localeFromAcceptLanguage("en-US")).toBe("en");
    expect(localeFromAcceptLanguage("en-GB")).toBe("en");
  });

  it("reads the legacy `in` code as Indonesian", () => {
    expect(localeFromAcceptLanguage("in")).toBe("id");
    expect(localeFromAcceptLanguage("in-ID")).toBe("id");
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(localeFromAcceptLanguage("  ID-id ")).toBe("id");
    expect(localeFromAcceptLanguage("EN-us , id ; q=0.5")).toBe("en");
  });

  it("takes the highest-weighted supported tag, not the first one listed", () => {
    expect(localeFromAcceptLanguage("en;q=0.5,id;q=0.9")).toBe("id");
    expect(localeFromAcceptLanguage("id-ID,id;q=0.9,en;q=0.8")).toBe("id");
    expect(localeFromAcceptLanguage("en-US,en;q=0.9,id;q=0.8")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=0.2, en;q=0.3")).toBe("en");
  });

  it("treats a missing q as 1 and breaks a tie by header order", () => {
    expect(localeFromAcceptLanguage("en,id")).toBe("en");
    expect(localeFromAcceptLanguage("id,en")).toBe("id");
    expect(localeFromAcceptLanguage("id;q=0.7,en;q=0.7")).toBe("id");
    expect(localeFromAcceptLanguage("en;q=0.8,id")).toBe("id");
  });

  it("skips tags it does not serve and lets a lower-ranked supported one win", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,id;q=0.5")).toBe("id");
    expect(localeFromAcceptLanguage("de, ja;q=0.9, en;q=0.1")).toBe("en");
    expect(localeFromAcceptLanguage("ms-MY,ms;q=0.9,id;q=0.4")).toBe("id");
  });

  it("returns null when nothing it serves is acceptable", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9")).toBeNull();
    expect(localeFromAcceptLanguage("ja")).toBeNull();
    expect(localeFromAcceptLanguage("*")).toBeNull();
    expect(localeFromAcceptLanguage("*;q=0.5")).toBeNull();
  });

  it("honours q=0 as 'not acceptable'", () => {
    expect(localeFromAcceptLanguage("id;q=0")).toBeNull();
    expect(localeFromAcceptLanguage("id;q=0, en;q=0.1")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=0.000,en;q=0")).toBeNull();
  });

  it("returns null for empty, missing and non-string input", () => {
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage("   ")).toBeNull();
    expect(localeFromAcceptLanguage(undefined)).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
    expect(localeFromAcceptLanguage(42 as unknown as string)).toBeNull();
    expect(localeFromAcceptLanguage(["id"] as unknown as string)).toBeNull();
    expect(localeFromAcceptLanguage({} as unknown as string)).toBeNull();
  });

  it("returns null for garbage, never a guess", () => {
    for (const header of [",", ",,,", ";", ";q=1", "q=1", "id q=1", "!!!", "i d", "<script>", "en/id", "\u0000"]) {
      expect(localeFromAcceptLanguage(header), JSON.stringify(header)).toBeNull();
    }
  });

  it("ignores an entry with a malformed or out-of-range weight and keeps reading the rest", () => {
    expect(localeFromAcceptLanguage("id;q=abc, en;q=0.4")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=1.5, en;q=0.4")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=-1, en;q=0.4")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=, en;q=0.4")).toBe("en");
    expect(localeFromAcceptLanguage("id;q=NaN")).toBeNull();
    expect(localeFromAcceptLanguage("id;q=Infinity")).toBeNull();
  });

  it("reads a weight with other parameters around it", () => {
    expect(localeFromAcceptLanguage("en;level=1;q=0.2, id;q=0.3")).toBe("id");
    expect(localeFromAcceptLanguage("id ; q = 0.3, en;q=0.2")).toBe("id");
  });

  it("does not mistake a tag that merely starts with id or en for one", () => {
    expect(localeFromAcceptLanguage("ido")).toBeNull();
    expect(localeFromAcceptLanguage("eng")).toBeNull();
    expect(localeFromAcceptLanguage("idx-ID")).toBeNull();
    expect(localeFromAcceptLanguage("enx")).toBeNull();
  });

  it("stays bounded on a hostile header", () => {
    const flood = `${"x,".repeat(50_000)}id`;
    const started = Date.now();
    // Only the first KiB of the header is read, so the supported tag at the far end is never reached.
    expect(localeFromAcceptLanguage(flood)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(localeFromAcceptLanguage(`${"a".repeat(100_000)};q=1`)).toBeNull();
  });
});
