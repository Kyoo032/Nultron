import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_CHARS,
  ELIDED_GAP_MAX_CHARS,
  QUOTE_MIN_CHARS,
  createQuoteIndex,
  matchQuote,
  windowAround,
} from "./quote";

const DELIVERY =
  "The Supplier shall deliver the Goods within thirty (30) days of the Order and shall bear all risk until delivery.";

describe("matchQuote", () => {
  it("finds a verbatim quote and says where", () => {
    const quote = "shall deliver the Goods within thirty (30) days";
    const hit = matchQuote(quote, [{ id: "S1", text: DELIVERY }]);
    expect(hit).toMatchObject({ sourceId: "S1", mode: "exact" });
    expect(DELIVERY.slice(hit?.start, hit?.end)).toBe(quote);
  });

  it("finds a quote that the source breaks over lines (PDF text)", () => {
    const source = "The Supplier shall deliver the\nGoods within thirty\n(30) days of the Order.";
    const hit = matchQuote("shall deliver the Goods within thirty (30) days", [{ id: "S1", text: source }]);
    expect(hit?.mode).toBe("normalised");
    expect(source.slice(hit?.start, hit?.end)).toBe("shall deliver the\nGoods within thirty\n(30) days");
  });

  it("finds a quote across a hyphenated line break, in both spellings of the join", () => {
    const joined = "the Supplier shall indemni-\nfy the Buyer against all loss";
    expect(matchQuote("the Supplier shall indemnify the Buyer", [{ id: "S1", text: joined }])?.mode).toBe("normalised");
    const compound = "there is a well-\nknown risk in the market";
    expect(matchQuote("there is a well-known risk in the market", [{ id: "S1", text: compound }])?.mode).toBe(
      "normalised",
    );
    expect(matchQuote("there is a wellknown risk in the market", [{ id: "S1", text: compound }])?.mode).toBe(
      "normalised",
    );
  });

  it("finds a quote that differs in quote marks, dashes, ligatures and spaces", () => {
    const source = "the “Effective Date” means the ﬁrst day of the Term — or earlier";
    const hit = matchQuote('the "Effective Date" means the first day of the Term - or earlier', [
      { id: "S1", text: source },
    ]);
    expect(hit?.mode).toBe("normalised");
    expect(hit?.start).toBe(0);
    expect(hit?.end).toBe(source.length);
  });

  it("finds a quote through page markers and markdown in the source", () => {
    const source = "Payment is due within\n<!-- page 3 -->\n**thirty (30) days** of the invoice date.";
    const hit = matchQuote("Payment is due within thirty (30) days of the invoice", [{ id: "S1", text: source }]);
    expect(hit?.mode).toBe("normalised");
    expect(source.slice(hit?.start, hit?.end)).toContain("of the invoice");
    expect(source.slice(hit?.start, hit?.end).startsWith("Payment")).toBe(true);
  });

  it("falls back to case folding last", () => {
    const source = "GOVERNING LAW: the laws of the Republic of Indonesia apply";
    const hit = matchQuote("Governing Law: the laws of the Republic of Indonesia", [{ id: "S1", text: source }]);
    expect(hit).toMatchObject({ sourceId: "S1", mode: "case-folded" });
  });

  it("prefers exact over normalised over case-folded within a source", () => {
    const source = "Thirty days notice.\nthirty days notice.";
    expect(matchQuote("thirty days notice.", [{ id: "S1", text: source }])?.mode).toBe("exact");
  });

  it("reads an elided quote: parts in order, each at least 12 characters", () => {
    const hit = matchQuote("The Supplier shall deliver the Goods ... shall bear all risk until delivery", [
      { id: "S1", text: DELIVERY },
    ]);
    expect(hit?.mode).toBe("elided");
    expect(hit?.start).toBe(0);
    expect(DELIVERY.slice(hit?.start, hit?.end)).toBe(DELIVERY.slice(0, DELIVERY.length - 1));
  });

  it("reads the ellipsis character and a bracketed ellipsis too", () => {
    expect(matchQuote("The Supplier shall deliver… shall bear all risk", [{ id: "S1", text: DELIVERY }])?.mode).toBe(
      "elided",
    );
    expect(
      matchQuote("The Supplier shall deliver [...] shall bear all risk", [{ id: "S1", text: DELIVERY }])?.mode,
    ).toBe("elided");
  });

  it("refuses an elided quote whose parts are out of order", () => {
    expect(
      matchQuote("shall bear all risk until delivery ... The Supplier shall deliver", [{ id: "S1", text: DELIVERY }]),
    ).toBeNull();
  });

  it("refuses an elided quote with a part shorter than the minimum", () => {
    expect(matchQuote("The Supplier shall deliver ... risk", [{ id: "S1", text: DELIVERY }])).toBeNull();
    expect(matchQuote("the Order ... shall bear all risk until delivery", [{ id: "S1", text: DELIVERY }])).toBeNull();
  });

  it("refuses parts that sit too far apart", () => {
    const far = `${"Opening words of the first part"} ${"x ".repeat(ELIDED_GAP_MAX_CHARS)}closing words of the last part`;
    expect(
      matchQuote("Opening words of the first part ... closing words of the last part", [{ id: "S1", text: far }]),
    ).toBeNull();
    const near = `Opening words of the first part ${"x ".repeat(100)}closing words of the last part`;
    expect(
      matchQuote("Opening words of the first part ... closing words of the last part", [{ id: "S1", text: near }])
        ?.mode,
    ).toBe("elided");
  });

  it("tries a later occurrence of the first part when the first one has no partner", () => {
    const source = `The Supplier shall deliver the Goods late. ${"filler ".repeat(200)} The Supplier shall deliver the Goods and shall bear all risk.`;
    const hit = matchQuote("The Supplier shall deliver the Goods ... and shall bear all risk", [
      { id: "S1", text: source },
    ]);
    expect(hit?.mode).toBe("elided");
    expect(hit?.start).toBeGreaterThan(1000);
  });

  it("holds the minimum length", () => {
    expect(QUOTE_MIN_CHARS).toBe(12);
    expect(matchQuote("the Goods", [{ id: "S1", text: DELIVERY }])).toBeNull();
    const sources = [{ id: "S1", text: "Delivery Day is a Monday." }];
    expect(matchQuote("Delivery Day", sources)).toMatchObject({ mode: "exact" });
    expect(matchQuote("Delivery Da", sources)).toBeNull();
  });

  it("counts the minimum after normalisation, not before", () => {
    expect(matchQuote("**Delivery**", [{ id: "S1", text: "Delivery Day is a Monday." }])).toBeNull();
  });

  it("returns null for a quote that is nowhere, blank, or against no sources", () => {
    expect(matchQuote("The Buyer shall collect the Goods at the depot", [{ id: "S1", text: DELIVERY }])).toBeNull();
    expect(matchQuote("   ", [{ id: "S1", text: DELIVERY }])).toBeNull();
    expect(matchQuote("The Supplier shall deliver", [])).toBeNull();
    expect(matchQuote("The Supplier shall deliver", [{ id: "S1", text: "" }])).toBeNull();
  });

  it("looks in the preferred source first and otherwise in order", () => {
    const sources = [
      { id: "S1", text: DELIVERY },
      { id: "S2", text: `Another copy. ${DELIVERY}` },
    ];
    const quote = "shall deliver the Goods within thirty (30) days";
    expect(matchQuote(quote, sources)?.sourceId).toBe("S1");
    expect(matchQuote(quote, sources, "S2")?.sourceId).toBe("S2");
    expect(matchQuote(quote, sources, "S9")?.sourceId).toBe("S1");
  });

  it("finds a quote that is only in a source other than the preferred one", () => {
    const sources = [
      { id: "S1", text: "Nothing relevant here at all." },
      { id: "S2", text: DELIVERY },
    ];
    expect(matchQuote("shall deliver the Goods within thirty (30) days", sources, "S1")?.sourceId).toBe("S2");
  });

  it("reports the first occurrence", () => {
    const source = "the Goods are delivered. later: the Goods are delivered.";
    expect(matchQuote("the Goods are delivered.", [{ id: "S1", text: source }])?.start).toBe(0);
  });
});

describe("createQuoteIndex", () => {
  it("answers many quotes against the same sources the same way as matchQuote", () => {
    const sources = [
      { id: "S1", text: DELIVERY },
      { id: "S2", text: "Payment is due within\n<!-- page 3 -->\nthirty (30) days of the invoice date." },
    ];
    const index = createQuoteIndex(sources);
    for (const quote of [
      "shall deliver the Goods within thirty (30) days",
      "Payment is due within thirty (30) days",
      "not in either source at all",
    ]) {
      expect(index.match(quote)).toEqual(matchQuote(quote, sources));
    }
    expect(index.match("Payment is due within thirty (30) days", "S1")?.sourceId).toBe("S2");
  });
});

describe("windowAround", () => {
  const text = "abcdefghij".repeat(100);

  it("takes the default radius either side of the span", () => {
    expect(DEFAULT_WINDOW_CHARS).toBe(240);
    const window = windowAround(text, 500, 510);
    expect(window).toHaveLength(10 + 2 * 240);
    expect(window).toBe(text.slice(260, 750));
  });

  it("takes an explicit radius", () => {
    expect(windowAround(text, 500, 510, 5)).toBe(text.slice(495, 515));
  });

  it("clamps at both ends of the text", () => {
    expect(windowAround(text, 10, 20, 50)).toBe(text.slice(0, 70));
    expect(windowAround(text, 980, 995, 50)).toBe(text.slice(930));
  });

  it("does not cut a surrogate pair in half", () => {
    const emoji = "a\u{1F600}b\u{1F600}c\u{1F600}d";
    const window = windowAround(emoji, 4, 5, 2);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(window).not.toMatch(lone);
  });
});
