import { describe, expect, it } from "vitest";
import { FIXTURE_TEXT } from "./audio";
import { carriesText, describeText, normalizeText, shortHash, wordOverlap } from "./text";

describe("output hides words by default", () => {
  const caption = "Berapa total penjualan saya bulan lalu?";

  it("shows a length and a short hash, never the words", () => {
    const described = describeText(caption, { showText: false });
    expect(described).toMatch(/^\d+ chars #[0-9a-f]{8}$/);
    expect(described).not.toContain("penjualan");
    expect(described).toContain(`${caption.length} chars`);
  });

  it("shows the words with --show-text", () => {
    expect(describeText(caption, { showText: true })).toBe(JSON.stringify(caption));
  });

  it("gives the same hash to the same words in another case or punctuation, and another to other words", () => {
    expect(shortHash("Halo, apa kabar?")).toBe(shortHash("halo apa kabar"));
    expect(shortHash("Halo")).not.toBe(shortHash("Selamat pagi"));
    expect(shortHash("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("caption matching", () => {
  it("normalises case, punctuation and spacing", () => {
    expect(normalizeText("  Halo,   APA kabar?! ")).toBe("halo apa kabar");
  });

  it("counts the share of the expected words that are present", () => {
    expect(wordOverlap("berapa total penjualan", FIXTURE_TEXT.fact)).toBeCloseTo(0.5, 5);
    expect(wordOverlap("sesuatu yang lain sama sekali", FIXTURE_TEXT.fact)).toBe(0);
  });

  it("accepts the speech model's rough hearing, and refuses something else", () => {
    // "Stop, tunggu dulu." came back as "Tunggu dulu." in the host's own notes.
    expect(carriesText("Tunggu dulu.", FIXTURE_TEXT.stop)).toBe(true);
    expect(carriesText("Berapa total penjualan saya bulan lalu", FIXTURE_TEXT.fact)).toBe(true);
    expect(carriesText("Halo, apa kabar hari ini?", FIXTURE_TEXT.fact)).toBe(false);
    expect(carriesText("Tolong buatkan deck dari riset kemarin", FIXTURE_TEXT.task)).toBe(true);
  });

  it("counts a text with no long words as matched", () => {
    expect(wordOverlap("anything", "Ok")).toBe(1);
  });
});
