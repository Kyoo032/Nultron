/**
 * Meeting mode: what the guard counts as "said". `dateSaid` and `figureSaid` used to be substring
 * matches, so "1 Agustus 2026" was found inside "31 Agustus 2026" and "5" inside "1.5 percent".
 */
import { describe, expect, it } from "vitest";
import { dateSaid, FIGURE_NOT_SAID, figureSaid, guardMinutesGrounding, untracedDates } from "./ground";
import { meetingMinutesSchema } from "./minutes";

describe("dateSaid", () => {
  it("does not find 1 Agustus 2026 inside 31 Agustus 2026", () => {
    expect(dateSaid("1 Agustus 2026", "berakhir 31 Agustus 2026")).toBe(false);
    expect(dateSaid("1 Agustus 2026", "berakhir 31 Agustus 2026", "id")).toBe(false);
  });

  it("does not find 1 August inside 11 August either", () => {
    expect(dateSaid("1 August", "the review is on 11 August")).toBe(false);
  });

  it("finds the same date written another way", () => {
    expect(dateSaid("14 August 2026", "we ship on the 14th of August 2026")).toBe(true);
    expect(dateSaid("14 Agustus", "tenggatnya 14 Agustus 2026")).toBe(true);
    expect(dateSaid("2026-08-14", "tenggatnya 14 Agustus 2026")).toBe(true);
  });

  it("finds a date the speaker split across the sentence", () => {
    expect(dateSaid("14 Agustus 2026", "tanggal 14, bulan Agustus, tahun 2026")).toBe(true);
    expect(dateSaid("14 August", "August the 14th works")).toBe(true);
  });

  it("does not let a stray number beside the right date vouch for a wrong day", () => {
    expect(dateSaid("1 Agustus 2026", "berakhir 31 Agustus 2026, dan ada 1 vendor baru")).toBe(false);
    expect(dateSaid("31 Agustus 2026", "berakhir 31 Agustus 2026, dan ada 1 vendor baru")).toBe(true);
  });

  it("does not count a day that only appears far from the month", () => {
    const transcript = `Ada 2 orang yang hadir. ${"Kita bahas anggaran dulu. ".repeat(6)}Tenggat 14 Agustus.`;
    expect(dateSaid("2 Agustus", transcript)).toBe(false);
    expect(dateSaid("14 Agustus", transcript)).toBe(true);
  });

  it("wants the year when the claim has one", () => {
    expect(dateSaid("14 Agustus 2027", "tenggatnya 14 Agustus 2026")).toBe(false);
  });

  it("reads a clock time", () => {
    expect(dateSaid("pukul 15.30", "rapat dimulai pukul 15.30")).toBe(true);
    expect(dateSaid("15:30", "the call is at 3:30 pm")).toBe(true);
    expect(dateSaid("16:30", "the call is at 3:30 pm")).toBe(false);
  });

  it("asks for every date in a claim, not the first", () => {
    expect(dateSaid("14 March and 21 March", "ship on 14 March")).toBe(false);
    expect(dateSaid("14 March and 21 March", "ship on 14 March, review 21 March")).toBe(true);
  });

  it("keeps a deadline that is not a calendar date to the words the transcript used", () => {
    expect(dateSaid("Friday", "We ship on Friday.")).toBe(true);
    expect(dateSaid("this week", "I will finish this weekend")).toBe(false);
    expect(dateSaid("next year", "We ship on Friday.")).toBe(false);
  });

  it("treats an empty claim as nothing to prove", () => {
    expect(dateSaid("", "anything")).toBe(true);
    expect(dateSaid("   ", "")).toBe(true);
  });
});

describe("untracedDates", () => {
  it("lists the dates the transcript does not say, and none when all were said", () => {
    expect(untracedDates("14 March and 21 March", "ship on 14 March").map((mention) => mention.text)).toEqual([
      "21 March",
    ]);
    expect(untracedDates("14 March", "ship on 14 March")).toEqual([]);
    expect(untracedDates("no date here", "ship on 14 March")).toEqual([]);
  });
});

describe("figureSaid", () => {
  it("does not find 5 inside 1.5 percent", () => {
    expect(figureSaid("5", "the error budget is 1.5 percent")).toBe(false);
    expect(figureSaid("5", "the error budget is 1,5 percent")).toBe(false);
  });

  it("does not find 500 inside 1.500 or 5 inside 5,000", () => {
    expect(figureSaid("500", "ada 1.500 orang")).toBe(false);
    expect(figureSaid("5", "the contract is worth $5,000")).toBe(false);
  });

  it("still finds a figure that is its own number, even at the end of a sentence or a list", () => {
    expect(figureSaid("5", "we need 5. Then more.")).toBe(true);
    expect(figureSaid("5", "versions 3, 4, 5 are out")).toBe(true);
    expect(figureSaid("5", "the target is 5%")).toBe(true);
  });

  it("keeps the old behaviours", () => {
    expect(figureSaid("12", "the total is 120")).toBe(false);
    expect(figureSaid("2.1", "at 2,1 percent")).toBe(true);
    expect(figureSaid("2,1", "at 2.1 percent")).toBe(true);
  });

  it("reads the same amount written with a magnitude word", () => {
    expect(figureSaid("1.500.000.000", "anggarannya Rp 1,5 miliar", "id")).toBe(true);
    expect(figureSaid("2.000.000.000", "anggarannya Rp 1,5 miliar", "id")).toBe(false);
  });

  it("reads a magnitude word the same way on a long transcript", () => {
    const padding = "Kita bahas jadwal dengan teliti sebelum lanjut ke agenda berikutnya. ".repeat(80);
    const long = `${padding}\nRina: anggaran Rp 1,5 miliar sudah disetujui.\n${padding}`;
    expect(long.length).toBeGreaterThan(5000);
    expect(figureSaid("1.500.000.000", long, "id")).toBe(true);
    expect(figureSaid("2.000.000.000", long, "id")).toBe(false);
    expect(figureSaid("5", `${padding}\nRina: galat 1.5 persen.\n${padding}`)).toBe(false);
  });

  it("stays fast when a 600 000 character transcript of nothing but dates is asked about many amounts", () => {
    const line = "Dewi: kita rilis pada 14 Maret, lalu rapat lagi 20 Maret pukul 15.30, anggaran Rp 1,5 miliar.";
    const transcript = Array.from({ length: Math.ceil(600_000 / (line.length + 1)) }, () => line).join("\n");
    const started = performance.now();
    for (let amount = 1; amount <= 20; amount += 1) {
      expect(figureSaid(`${amount}.234.567.890`, transcript, "id")).toBe(false);
    }
    expect(figureSaid("1.500.000.000", transcript, "id")).toBe(true);
    expect(performance.now() - started).toBeLessThan(4000);
  });
});

describe("guardMinutesGrounding", () => {
  function sheet(overrides: Record<string, unknown> = {}) {
    return meetingMinutesSchema.parse({
      title: "Perpanjangan kontrak",
      summary: "Kontrak berakhir.",
      ...overrides,
    });
  }

  it("clears a due date that only matches a longer date, and keeps the real one", () => {
    const transcript = "Rina: kontrak berakhir 31 Agustus 2026, jadi perpanjangan harus selesai 14 Agustus 2026.";
    const result = guardMinutesGrounding(
      sheet({
        heldOn: "1 Agustus 2026",
        actionItems: [
          { task: "Perpanjang kontrak", owner: "Rina", due: "1 Agustus 2026", firstStep: "" },
          { task: "Kirim draf", owner: "Rina", due: "14 Agustus 2026", firstStep: "" },
        ],
      }),
      transcript,
      "id",
    );
    expect(result.minutes.heldOn).toBe("");
    expect(result.minutes.actionItems.map((item) => item.due)).toEqual(["", "14 Agustus 2026"]);
    expect(result.clearedDates).toBe(2);
  });

  it("replaces a figure that only matches part of a bigger number", () => {
    const result = guardMinutesGrounding(
      sheet({ summary: "Galat turun menjadi 5 persen." }),
      "Rina: galat turun menjadi 1.5 persen minggu ini.",
      "id",
    );
    expect(result.minutes.summary).toContain(FIGURE_NOT_SAID);
    expect(result.replacedFigures).toBe(1);
  });

  it("keeps an amount the transcript said with a magnitude word", () => {
    const result = guardMinutesGrounding(
      sheet({ summary: "Anggaran Rp 1.500.000.000 disetujui." }),
      "Rina: anggaran Rp 1,5 miliar sudah disetujui.",
      "id",
    );
    expect(result.minutes.summary).toContain("1.500.000.000");
    expect(result.replacedFigures).toBe(0);
  });
});
