/**
 * Meeting mode: the date reading behind `dateSaid`, on a short text and on a transcript long enough to be
 * read through the prepared path.
 */
import { describe, expect, it } from "vitest";
import { findDateTimeMentions } from "../harness/judges";
import { untracedDates } from "./said-dates";
import { MONTH_WORDS } from "./transcript-index";

describe("MONTH_WORDS", () => {
  it("lists only words the judges' date reader takes for a month", () => {
    for (const word of MONTH_WORDS) {
      const name = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
      const [mention] = findDateTimeMentions(`1 ${name}`);
      expect(mention?.kind, name).toBe("date");
      expect(mention?.month, name).not.toBeNull();
    }
  });
});

const PADDING = "Kita bahas anggaran dan jadwal dengan teliti sebelum lanjut ke agenda berikutnya. ".repeat(80);

/** A transcript too long to be read as it is, with `body` somewhere inside it. */
function lengthened(body: string): string {
  const text = `${PADDING}\n${body}\n${PADDING}`;
  expect(text.length).toBeGreaterThan(5000);
  return text;
}

type Case = { name: string; claim: string; transcript: string; untraced: string[] };

const CASES: readonly Case[] = [
  { name: "the same date", claim: "14 March", transcript: "Dewi: we ship on 14 March.", untraced: [] },
  { name: "another month", claim: "14 June", transcript: "Dewi: we ship on 14 March.", untraced: ["14 June"] },
  {
    name: "a day that is only part of a longer one",
    claim: "1 Agustus 2026",
    transcript: "Rina: berakhir 31 Agustus 2026, dan ada 1 vendor baru.",
    untraced: ["1 Agustus 2026"],
  },
  {
    name: "a date split across the sentence",
    claim: "14 Agustus 2026",
    transcript: "Rina: tenggatnya tanggal 14, bulan Agustus, tahun 2026.",
    untraced: [],
  },
  {
    name: "a clock time in the other form",
    claim: "15:30",
    transcript: "Dewi: the call is at 3:30 pm.",
    untraced: [],
  },
  { name: "a clock time never said", claim: "16:30", transcript: "Dewi: the call is at 3:30 pm.", untraced: ["16:30"] },
  {
    name: "two dates, one said",
    claim: "14 March and 21 March",
    transcript: "Dewi: ship on 14 March.",
    untraced: ["21 March"],
  },
  {
    name: "a numeric date",
    claim: "14/03/2026",
    transcript: "Dewi: kita rilis 14 Maret 2026.",
    untraced: [],
  },
  { name: "no date in the claim", claim: "next week", transcript: "Dewi: ship on 14 March.", untraced: [] },
];

describe("untracedDates", () => {
  it.each(CASES)("reads $name the same on a short text and on a long transcript", (item) => {
    const texts = (transcript: string) => untracedDates(item.claim, transcript, "id").map((mention) => mention.text);
    expect(texts(item.transcript)).toEqual(item.untraced);
    expect(texts(lengthened(item.transcript))).toEqual(item.untraced);
  });

  it("still finds a date in the middle of a very long line", () => {
    const oneLine = `${"Kita bahas anggaran dengan teliti. ".repeat(300)}Rilis dijadwalkan 14 Maret.${" Selesai.".repeat(300)}`;
    expect(oneLine.includes("\n")).toBe(false);
    expect(untracedDates("14 Maret", oneLine, "id")).toEqual([]);
    expect(untracedDates("15 Maret", oneLine, "id").map((mention) => mention.text)).toEqual(["15 Maret"]);
  });

  it("does not lose a date that falls on the edge of a window of a very long line", () => {
    for (const offset of [1900, 1936, 1990, 2000, 3800]) {
      const line = `${"x ".repeat(Math.floor(offset / 2))}Rilis 14 Maret 2026 ok ${"y ".repeat(500)}`;
      expect(untracedDates("14 Maret 2026", line, "id"), `offset ${offset}`).toEqual([]);
    }
  });

  it("stays fast on a 600 000 character transcript that is nothing but dates", () => {
    const line = "Dewi: kita rilis pada 14 Maret, lalu rapat lagi 20 Maret pukul 15.30 dan 3 pm, anggaran 1,5 miliar.";
    const transcript = Array.from({ length: Math.ceil(600_000 / (line.length + 1)) }, () => line).join("\n");
    const started = performance.now();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(untracedDates("14 Maret and 21 April", transcript, "id").map((mention) => mention.text)).toEqual([
        "21 April",
      ]);
    }
    expect(performance.now() - started).toBeLessThan(4000);
  });

  it("stays fast on a 600 000 character transcript with no line breaks", () => {
    const transcript = "Dewi: kita rilis pada 14 Maret, lalu rapat lagi 20 Maret pukul 15.30. ".repeat(8500);
    const started = performance.now();
    expect(untracedDates("14 Maret", transcript, "id")).toEqual([]);
    expect(untracedDates("1 Maret", transcript, "id").map((mention) => mention.text)).toEqual(["1 Maret"]);
    expect(performance.now() - started).toBeLessThan(4000);
  });
});
