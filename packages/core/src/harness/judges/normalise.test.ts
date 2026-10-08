import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normaliseForMatch } from "./normalise";

const value = (text: string, options?: Parameters<typeof normaliseForMatch>[1]) =>
  normaliseForMatch(text, options).value;

describe("normaliseForMatch: characters", () => {
  it("applies NFKC: ligatures and full-width forms", () => {
    expect(value("the ﬁnal ﬂoor")).toBe("the final floor");
    expect(value("ＡＢＣ １２３")).toBe("ABC 123");
  });

  it("composes a letter and its combining accent", () => {
    expect(value("résumé")).toBe(value("résumé"));
  });

  it("turns NBSP and the other odd spaces into one space", () => {
    expect(value("Rp 1.000 000 x")).toBe("Rp 1.000 000 x");
  });

  it("removes zero-width characters, bidi marks and soft hyphens", () => {
    expect(value("con​tract﻿ ag‍ree­ment ‎end")).toBe("contract agreement end");
  });

  it("unifies curly, angled and straight quote marks", () => {
    expect(value("the “Effective Date” and ‘Term’ and «X» and `y`")).toBe(
      'the "Effective Date" and "Term" and "X" and "y"',
    );
  });

  it("unifies dashes and minus signs", () => {
    expect(value("2020–2021 — net − 5 ‐ six")).toBe("2020-2021 - net - 5 - six");
  });

  it("unifies ellipses, spaced or not", () => {
    expect(value("wait… then . . . go")).toBe("wait... then ... go");
    expect(value("a […] b")).toBe("a [...] b");
  });

  it("collapses whitespace and trims the ends", () => {
    expect(value("  a \t\n  b\r\n\r\n c  ")).toBe("a b c");
  });

  it("folds case only when asked", () => {
    expect(value("GOVERNING Law")).toBe("GOVERNING Law");
    expect(value("GOVERNING Law", { foldCase: true })).toBe("governing law");
  });

  it("returns an empty value and no offsets for an empty or blank string", () => {
    expect(normaliseForMatch("")).toEqual({ value: "", offsets: [], ends: [] });
    expect(normaliseForMatch(" \n\t ").value).toBe("");
  });
});

describe("normaliseForMatch: extraction artefacts", () => {
  it("drops page markers and the line break after them", () => {
    expect(value("end of page one.\n<!-- page 2 -->\nstart of page two")).toBe("end of page one. start of page two");
    expect(value("the Supplier shall\n<!-- page 3 -->\ndeliver")).toBe("the Supplier shall deliver");
  });

  it("joins a word hyphenated across a line break when the next line starts lower case", () => {
    expect(value("the Supplier shall indemni-\nfy the Buyer")).toBe("the Supplier shall indemnify the Buyer");
    expect(value("agree- \r\n  ment")).toBe("agreement");
  });

  it("joins across a page marker", () => {
    expect(value("a payment agree-\n<!-- page 4 -->\nment follows")).toBe("a payment agreement follows");
  });

  it("does not join when the next line starts upper case or a digit", () => {
    expect(value("cost-\nBenefit")).toBe("cost- Benefit");
    expect(value("clause 12-\n3")).toBe("clause 12- 3");
  });

  it("keeps the hyphen when asked not to join, so a real compound still matches", () => {
    expect(value("a well-\nknown risk", { joinHyphens: false })).toBe("a well-known risk");
    expect(value("a well-\nknown risk")).toBe("a wellknown risk");
  });

  it("joins a soft hyphen at a line end the same way", () => {
    expect(value("agree­\nment")).toBe("agreement");
  });

  it("drops markdown emphasis, backslash escapes, leading bullets and table pipes", () => {
    expect(value("**Termination** and __notice__")).toBe("Termination and notice");
    expect(value("a \\*literal\\* star and \\_under\\_")).toBe("a *literal* star and _under_");
    expect(value("- item one\n* item two\n• item three")).toBe("item one item two item three");
    expect(value("| a | b |\n| c | d |")).toBe("a b c d");
  });

  it("does not eat a dash that is part of a sentence", () => {
    expect(value("net 30 - due on receipt")).toBe("net 30 - due on receipt");
  });
});

describe("normaliseForMatch: offsets", () => {
  it("maps each normalised character back to its place in the original", () => {
    const source = "Hello **World** now";
    const n = normaliseForMatch(source);
    const at = n.value.indexOf("World");
    expect(source.slice(n.offsets[at], n.ends[at + 4])).toBe("World");
  });

  it("points an expanded ligature at the one character that made it", () => {
    const n = normaliseForMatch("ﬁne print");
    expect(n.value).toBe("fine print");
    expect([n.offsets[0], n.offsets[1]]).toEqual([0, 0]);
    expect([n.ends[0], n.ends[1]]).toEqual([1, 1]);
    expect(n.offsets[2]).toBe(1);
  });

  it("maps through a dropped page marker and a joined hyphen", () => {
    const source = "pay\n<!-- page 2 -->\nment of agree-\nment";
    const n = normaliseForMatch(source);
    expect(n.value).toBe("pay ment of agreement");
    const at = n.value.indexOf("agreement");
    expect(source.slice(n.offsets[at], n.ends[at + 8])).toBe("agree-\nment");
  });

  it("keeps offsets in range and in order for any input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
        const n = normaliseForMatch(text);
        expect(n.offsets).toHaveLength(n.value.length);
        expect(n.ends).toHaveLength(n.value.length);
        let previous = 0;
        for (let index = 0; index < n.value.length; index += 1) {
          const start = n.offsets[index] as number;
          const end = n.ends[index] as number;
          expect(start).toBeGreaterThanOrEqual(previous);
          expect(end).toBeGreaterThanOrEqual(start);
          expect(end).toBeLessThanOrEqual(text.length);
          previous = start;
        }
        expect(n.value).toBe(n.value.trim());
        expect(n.value).not.toMatch(/\s{2,}/);
      }),
      { numRuns: 100 },
    );
  });

  it("normalises a long document quickly", () => {
    const line = "The Supplier shall deﬁne the Goods within thirty (30) days.\n";
    const text = line.repeat(4000);
    const started = Date.now();
    const n = normaliseForMatch(text);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(n.value.startsWith("The Supplier shall define the Goods within thirty (30) days. The Supplier")).toBe(true);
    expect(n.value).toHaveLength(n.offsets.length);
  });
});
