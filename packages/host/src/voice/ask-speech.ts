/**
 * What `ask_nultron` says and how it says it (plan W3, W5): the fixed sentences the talker reads when
 * the thinker has no answer, the note that makes a Chat run answer for the ear, and the clean-up that
 * strips markdown from whatever still comes back. Lane C owns this file.
 *
 * Every sentence is spoken aloud, so each is short, plain, and has no markup. New copy goes in both
 * languages (`en`, `id`); `ask-speech.test.ts` fails when one is missing or empty.
 */
import type { VoiceLocale } from "./turns";

export type AskCopy = {
  /** The key or the plan stops this desk from calling the model. */
  readonly gatewayBlocked: string;
  /** A question for this thread is still running, or the desk has no spare run. */
  readonly busy: string;
  /** No answer within the time budget. */
  readonly timeout: string;
  /** Anything else that went wrong, and a person who cut in (the relay drops that one). */
  readonly failed: string;
  /** The person asked for a write, a send, a paid step or long work: a card is on the screen. */
  readonly needsTap: string;
  /** A delegated run started; the label is who was asked (`Research agent`, a bot's name). */
  readonly delegating: (label: string) => string;
  /** A transient talker error on try 1 or 2, asking the person to repeat. */
  readonly transientError: string;
  /** Live status caption while a read tool is running. */
  readonly toolStatus: (toolKey: string) => string;
};

const TOOL_STATUS_EN: Readonly<Record<string, string>> = {
  web_search: "Searching the web…",
  web_fetch: "Reading web page…",
  knowledge_search: "Searching Knowledge Base…",
  past_sessions: "Checking past sessions…",
  list_files: "Listing files…",
  read_file: "Reading file…",
  search_files: "Searching files…",
  calculator: "Calculating…",
  datetime: "Checking the date and time…",
  self_check: "Checking details…",
};

const TOOL_STATUS_ID: Readonly<Record<string, string>> = {
  web_search: "Mencari di web…",
  web_fetch: "Membaca halaman web…",
  knowledge_search: "Mencari di Basis Pengetahuan…",
  past_sessions: "Mengecek percakapan lalu…",
  list_files: "Melihat daftar file…",
  read_file: "Membaca file…",
  search_files: "Mencari di file…",
  calculator: "Menghitung…",
  datetime: "Mengecek tanggal dan waktu…",
  self_check: "Memeriksa detail…",
};

export const ASK_COPY: Readonly<Record<VoiceLocale, AskCopy>> = {
  en: {
    gatewayBlocked: "I can't answer right now. The account needs a look on the screen.",
    busy: "I'm still working on the last question. Give me a moment.",
    timeout: "That took too long. Please ask again.",
    failed: "I couldn't get that just now. Please try again.",
    needsTap: "That one needs your okay. It's on the screen, and one tap starts it.",
    delegating: (label: string) => `Asking ${label}…`,
    transientError: "I had a quick hiccup. Could you say that again?",
    toolStatus: (toolKey: string) => TOOL_STATUS_EN[toolKey] ?? "Looking that up…",
  },
  id: {
    gatewayBlocked: "Saya belum bisa menjawab sekarang. Akunnya perlu dicek di layar.",
    busy: "Saya masih mengerjakan pertanyaan tadi. Tunggu sebentar.",
    timeout: "Itu terlalu lama. Coba tanya lagi.",
    failed: "Saya belum bisa mengambil itu sekarang. Coba lagi.",
    needsTap: "Yang itu perlu persetujuan. Kartunya ada di layar, satu ketukan untuk memulai.",
    delegating: (label: string) => `Meminta ${label}…`,
    transientError: "Maaf, ada gangguan sebentar. Bisa ulangi lagi?",
    toolStatus: (toolKey: string) => TOOL_STATUS_ID[toolKey] ?? "Mencari informasi…",
  },
};

/** The copy for a locale; any other value reads as English, so a bad value never throws. */
export function askCopy(locale: VoiceLocale): AskCopy {
  return ASK_COPY[locale] ?? ASK_COPY.en;
}

const LANGUAGE_NAME: Readonly<Record<VoiceLocale, string>> = {
  en: "English",
  id: "Indonesian (Bahasa Indonesia)",
};

/**
 * The last paragraph of the run's instructions. It comes after the output-language rule and the
 * thread's own prompt, so it has the last word: this answer is heard, not read.
 */
export function voiceNote(locale: VoiceLocale): string {
  const language = LANGUAGE_NAME[locale] ?? LANGUAGE_NAME.en;
  return [
    "",
    "",
    `Voice: your answer will be spoken aloud, in ${language}, whatever language the instructions above name. Answer for the ear in at most three short sentences. No markdown, no lists, no links, no file paths. Say numbers and currency the way a person says them. If the desk does not have the answer, say so plainly instead of guessing.`,
    "You may hand work to the desk's agents with delegate: call it yourself, one call per agent, all in the same step, then say in at most three short sentences what each one found, naming them. You cannot write a file, send anything or make media from here. If the person asks for that, call request_tap with one line saying what will start, and do not do it yourself.",
  ].join("\n");
}

/** The longest summary a card carries: one line on a card, not a paragraph. */
export const TAP_SUMMARY_MAX = 200;

/** One line for the card: the model's words, flattened and cut at a word boundary. */
export function tapSummary(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? oneLine(raw) : "";
  const chosen = text || oneLine(fallback);
  if (chosen.length <= TAP_SUMMARY_MAX) {
    return chosen;
  }
  const cut = chosen.slice(0, TAP_SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TAP_SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Plain speech from whatever the model wrote. The note above asks for no markup, and this is the
 * belt: code fences and inline code lose their marks, links keep their words, bare addresses and
 * `[n]` source markers go, and headings, bullets, quotes, table bars and emphasis lose their marks.
 * The result is one run of sentences with single spaces.
 */
export function speakable(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  // A fenced block reads as its content, without the fence line or the language name.
  out = out.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
  // An image has nothing to say aloud; a link keeps its words.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Source markers from the Knowledge Base ([1], [2, 3]) and bare addresses.
  out = out.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "");
  out = out.replace(/<?\bhttps?:\/\/[^\s<>)\]]+>?/gi, "");
  out = out.replace(/<\/?[a-z][^>]*>/gi, "");
  // Line-start marks: headings, quotes, bullets, numbered lists, rules.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]*>+[ \t]?/gm, "");
  out = out.replace(/^[ \t]*[-*+•][ \t]+/gm, "");
  out = out.replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, "");
  out = out.replace(/^[ \t]*([-*_=]{3,})[ \t]*$/gm, "");
  // Table bars and their divider rows.
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  out = out.replace(/[ \t]*\|[ \t]*/g, ", ");
  // Emphasis and inline code marks, keeping the words between them.
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1$2");
  out = out.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, "$1$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  out = out.replace(/`+/g, "");
  // Line breaks read as a pause; a dangling separator from a table or list is dropped.
  out = out.replace(/(?:,\s*)+\n/g, "\n");
  out = out.replace(/\s*\n+\s*/g, " ");
  out = out.replace(/(?:^|\s),(?=\s)/g, "");
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1");
  return out.replace(/^[,\s]+/, "").trim();
}
