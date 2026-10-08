import { describe, expect, it } from "vitest";
import * as judges from "./index";

/**
 * The public surface of `@agentforge/core/judges`. Lanes L1, L3a and L4a build against this list, so a
 * name added, removed or renamed here is an interface change and must be a deliberate one.
 */
const SURFACE = [
  "DEFAULT_WINDOW_CHARS",
  "ELIDED_GAP_MAX_CHARS",
  "ELIDED_PART_MIN_CHARS",
  "QUOTE_MIN_CHARS",
  "amountsIn",
  "coverageGaps",
  "createQuoteIndex",
  "datesTraced",
  "durationMonths",
  "extractNumbers",
  "failingIds",
  "findConflicts",
  "findDateTimeMentions",
  "hasCoverageGaps",
  "isFreeNumber",
  "isoDateOf",
  "isoDatesOf",
  "judgeCheck",
  "maskClauseReferences",
  "maskDateTimes",
  "matchQuote",
  "matchesAllowed",
  "normaliseForMatch",
  "numbersTraced",
  "outcomeOf",
  "outcomesById",
  "sameDate",
  "scopeHits",
  "summarizeVerdicts",
  "windowAround",
];

describe("the judges surface", () => {
  it("exports exactly the frozen names", () => {
    expect(Object.keys(judges).sort()).toEqual([...SURFACE].sort());
  });

  it("is functions and constants only, with no model call to make", () => {
    for (const [name, value] of Object.entries(judges)) {
      expect(["function", "number"], name).toContain(typeof value);
    }
  });
});

describe("the judges together on one model answer", () => {
  const SOURCES = [
    {
      id: "S1",
      text: [
        "<!-- page 1 -->",
        "PERJANJIAN KERJA SAMA",
        "Perjanjian ini berlaku sejak 14 Agustus 2026 untuk jangka waktu 24 (dua puluh empat) bulan.",
        "Pembayaran sebesar Rp 1.500.000.000 dilakukan paling lambat 30 hari setelah faktur.",
      ].join("\n"),
    },
  ];
  const text = SOURCES.map((source) => source.text).join("\n");

  it("verifies a fact whose quote, date, amount and term all trace to the document", () => {
    const quote = "berlaku sejak 14 Agustus 2026 untuk jangka waktu 24 (dua puluh empat) bulan";
    expect(judges.matchQuote(quote, SOURCES)?.mode).toBe("exact");
    expect(judges.datesTraced("14 Agustus 2026", quote, "id").traced).toBe(true);
    expect(judges.durationMonths("24 bulan")).toBe(judges.durationMonths(quote));
    expect(judges.numbersTraced("Rp 1,5 miliar", text, "id").traced).toBe(true);
    expect(judges.scopeHits("Perjanjian berlaku 24 bulan.", SOURCES)).toEqual([]);
  });

  it("catches a fact that invents a date, an amount, advice and a statute", () => {
    expect(judges.matchQuote("berlaku sejak 15 Agustus 2026 untuk jangka waktu", SOURCES)).toBeNull();
    expect(judges.datesTraced("15 Agustus 2026", text, "id").traced).toBe(false);
    expect(judges.numbersTraced("Rp 1,6 miliar", text, "id").traced).toBe(false);
    expect(
      judges.scopeHits("Sebaiknya Anda menolak, menurut UU No. 8 Tahun 1999.", SOURCES).map((hit) => hit.kind),
    ).toEqual(["advice", "citation"]);
  });
});
