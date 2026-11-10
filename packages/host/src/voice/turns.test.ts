/**
 * The turn-taking rules: when a person has finished, whether speech over the agent is an interruption, and how
 * much of a reply they heard. All three are pure, so every case is a table row. The rows include the text of
 * each synthetic fixture and the rough hearings the speech model gave for the short ones ("Iya" came back as
 * "E ya!", "Stop, tunggu dulu." as "Tunggu dulu.", "Saya mau pesan yang" as "Saya mau bersenyan.").
 */
import { describe, expect, it } from "vitest";
import {
  type BargeInVerdict,
  judgeBargeIn,
  judgeTurnEnd,
  TURN_TIMING,
  trimToHeard,
  type TurnEndVerdict,
  type VoiceLocale,
} from "./turns";

const LONG_TEXT =
  "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan jadwal, bisa bantu saya cek apa saja yang perlu diubah?";

type TurnRow = readonly [transcript: string, locale: VoiceLocale, verdict: TurnEndVerdict];

const TURN_END_ROWS: readonly TurnRow[] = [
  // The fixtures' own sentences, as the talker's tool argument gives them (accurate).
  ["Berapa total penjualan saya bulan lalu?", "id", "finished"],
  ["Halo, apa kabar hari ini?", "id", "finished"],
  ["Tolong buatkan deck dari riset kemarin.", "id", "finished"],
  ["Saya mau pesan yang", "id", "wait"],
  ["Iya", "id", "finished"],
  ["Stop, tunggu dulu.", "id", "finished"],
  [LONG_TEXT, "id", "finished"],
  // The long sentence cut where a person could stop in the middle of it.
  ["Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi", "id", "wait"],
  [
    "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan",
    "id",
    "wait",
  ],
  [
    "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi di bagian anggaran dan jadwal, bisa bantu saya cek apa saja yang",
    "id",
    "wait",
  ],
  ["Jadi begini,", "id", "wait"],
  ["Ceritanya begini", "id", "wait"],
  ["Kenapa jadi begini?", "id", "finished"],
  ["Jadi begini, kemarin saya sudah kirim laporan ke", "id", "wait"],
  ["Jadi begini, kemarin saya sudah kirim laporan ke klien,", "id", "finished"], // the words cannot see a clause pause
  // What the speech model heard of the short ones: the words cannot be trusted, so the rules stay calm.
  ["E ya!", "id", "finished"],
  ["Tunggu dulu.", "id", "finished"],
  ["Saya mau bersenyan.", "id", "finished"],
  ["Saya mau pesan yang.", "id", "wait"],
  // Empty and only punctuation.
  ["", "id", "wait"],
  ["   ", "en", "wait"],
  ["...", "id", "wait"],
  ["?", "id", "wait"],
  ["—", "en", "wait"],
  // Hesitations and trailing-off phrases at the end.
  ["Eh", "id", "wait"],
  ["Eh...", "id", "wait"],
  ["Hmm", "id", "wait"],
  ["Hmmm.", "en", "wait"],
  ["Anu", "id", "wait"],
  ["Anu, apa ya", "id", "wait"],
  ["Itu, apa ya?", "id", "wait"],
  ["Gimana ya", "id", "wait"],
  ["Gimana ya?", "id", "wait"],
  ["Siapa ya namanya", "id", "wait"],
  ["Saya mau ke, ehm", "id", "wait"],
  ["Let me think, um", "en", "wait"],
  ["Uh", "en", "wait"],
  ["Uhh...", "en", "wait"],
  ["Er", "en", "wait"],
  ["Emm", "id", "wait"],
  // Indonesian words that need more.
  ["Saya mau beli dan", "id", "wait"],
  ["Kopi atau", "id", "wait"],
  ["Bisa, tapi", "id", "wait"],
  ["Terus", "id", "wait"],
  ["Jadi", "id", "wait"],
  ["Saya telat karena", "id", "wait"],
  ["Kalau", "id", "wait"],
  ["Ini untuk", "id", "wait"],
  ["Saya bicara dengan", "id", "wait"],
  ["Saya pergi ke", "id", "wait"],
  ["Dia datang dari", "id", "wait"],
  ["Saya pergi sama", "id", "wait"],
  ["Itu yang", "id", "wait"],
  ["Saya mau itu yang", "id", "wait"],
  ["Rapatnya di", "id", "wait"],
  // English words that need more.
  ["Please send the", "en", "wait"],
  ["I want to", "en", "wait"],
  ["Can you check the report and", "en", "wait"],
  ["That is because", "en", "wait"],
  ["I would like", "en", "wait"],
  ["Coffee or", "en", "wait"],
  ["Tea with", "en", "wait"],
  ["Thanks for", "en", "wait"],
  ["Looks fine but", "en", "wait"],
  ["Do it so", "en", "wait"],
  ["I will send a", "en", "wait"],
  ["It is one of", "en", "wait"],
  // The same words, whatever the locale says.
  ["Saya mau beli dan", "en", "wait"],
  ["Please send the", "id", "wait"],
  ["Kopi atau", "en", "wait"],
  // Trailing off in writing.
  ["Saya mau pesan yang...", "id", "wait"],
  ["Saya mau pesan kopi…", "id", "wait"],
  ["Saya mau pesan kopi ...", "id", "wait"],
  ["Saya mau pesan -", "id", "wait"],
  ["Saya mau pesan —", "id", "wait"],
  ["I was going to–", "en", "wait"],
  ['"Saya mau pesan yang"', "id", "wait"],
  // Case and punctuation are noise.
  ["SAYA MAU PESAN YANG", "id", "wait"],
  ["saya mau pesan yang!", "id", "wait"],
  ["Saya mau pesan YANG,", "id", "wait"],
  ["Kopi, ATAU", "id", "wait"],
  // A question or a complete request is finished, even when short.
  ["Ada kopi susu?", "id", "finished"],
  ["Stop.", "id", "finished"],
  ["Stop.", "en", "finished"],
  ["Ulangi.", "id", "finished"],
  ["Wait.", "en", "finished"],
  ["Terima kasih", "id", "finished"],
  ["Terus?", "id", "finished"],
  ["Jadi?", "id", "finished"],
  ["Dan?", "id", "finished"],
  ["Is that for?", "en", "finished"],
  ["What time is it?", "en", "finished"],
  ["Send it now", "en", "finished"],
  ["Thanks.", "en", "finished"],
  ["Yes please", "en", "finished"],
  ["Tolong kirim ke Andi", "id", "finished"],
  ["Berapa harga ini apa", "id", "finished"],
  ["Saya mau pesan kopi,", "id", "finished"],
  ["Hmm, oke", "id", "finished"],
  ["Uh huh", "en", "finished"],
  ["Mm-hm", "en", "finished"],
  ["Mhm.", "en", "finished"],
  ["Harganya lima ribu,-", "id", "finished"],
  ["Rp5.000,-", "id", "finished"],
  ["Tidak apa-apa", "id", "finished"],
  // "sama-sama" is "you are welcome", not a dangling "sama".
  ["Sama-sama", "id", "finished"],
  ["Sama sama.", "id", "finished"],
  // "so" finishes a complete answer.
  ["I think so.", "en", "finished"],
  ["I hope so", "en", "finished"],
  ["If so.", "en", "finished"],
  ["About five or so", "en", "finished"],
  // A name at the end, and a label.
  ["I talked to Dan", "en", "finished"],
  ["I talked to Dan", "id", "finished"],
  ["Saya bicara dengan Dan.", "id", "finished"],
  ["Tolong telepon Di", "id", "finished"],
  ["Dan", "en", "finished"],
  ["Dan.", "en", "finished"],
  ["Dan", "id", "wait"],
  ["saya mau makan dan", "en", "wait"],
  ["Pilih opsi A", "id", "finished"],
  ["Plan A.", "en", "finished"],
  ["Paket A", "id", "finished"],
  ["I want a", "en", "wait"],
  ["Saya mau a", "id", "wait"],
];

describe("judgeTurnEnd", () => {
  it("has at least 60 rows, in both languages", () => {
    expect(TURN_END_ROWS.length).toBeGreaterThanOrEqual(60);
    expect(TURN_END_ROWS.some(([, locale]) => locale === "en")).toBe(true);
    expect(TURN_END_ROWS.some(([, locale]) => locale === "id")).toBe(true);
  });

  it.each(TURN_END_ROWS)("%j (%s) is %s", (transcript, locale, verdict) => {
    expect(judgeTurnEnd(transcript, locale)).toBe(verdict);
  });

  it("gives the same answer for the same words whatever the case and punctuation, except where locale breaks a tie", () => {
    const sentences = [
      "Saya mau pesan yang",
      "Kopi atau",
      "Please send the",
      "Ada kopi susu",
      "Eh",
      "Hmm",
      "Terima kasih",
    ];
    for (const sentence of sentences) {
      const plain = judgeTurnEnd(sentence, "id");
      for (const variant of [
        sentence.toUpperCase(),
        sentence.toLowerCase(),
        `${sentence}.`,
        `${sentence},`,
        `${sentence}!`,
        ` ${sentence}  `,
        `"${sentence}"`,
      ]) {
        expect(judgeTurnEnd(variant, "id"), variant).toBe(plain);
      }
    }
  });

  it("answers the same in both locales for every row outside the Dan/Yang/Di tie", () => {
    for (const [transcript, , verdict] of TURN_END_ROWS) {
      if (/\b(?:dan|yang|di)\W*$/i.test(transcript) && /^\p{Lu}/u.test(transcript.trim().split(/\s+/).at(-1) ?? "")) {
        continue;
      }
      expect(judgeTurnEnd(transcript, "en"), transcript).toBe(verdict);
      expect(judgeTurnEnd(transcript, "id"), transcript).toBe(verdict);
    }
  });
});

type BargeRow = readonly [transcript: string | null, speechMs: number, verdict: BargeInVerdict];

const BARGE_IN_ROWS: readonly BargeRow[] = [
  // Listening noises and go-on words, in both languages.
  ["iya", 300, "backchannel"],
  ["Iya.", 300, "backchannel"],
  ["iyaa", 300, "backchannel"],
  ["Iyaaa!", 400, "backchannel"],
  ["ya", 200, "backchannel"],
  ["Ya.", 200, "backchannel"],
  ["E ya!", 500, "backchannel"], // what the speech model heard of "Iya"
  ["e ya", 500, "backchannel"],
  ["e iya", 500, "backchannel"],
  ["eya", 500, "backchannel"],
  ["he eh", 400, "backchannel"],
  ["He-eh", 400, "backchannel"],
  ["hmm", 500, "backchannel"],
  ["Hmmm", 600, "backchannel"],
  ["hmmm.", 600, "backchannel"],
  ["mm", 300, "backchannel"],
  ["Mm-hm", 500, "backchannel"],
  ["mhm", 400, "backchannel"],
  ["Mhm.", 400, "backchannel"],
  ["oke", 300, "backchannel"],
  ["Okee", 400, "backchannel"],
  ["okeee", 450, "backchannel"],
  ["ok", 250, "backchannel"],
  ["OK", 250, "backchannel"],
  ["okay", 350, "backchannel"],
  ["oh", 250, "backchannel"],
  ["Ooh", 350, "backchannel"],
  ["sip", 300, "backchannel"],
  ["Siip", 400, "backchannel"],
  ["baik", 300, "backchannel"],
  ["betul", 400, "backchannel"],
  ["benar", 400, "backchannel"],
  ["lanjut", 450, "backchannel"],
  ["terus", 350, "backchannel"],
  ["Terus terus", 600, "backchannel"],
  ["yes", 300, "backchannel"],
  ["yeah", 350, "backchannel"],
  ["yeaah", 450, "backchannel"],
  ["yep", 300, "backchannel"],
  ["right", 350, "backchannel"],
  ["uh huh", 450, "backchannel"],
  ["uh-huh", 450, "backchannel"],
  ["sure", 350, "backchannel"],
  ["go on", 400, "backchannel"],
  ["Go on!", 400, "backchannel"],
  ["got it", 450, "backchannel"],
  ["Got it.", 450, "backchannel"],
  ["Oke, lanjut", 650, "backchannel"],
  ["iya iya iya", 690, "backchannel"], // three words is the most
  ["yes yes yes", 690, "backchannel"],
  ["oke sip baik", 690, "backchannel"],
  ["oh gitu", 500, "backchannel"],
  ["aha", 300, "backchannel"],
  // A stop word anywhere.
  ["Stop", 400, "interrupt"],
  ["stop!", 400, "interrupt"],
  ["Stopp", 400, "interrupt"],
  ["Tunggu", 400, "interrupt"],
  ["Tunggu dulu.", 600, "interrupt"], // what the speech model heard of "Stop, tunggu dulu."
  ["tunggu dulu", 600, "interrupt"],
  ["Bentar", 400, "interrupt"],
  ["Sebentar", 450, "interrupt"],
  ["berhenti", 450, "interrupt"],
  ["Cukup", 400, "interrupt"],
  ["Diam", 300, "interrupt"],
  ["Bukan", 350, "interrupt"],
  ["salah", 350, "interrupt"],
  ["wait", 350, "interrupt"],
  ["Wait!", 350, "interrupt"],
  ["hold on", 450, "interrupt"],
  ["Hold on a second", 650, "interrupt"],
  ["no", 200, "interrupt"],
  ["No!", 200, "interrupt"],
  ["nooo", 400, "interrupt"],
  ["enough", 400, "interrupt"],
  ["Enough.", 400, "interrupt"],
  ["Iya tapi tunggu", 650, "interrupt"],
  ["oke stop", 500, "interrupt"],
  ["yes wait", 500, "interrupt"],
  ["bukan itu", 500, "interrupt"],
  // Anything else is an interruption.
  ["Saya mau tanya", 650, "interrupt"],
  ["Berapa totalnya?", 650, "interrupt"],
  ["Bisa diulang?", 650, "interrupt"],
  ["iya iya iya iya", 690, "interrupt"], // four words is too many
  ["oke oke oke oke", 690, "interrupt"],
  ["Tapi kenapa", 500, "interrupt"],
  ["eh", 250, "interrupt"],
  ["huh", 250, "interrupt"],
  ["what", 300, "interrupt"],
  ["ulangi", 400, "interrupt"],
  ["I have a question", 650, "interrupt"],
  ["iya benar sekali", 600, "interrupt"],
  ["Terus bagaimana", 600, "interrupt"],
  ["iya, tapi", 400, "interrupt"],
  // Speech long enough is an interruption whatever the words say.
  ["iya", 700, "interrupt"],
  ["iya", 5_000, "interrupt"],
  ["hmm", 701, "interrupt"],
  ["Oke, lanjut", 1_410, "interrupt"],
  ["", 700, "interrupt"],
  [null, 700, "interrupt"],
  [null, 5_000, "interrupt"],
  // The words are one hearing short: just under the cut-off they still count.
  ["iya", 699, "backchannel"],
  // No words: speechMs alone decides, and the cut-off is 700 ms.
  [null, 0, "backchannel"],
  [null, 300, "backchannel"],
  [null, 540, "backchannel"], // the "Iya" fixture
  [null, 699, "backchannel"],
  ["", 300, "backchannel"],
  ["   ", 300, "backchannel"],
  ["...", 400, "backchannel"],
  ["?!", 400, "backchannel"],
];

describe("judgeBargeIn", () => {
  it("has at least 50 rows", () => {
    expect(BARGE_IN_ROWS.length).toBeGreaterThanOrEqual(50);
  });

  it.each(BARGE_IN_ROWS)("%j heard for %i ms is %s, in both locales", (transcript, speechMs, verdict) => {
    expect(judgeBargeIn({ transcript, speechMs, locale: "id" })).toBe(verdict);
    expect(judgeBargeIn({ transcript, speechMs, locale: "en" })).toBe(verdict);
  });

  it("uses TURN_TIMING.interruptAfterMs as the cut-off, with and without words", () => {
    const cut = TURN_TIMING.interruptAfterMs;
    expect(judgeBargeIn({ transcript: "iya", speechMs: cut - 1, locale: "id" })).toBe("backchannel");
    expect(judgeBargeIn({ transcript: "iya", speechMs: cut, locale: "id" })).toBe("interrupt");
    expect(judgeBargeIn({ transcript: null, speechMs: cut - 1, locale: "id" })).toBe("backchannel");
    expect(judgeBargeIn({ transcript: null, speechMs: cut, locale: "id" })).toBe("interrupt");
  });
});

describe("trimToHeard", () => {
  type TrimRow = readonly [
    label: string,
    input: { text: string; playedMs: number; totalMs: number },
    expected: { text: string; interrupted: boolean },
  ];

  const ROWS: readonly TrimRow[] = [
    ["nothing played", { text: "Halo apa kabar", playedMs: 0, totalMs: 3000 }, { text: "", interrupted: true }],
    ["negative played", { text: "Halo apa kabar", playedMs: -50, totalMs: 3000 }, { text: "", interrupted: true }],
    [
      "played is not a number",
      { text: "Halo apa kabar", playedMs: Number.NaN, totalMs: 3000 },
      { text: "", interrupted: true },
    ],
    [
      "all played",
      { text: "Halo apa kabar", playedMs: 3000, totalMs: 3000 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "played exceeds the total",
      { text: "Halo apa kabar", playedMs: 4000, totalMs: 3000 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "played is infinite",
      { text: "Halo apa kabar", playedMs: Number.POSITIVE_INFINITY, totalMs: 3000 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "total is 0 and nothing played",
      { text: "Halo apa kabar", playedMs: 0, totalMs: 0 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "total is 0 and something played",
      { text: "Halo apa kabar", playedMs: 500, totalMs: 0 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "total is negative",
      { text: "Halo apa kabar", playedMs: 500, totalMs: -10 },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "total is not a number",
      { text: "Halo apa kabar", playedMs: 500, totalMs: Number.NaN },
      { text: "Halo apa kabar", interrupted: false },
    ],
    [
      "half, cut inside a word backs up",
      { text: "Halo apa kabar hari ini", playedMs: 1500, totalMs: 3000 },
      { text: "Halo apa", interrupted: true },
    ],
    [
      "cut exactly on a space keeps the word before",
      { text: "ab cd ef", playedMs: 5, totalMs: 8 },
      { text: "ab cd", interrupted: true },
    ],
    [
      "cut at the first letter of a word drops the space",
      { text: "ab cd ef", playedMs: 6, totalMs: 8 },
      { text: "ab cd", interrupted: true },
    ],
    [
      "cut inside the first word is empty",
      { text: "Supercalifragilistic is here", playedMs: 100, totalMs: 1000 },
      { text: "", interrupted: true },
    ],
    [
      "just under all played still drops the last word",
      { text: "Halo apa", playedMs: 2999, totalMs: 3000 },
      { text: "Halo", interrupted: true },
    ],
    [
      "punctuation stays with its word",
      { text: "Halo, apa kabar?", playedMs: 1500, totalMs: 3000 },
      { text: "Halo,", interrupted: true },
    ],
    ["empty text", { text: "", playedMs: 500, totalMs: 1000 }, { text: "", interrupted: false }],
    ["blank text", { text: "  ", playedMs: 500, totalMs: 1000 }, { text: "  ", interrupted: false }],
    [
      "trailing space: every word was heard",
      { text: "Halo ", playedMs: 900, totalMs: 1000 },
      { text: "Halo", interrupted: false },
    ],
    [
      "several spaces and a new line",
      { text: "satu  dua\ntiga empat", playedMs: 700, totalMs: 1000 },
      { text: "satu  dua\ntiga", interrupted: true },
    ],
    [
      "no spaces, Chinese: cut at the character",
      { text: "你好吗朋友", playedMs: 600, totalMs: 1000 },
      { text: "你好吗", interrupted: true },
    ],
    [
      "no spaces, Latin: cut at the character",
      { text: "Halo", playedMs: 500, totalMs: 1000 },
      { text: "Ha", interrupted: true },
    ],
    [
      "no spaces, surrogate pairs stay whole",
      { text: "😀😀😀😀", playedMs: 500, totalMs: 1000 },
      { text: "😀😀", interrupted: true },
    ],
  ];

  it("has at least 15 rows", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(15);
  });

  it.each(ROWS)("%s", (_label, input, expected) => {
    expect(trimToHeard(input)).toEqual(expected);
  });

  it("is never more than the text, always a prefix that ends on a word, and grows with playedMs", () => {
    const text = "Jadi begini, kemarin saya sudah kirim laporan ke klien, tapi mereka minta revisi.";
    let previous = 0;
    for (let played = -100; played <= 5_200; played += 37) {
      const { text: heard, interrupted } = trimToHeard({ text, playedMs: played, totalMs: 5_000 });
      expect(heard.length).toBeLessThanOrEqual(text.length);
      expect(text.startsWith(heard)).toBe(true);
      // Ends on a word boundary: the next character of the text, if any, is a space.
      expect(heard === "" || heard.length === text.length || text[heard.length] === " ").toBe(true);
      expect(heard.length).toBeGreaterThanOrEqual(previous);
      expect(interrupted).toBe(heard !== text);
      previous = heard.length;
    }
  });

  it("never throws on odd numbers", () => {
    for (const playedMs of [Number.NEGATIVE_INFINITY, -1, 0, 0.5, 1, 1e12, Number.POSITIVE_INFINITY, Number.NaN]) {
      for (const totalMs of [Number.NEGATIVE_INFINITY, -1, 0, 0.5, 1, 1e12, Number.POSITIVE_INFINITY, Number.NaN]) {
        const result = trimToHeard({ text: "Halo apa kabar", playedMs, totalMs });
        expect("Halo apa kabar".startsWith(result.text)).toBe(true);
      }
    }
  });
});

describe("TURN_TIMING", () => {
  it("keeps every key and the order the relay depends on", () => {
    expect(Object.keys(TURN_TIMING).sort()).toEqual(
      [
        "earlySendMs",
        "endSilenceMs",
        "interruptAfterMs",
        "maxSilenceMs",
        "playedWaitMs",
        "waitAfterUnfinishedMs",
      ].sort(),
    );
    expect(TURN_TIMING.earlySendMs).toBeLessThan(TURN_TIMING.endSilenceMs);
    expect(TURN_TIMING.endSilenceMs).toBeLessThan(TURN_TIMING.waitAfterUnfinishedMs);
    expect(TURN_TIMING.waitAfterUnfinishedMs).toBeLessThan(TURN_TIMING.maxSilenceMs);
  });
});
