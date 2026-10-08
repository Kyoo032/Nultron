import { describe, expect, it } from "vitest";
import {
  datesTraced,
  durationMonths,
  findDateTimeMentions,
  isoDateOf,
  isoDatesOf,
  maskDateTimes,
  sameDate,
} from "./dates";

describe("findDateTimeMentions (ported from host minutes-checks)", () => {
  const read = (text: string) =>
    findDateTimeMentions(text).map(({ kind, text: quote, numbers, month, year }) => ({
      kind,
      quote,
      numbers,
      month,
      year,
    }));

  it("reads a day and a month in either order, with an optional year", () => {
    expect(read("Ship on 14 March 2026, review March 20th.")).toEqual([
      { kind: "date", quote: "14 March 2026", numbers: [14, 2026], month: 3, year: null },
      { kind: "date", quote: "March 20th", numbers: [20], month: 3, year: null },
    ]);
  });

  it("reads Indonesian months", () => {
    expect(read("Tenggat 5 Agustus dan Mei 3")).toEqual([
      { kind: "date", quote: "5 Agustus", numbers: [5], month: 8, year: null },
      { kind: "date", quote: "Mei 3", numbers: [3], month: 5, year: null },
    ]);
  });

  it("reads numeric dates", () => {
    expect(read("on 2026-03-14 or 14/03/2026")).toEqual([
      { kind: "numeric-date", quote: "2026-03-14", numbers: [3, 14], month: null, year: 2026 },
      { kind: "numeric-date", quote: "14/03/2026", numbers: [14, 3], month: null, year: 2026 },
    ]);
  });

  it("reads clock times with a colon or an am/pm, and the Indonesian pukul/jam", () => {
    expect(read("at 3:30 pm, again at 15:00, at 9am, jam 15.30 and pukul 9")).toEqual([
      { kind: "clock", quote: "jam 15.30", numbers: [15, 30], month: null, year: null },
      { kind: "clock", quote: "pukul 9", numbers: [9, 0], month: null, year: null },
      { kind: "clock", quote: "3:30 pm", numbers: [3, 30], month: null, year: null },
      { kind: "clock", quote: "15:00", numbers: [15, 0], month: null, year: null },
      { kind: "clock", quote: "9am", numbers: [9, 0], month: null, year: null },
    ]);
  });

  it("does not read the verbs may and march, decimals, plain numbers, weekdays or relative dates", () => {
    expect(
      read("we may 5 times march 3 steps; budget 3.5 million, 12 people, ratio 3:1, by Friday, next week, in Q3 2026"),
    ).toEqual([]);
  });

  it("does not read a day out of a clock time that follows a month", () => {
    expect(read("14 March 15:00")).toEqual([
      { kind: "date", quote: "14 March", numbers: [14], month: 3, year: null },
      { kind: "clock", quote: "15:00", numbers: [15, 0], month: null, year: null },
    ]);
  });
});

describe("findDateTimeMentions: the contract shapes in the plan", () => {
  it("reads 14 Agustus 2026 and pukul 15.00", () => {
    const found = findDateTimeMentions("Rapat pada 14 Agustus 2026 pukul 15.00 di kantor.");
    expect(found.map((mention) => [mention.kind, mention.text])).toEqual([
      ["date", "14 Agustus 2026"],
      ["clock", "pukul 15.00"],
    ]);
  });

  it("reads an ISO date and an ISO timestamp's date", () => {
    expect(findDateTimeMentions("effective 2026-08-14").map((mention) => mention.text)).toEqual(["2026-08-14"]);
  });
});

describe("maskDateTimes", () => {
  it("blanks every date and time at equal length and leaves the rest", () => {
    const text = "Pay Rp 5.000 by 14 Agustus 2026 pukul 15.00, not later.";
    const masked = maskDateTimes(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).toBe(`Pay Rp 5.000 by ${" ".repeat(15)} ${" ".repeat(11)}, not later.`);
  });

  it("returns text with no dates untouched", () => {
    expect(maskDateTimes("net 30 days, 12 people")).toBe("net 30 days, 12 people");
  });
});

describe("isoDateOf", () => {
  it("resolves a full date in either language", () => {
    expect(isoDateOf("14 Agustus 2026", "id")).toBe("2026-08-14");
    expect(isoDateOf("March 20th, 2026", "en")).toBe("2026-03-20");
    expect(isoDateOf("1 Sept 2026", "en")).toBe("2026-09-01");
  });

  it("resolves ISO and day-first numeric dates", () => {
    expect(isoDateOf("2026-03-14", "en")).toBe("2026-03-14");
    expect(isoDateOf("14/03/2026", "en")).toBe("2026-03-14");
    expect(isoDateOf("03/14/2026", "en")).toBe("2026-03-14");
  });

  it("reads an ambiguous numeric date day-first in id and month-first in en", () => {
    expect(isoDateOf("03/04/2026", "id")).toBe("2026-04-03");
    expect(isoDateOf("03/04/2026", "en")).toBe("2026-03-04");
  });

  it("reads a two-digit year as 20xx", () => {
    expect(isoDateOf("14/03/26", "id")).toBe("2026-03-14");
  });

  it("is null without a year, without a date, or for a day the month does not have", () => {
    expect(isoDateOf("March 20th", "en")).toBeNull();
    expect(isoDateOf("no date here", "en")).toBeNull();
    expect(isoDateOf("31 Februari 2026", "id")).toBeNull();
    expect(isoDateOf("29 Februari 2025", "id")).toBeNull();
    expect(isoDateOf("29 Februari 2028", "id")).toBe("2028-02-29");
  });

  it("takes the first dated mention", () => {
    expect(isoDateOf("from 1 Januari 2026 to 31 Desember 2026", "id")).toBe("2026-01-01");
  });
});

describe("isoDatesOf", () => {
  it("lists every reading of an ambiguous numeric date", () => {
    expect([...isoDatesOf("03/04/2026")].sort()).toEqual(["2026-03-04", "2026-04-03"]);
  });

  it("lists one date for an unambiguous one and none for an unresolvable one", () => {
    expect(isoDatesOf("14 Agustus 2026")).toEqual(["2026-08-14"]);
    expect(isoDatesOf("14 Agustus")).toEqual([]);
  });
});

describe("sameDate", () => {
  it("is true for the same date written differently", () => {
    expect(sameDate("14 Agustus 2026", "2026-08-14")).toBe(true);
    expect(sameDate("14 August 2026", "14/08/2026")).toBe(true);
    expect(sameDate("March 20th 2026", "20 Maret 2026")).toBe(true);
  });

  it("is true when one side has no year and day and month agree", () => {
    expect(sameDate("14 Agustus", "14 Agustus 2026")).toBe(true);
  });

  it("is false for a different day, month or year", () => {
    expect(sameDate("14 Agustus 2026", "15 Agustus 2026")).toBe(false);
    expect(sameDate("14 Agustus 2026", "14 September 2026")).toBe(false);
    expect(sameDate("14 Agustus 2026", "14 Agustus 2027")).toBe(false);
  });

  it("is false when either side holds no date", () => {
    expect(sameDate("soon", "14 Agustus 2026")).toBe(false);
  });
});

describe("datesTraced", () => {
  it("traces a date the evidence states, in any written form", () => {
    expect(datesTraced("14 Agustus 2026", "Perjanjian berlaku sejak tanggal 14 Agustus 2026.", "id").traced).toBe(true);
    expect(datesTraced("14 Agustus 2026", "effective 2026-08-14", "id").traced).toBe(true);
    expect(datesTraced("14 August 2026", "berlaku 14/08/2026", "en").traced).toBe(true);
    expect(datesTraced("2026-08-14", "14 Agustus 2026", "id").traced).toBe(true);
  });

  it("traces a date with no year to one with a year", () => {
    expect(datesTraced("14 March", "due 14 March 2026", "en").traced).toBe(true);
  });

  it("does not trace a different day, month or year", () => {
    const result = datesTraced("15 Agustus 2026", "berlaku 14 Agustus 2026", "id");
    expect(result.traced).toBe(false);
    expect(result.untraced.map((mention) => mention.text)).toEqual(["15 Agustus 2026"]);
    expect(datesTraced("14 March 2027", "due 14 March 2026", "en").traced).toBe(false);
    expect(datesTraced("14 April 2026", "due 14 March 2026", "en").traced).toBe(false);
  });

  it("is not fooled by a date that only ends the same way (1 and 31)", () => {
    expect(datesTraced("1 Agustus 2026", "berakhir 31 Agustus 2026", "id").traced).toBe(false);
  });

  it("reads an ambiguous numeric claim by the run locale and the evidence either way", () => {
    expect(datesTraced("03/04/2026", "on 3 April 2026", "id").traced).toBe(true);
    expect(datesTraced("03/04/2026", "on 4 March 2026", "id").traced).toBe(false);
    expect(datesTraced("03/04/2026", "on 4 March 2026", "en").traced).toBe(true);
  });

  it("does not let a day and a month from different places stand for one date unless asked to be loose", () => {
    const evidence = "starts 1 September 2026 and ends 31 Agustus 2026";
    expect(datesTraced("1 Agustus 2026", evidence, "id").traced).toBe(false);
    expect(datesTraced("1 Agustus 2026", evidence, "id", { loose: true }).traced).toBe(true);
  });

  it("lets a loose trace read a spoken date whose parts are apart", () => {
    expect(datesTraced("14 Maret", "tanggal 14, bulan Maret ya", "id", { loose: true }).traced).toBe(true);
    expect(datesTraced("14 Maret", "tanggal 14, bulan Mei ya", "id", { loose: true }).traced).toBe(false);
  });

  it("traces a clock time across 12- and 24-hour writing", () => {
    expect(datesTraced("pukul 15.00", "kita mulai 3 PM", "id").traced).toBe(true);
    expect(datesTraced("3:30 pm", "start at 15:30", "en").traced).toBe(true);
    expect(datesTraced("09:30", "jam 9.30", "id").traced).toBe(true);
  });

  it("tells am from pm when the claim says which", () => {
    expect(datesTraced("3:00 am", "kita mulai 3 PM", "id").traced).toBe(false);
    expect(datesTraced("3 pm", "start at 15:00", "en").traced).toBe(true);
  });

  it("does not trace a different hour or minute", () => {
    expect(datesTraced("16:00", "start at 15:00", "en").traced).toBe(false);
    expect(datesTraced("15:30", "start at 15:00", "en").traced).toBe(false);
  });

  it("is traced when the claim holds no date or time", () => {
    expect(datesTraced("the Supplier shall deliver", "", "en")).toEqual({ traced: true, untraced: [] });
  });

  it("reports every untraced mention, in order", () => {
    const result = datesTraced("from 1 Januari 2026 until 31 Desember 2026 at 09:00", "from 1 Januari 2026", "id");
    expect(result.untraced.map((mention) => mention.text)).toEqual(["31 Desember 2026", "09:00"]);
  });
});

describe("durationMonths", () => {
  it("reads months, years and quarters", () => {
    expect(durationMonths("a term of 12 months")).toBe(12);
    expect(durationMonths("jangka waktu 18 bulan")).toBe(18);
    expect(durationMonths("for 2 years")).toBe(24);
    expect(durationMonths("selama 3 tahun")).toBe(36);
    expect(durationMonths("1.5 years")).toBe(18);
    expect(durationMonths("1,5 tahun")).toBe(18);
    expect(durationMonths("2 quarters")).toBe(6);
  });

  it("reads the digits when the number is also written out", () => {
    expect(durationMonths("twenty-four (24) months")).toBe(24);
    expect(durationMonths("24 (dua puluh empat) bulan")).toBe(24);
    expect(durationMonths("12 (dua belas) bulan sejak tanggal")).toBe(12);
  });

  it("reads a small number written out", () => {
    expect(durationMonths("one year")).toBe(12);
    expect(durationMonths("satu tahun")).toBe(12);
    expect(durationMonths("dua belas bulan")).toBe(12);
    expect(durationMonths("setahun")).toBe(12);
    expect(durationMonths("six months")).toBe(6);
  });

  it("takes the first duration", () => {
    expect(durationMonths("6 bulan atau 1 tahun")).toBe(6);
  });

  it("is null for days, weeks, or text with no duration", () => {
    expect(durationMonths("within 90 days")).toBeNull();
    expect(durationMonths("2 weeks")).toBeNull();
    expect(durationMonths("no duration here")).toBeNull();
    expect(durationMonths("")).toBeNull();
  });

  it("does not read a month name or a monthly price as a duration", () => {
    expect(durationMonths("due in March 2026")).toBeNull();
    expect(durationMonths("USD 500 monthly")).toBeNull();
  });
});
