/**
 * Turn-taking rules (plan W2, W4). The host has no gateway speech detection now: it finds speech
 * and silence itself (`vad.ts`) and applies these rules on top of that. Lane D owns this file. The
 * signatures are the contract the relay codes against. Everything here is a pure function of its
 * arguments: no clock, no I/O.
 *
 * The words come from a speech model that hears short speech roughly ("Iya" came back as "E ya!",
 * "Stop, tunggu dulu." as "Tunggu dulu.", "Saya mau pesan yang" as "Saya mau bersenyan."), so the rules
 * lean on a few endings and a few small words and never on a spelling being exact. People mix Indonesian
 * and English in one sentence, so both vocabularies are always on, whatever `locale` says.
 */

export type VoiceLocale = "en" | "id";

/** After silence: answer now, or wait for more words. */
export type TurnEndVerdict = "finished" | "wait";

/** While the agent speaks and the person talks over it: carry on, or stop and cut. */
export type BargeInVerdict = "backchannel" | "interrupt";

export const TURN_TIMING = {
  /**
   * Silence after speech at which the host sends the utterance to the talker, before the turn is confirmed.
   * The synthetic `long.wav` has clause pauses of 350 to 385 ms, so this fires early by mistake about once or
   * twice in a long sentence. That costs tokens, not a wrong interruption, and a later value costs latency
   * on every turn, so it stays.
   */
  earlySendMs: 300,
  /** Silence after which a turn is confirmed finished, unless the words say otherwise. */
  endSilenceMs: 700,
  /** Extra wait for more speech after a transcript judged unfinished. */
  waitAfterUnfinishedMs: 1_200,
  /** Silence after which a turn ends whatever the words say. */
  maxSilenceMs: 2_500,
  /**
   * Speech over the agent longer than this is an interruption without reading the words. The fixtures bracket
   * it: "Iya" is 0.55 s of speech and "Stop, tunggu dulu." is 1.41 s.
   */
  interruptAfterMs: 700,
  /** How long the host waits for `played` after `stop_audio` before it trims with what it has. */
  playedWaitMs: 300,
} as const;

// ---------------------------------------------------------------------------------------------------------
// Words

/** The words of a text, lower case, without punctuation. Apostrophes stay inside a word ("don't"). */
function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  ).map((w) => w.replace(/’/g, "'"));
}

/** A word with every run of a repeated letter cut to one letter, so "iyaa", "okee" and "hmmm" match. */
function squash(word: string): string {
  return word.replace(/(.)\1+/gu, "$1");
}

// ---------------------------------------------------------------------------------------------------------
// judgeTurnEnd

/** A hesitation on its own: "eh", "ee", "ehm", "er", "um", "uh", "hmm", "mm", "anu", with the stretched forms. */
const HESITATION = /^(?:e+h*m*|er+m*|u+[hm]+|h+m+|m{2,}|a+n+u+)$/;

/** Two words that trail off: "apa ya", "gimana ya". */
const TRAILING_OFF_PHRASES: readonly (readonly [string, string])[] = [
  ["apa", "ya"],
  ["gimana", "ya"],
  ["bagaimana", "ya"],
  ["siapa", "ya"],
  ["apa", "namanya"],
  ["ya", "namanya"],
];

/** Indonesian words that need more after them. */
const ID_OPEN_ENDS = new Set([
  "yang",
  "dan",
  "atau",
  "tapi",
  "tetapi",
  "terus",
  "jadi",
  "karena",
  "sebab",
  "kalau",
  "kalo",
  "jika",
  "supaya",
  "agar",
  "bahwa",
  "untuk",
  "dengan",
  "di",
  "ke",
  "dari",
  "pada",
  "dalam",
  "oleh",
  "sama",
  "seperti",
  "lalu",
  "kemudian",
  "namun",
  "serta",
  "sambil",
  "yaitu",
  "misalnya",
  "maksudnya",
  "begini", // "Jadi begini," is an opener; the long fixture pauses right after it
  "gini",
  "kayak",
  "soalnya",
  "padahal",
]);

/** English words that need more after them. */
const EN_OPEN_ENDS = new Set([
  "and",
  "but",
  "so",
  "because",
  "the",
  "a",
  "an",
  "to",
  "of",
  "with",
  "for",
  "like",
  "or",
  "if",
  "than",
]);

/** "so" ends a complete answer in these: "I think so", "if so", "or so", "so so". */
const COMPLETE_SO = /(?:^|\s)(?:think|guess|hope|believe|suppose|say|said|if|or|not|so|why)\s+so$/;

/** Words a capital letter label follows: "opsi A", "paket A", "plan A". */
const LABEL_WORDS = new Set([
  "opsi",
  "option",
  "paket",
  "package",
  "pilihan",
  "plan",
  "rencana",
  "tipe",
  "type",
  "grup",
  "group",
  "kelas",
  "class",
  "bagian",
  "section",
  "versi",
  "version",
  "vitamin",
  "grade",
  "blok",
  "block",
  "tahap",
  "phase",
]);

/** Words that are a connective in Indonesian and an ordinary name in English ("Dan", "Yang", "Di"). */
const NAME_LIKE = new Set(["dan", "yang", "di"]);

/**
 * Word rules over the transcript of one utterance. `wait` when the words show the person is not done: nothing
 * said, a trailing "..." or dash, a hesitation or a trailing-off phrase at the end, or a word at the end that
 * needs more after it. Case and punctuation are otherwise noise. A question mark ends the turn, so "Terus?" and
 * "Ada kopi susu?" are finished. Anything else, however short ("Stop.", "Ulangi."), is finished.
 *
 * Two small exceptions to "case is noise": a capitalised "Dan", "Yang" or "Di" at the end is a name when it is not
 * the first word ("Tolong telepon Dan"), and when it is the only word `locale` breaks the tie: a name in English,
 * the connective in Indonesian. A capital "A" after a label word ("opsi A", "plan A") is a label, not an article.
 */
export function judgeTurnEnd(transcript: string, locale: VoiceLocale): TurnEndVerdict {
  const text = transcript.normalize("NFKC").trim();
  const words = wordsOf(text);
  if (words.length === 0) {
    return "wait";
  }
  const tail = text.replace(/["'”’)\]}\s]+$/u, "");
  // A person who trails off, in writing: "...", "…" or a dash ("pesan yang -"). A price like "Rp5.000,-" is not one.
  if (/\.{2,}$/.test(tail) || /(?<![,\d])[-–—―]$/.test(tail)) {
    return "wait";
  }
  const last = words[words.length - 1] ?? "";
  const beforeLast = words[words.length - 2] ?? "";
  if (TRAILING_OFF_PHRASES.some(([a, b]) => beforeLast === a && last === b)) {
    return "wait";
  }
  if (tail.endsWith("?")) {
    return "finished";
  }
  if (/^m+$/.test(beforeLast) && /^h+m+$/.test(last)) {
    return "finished"; // "mm-hm" says yes
  }
  if (HESITATION.test(last)) {
    return "wait";
  }
  const open = ID_OPEN_ENDS.has(last) || EN_OPEN_ENDS.has(last);
  if (!open) {
    return "finished";
  }
  if (last === "sama" && beforeLast === "sama") {
    return "finished"; // "sama-sama": you're welcome
  }
  if (last === "so" && COMPLETE_SO.test(words.join(" "))) {
    return "finished";
  }
  const lastRaw = text.match(/[\p{L}\p{N}]+(?=[^\p{L}\p{N}]*$)/u)?.[0] ?? "";
  if (NAME_LIKE.has(last) && /^\p{Lu}\p{Ll}+$/u.test(lastRaw) && (words.length > 1 || locale === "en")) {
    return "finished";
  }
  if (last === "a" && lastRaw === "A" && LABEL_WORDS.has(beforeLast)) {
    return "finished";
  }
  return "wait";
}

// ---------------------------------------------------------------------------------------------------------
// judgeBargeIn

/** Listening noises and go-on words, spelled the way a person says them. Squashed before use. */
const BACKCHANNEL_WORDS = new Set(
  [
    "iya",
    "eya",
    "ya",
    "mm",
    "hm",
    "mhm",
    "hmm",
    "oke",
    "okey",
    "ok",
    "okay",
    "oh",
    "ah",
    "aha",
    "sip",
    "siap",
    "baik",
    "betul",
    "benar",
    "lanjut",
    "terus",
    "gitu",
    "begitu",
    "yes",
    "yeah",
    "yep",
    "yup",
    "right",
    "sure",
  ].map(squash),
);

/** Listening noises that are two words: "e ya" (the speech model's "iya"), "he eh", "uh huh", "go on", "got it". */
const BACKCHANNEL_PHRASES = new Set(
  ["e ya", "e iya", "he eh", "uh huh", "go on", "got it"].map((p) => p.split(" ").map(squash).join(" ")),
);

/** Words that mean "stop": a person saying one of them wants the agent to stop. Squashed before use. */
const STOP_WORDS = new Set(
  ["stop", "tunggu", "bentar", "sebentar", "berhenti", "cukup", "diam", "bukan", "salah", "wait", "no", "enough"].map(
    squash,
  ),
);

/** The most words a backchannel can have. */
const BACKCHANNEL_MAX_WORDS = 3;

/**
 * Rules over what the person said over the agent. `transcript` is null when the quick hearing failed.
 *
 * - `speechMs` of `TURN_TIMING.interruptAfterMs` or more is an interruption without reading the words.
 * - With words: a stop word anywhere ("stop", "tunggu", "wait", "hold on", "no", "enough", ...) interrupts.
 *   Otherwise it is a backchannel only when there are at most three words and every one is a listening noise
 *   or a go-on word ("iya", "hmm", "oke", "e ya", "uh huh", "lanjut", ...). Anything else interrupts.
 *   Letters stretched or doubled ("iyaa", "okee", "hmmm") match their plain forms.
 * - With no words (null, or a transcript that is blank or only punctuation): `speechMs` alone decides, and
 *   the cut-off is the same `interruptAfterMs`. Under it the sound is a short noise or "iya" and the agent
 *   carries on; a "stop" that short with no hearing is missed, which is the side to err on.
 *
 * `locale` is not needed: both vocabularies are always on, and no word here is a tie between languages.
 */
export function judgeBargeIn(input: {
  readonly transcript: string | null;
  readonly speechMs: number;
  readonly locale: VoiceLocale;
}): BargeInVerdict {
  if (input.speechMs >= TURN_TIMING.interruptAfterMs) {
    return "interrupt";
  }
  const words = input.transcript === null ? [] : wordsOf(input.transcript).map(squash);
  if (words.length === 0) {
    return "backchannel";
  }
  if (words.some((w) => STOP_WORDS.has(w)) || words.some((w, i) => w === "hold" && words[i + 1] === "on")) {
    return "interrupt";
  }
  if (words.length > BACKCHANNEL_MAX_WORDS) {
    return "interrupt";
  }
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    const next = words[i + 1];
    if (next !== undefined && BACKCHANNEL_PHRASES.has(`${word} ${next}`)) {
      i += 2;
    } else if (BACKCHANNEL_WORDS.has(word)) {
      i += 1;
    } else {
      return "interrupt";
    }
  }
  return "backchannel";
}

// ---------------------------------------------------------------------------------------------------------
// trimToHeard

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/u.test(char);

/**
 * The part of a reply the person heard, by the share of its audio that played, cut back to a word boundary
 * so they never "heard" half a word. Never more than `text`.
 *
 * - Nothing played (`playedMs` 0 or less, or not a number) with audio to play: `""`, interrupted.
 * - All of it played (`playedMs` at or past `totalMs`): the whole text, not interrupted.
 * - No audio length (`totalMs` 0 or less, or not finite): there was no audio to cut, so the whole text,
 *   not interrupted. This is also what an empty or blank `text` gets.
 * - Text with no spaces at all (Chinese, Japanese, a long code): there is no word boundary, so it is cut
 *   at the character the share points to, never inside a surrogate pair.
 * - `interrupted` is false when every word of the text was heard, even if some trailing audio was not.
 */
export function trimToHeard(input: { readonly text: string; readonly playedMs: number; readonly totalMs: number }): {
  readonly text: string;
  readonly interrupted: boolean;
} {
  const { text } = input;
  const total = Number.isFinite(input.totalMs) && input.totalMs > 0 ? input.totalMs : 0;
  const played = Number.isNaN(input.playedMs) ? 0 : input.playedMs;
  if (text.trim() === "" || total === 0 || played >= total) {
    return { text, interrupted: false };
  }
  if (played <= 0) {
    return { text: "", interrupted: true };
  }
  const chars = Array.from(text);
  let end = Math.min(chars.length, Math.floor(chars.length * (played / total)));
  if (/\s/u.test(text.trim())) {
    // A cut inside a word backs up to where that word began.
    while (end > 0 && end < chars.length && !isSpace(chars[end]) && !isSpace(chars[end - 1])) {
      end -= 1;
    }
  }
  const heard = chars.slice(0, end).join("").trimEnd();
  return { text: heard, interrupted: heard !== text.trimEnd() };
}
