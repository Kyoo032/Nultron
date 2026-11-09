import { parseAppLocale, type AppLocale } from "../locale";

const CHAT_ID_OUTPUT_RULE =
  "Write every user-facing reply in Bahasa Indonesia. Use professional, polite Anda and infinitive forms. Keep brand names Nultron and Toko Token unchanged. Do not switch to English unless quoting the user.";

export type StubChatCopy = {
  thinkCalc: string;
  thinkClock: string;
  thinkDefault: string;
  needKey: string;
};

const STUB_CHAT_COPY: Record<AppLocale, StubChatCopy> = {
  en: {
    thinkCalc: "I'll compute this with the calculator, then return only the result.",
    thinkClock: "I'll read the clock and return the timestamp.",
    thinkDefault:
      "This desk has no live model. I can still use local tools; a gateway key in Settings unlocks a real answer.",
    needKey: "I need a Toko Token gateway key in Settings to answer that.",
  },
  id: {
    thinkCalc: "Saya akan menghitung ini dengan kalkulator, lalu hanya mengembalikan hasilnya.",
    thinkClock: "Saya akan membaca jam dan mengembalikan stempel waktunya.",
    thinkDefault:
      "Meja ini tidak punya model live. Saya masih bisa memakai alat lokal; kunci gateway di Pengaturan membuka jawaban sungguhan.",
    needKey: "Saya memerlukan kunci gateway Toko Token di Pengaturan untuk menjawab itu.",
  },
};

const CLOCK_RE = /\b(date|time|today|now|clock|tanggal|waktu|sekarang|jam)\b|\bhari\s+ini\b/i;

export function chatOutputLanguageRule(locale: AppLocale): string | null {
  return locale === "id" ? CHAT_ID_OUTPUT_RULE : null;
}

export function withChatOutputLanguage(systemPrompt: string, locale: AppLocale): string {
  const rule = chatOutputLanguageRule(locale);
  if (!rule) {
    return systemPrompt;
  }
  if (systemPrompt.includes(rule)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${rule}`;
}

export function stubChatCopy(locale: AppLocale): StubChatCopy {
  return STUB_CHAT_COPY[parseAppLocale(locale)];
}

/**
 * Sentences a Chat turn shows while it works. Mirrors `chat.harness` in the en/id catalogs.
 * The host does not import those catalogs; this table is the copy the turn actually writes.
 */
export type ChatTurnCopy = {
  thinkPast: string;
  thinkDesk: string;
  lookingAttached: string;
  pastNone: string;
  pastOne: string;
  pastMany: string;
  /** Stub only: a real marker plus one the desk did not offer, so the check has something to drop. */
  deskCite: string;
  noSource: string;
  /**
   * The run used every step and the last one was still working. `{tools}` is the tools that finished.
   * The sentence names them and says the answer did not.
   */
  stepLimit: string;
  /** The same close when no tool finished. */
  stepLimitEmpty: string;
  /** The word between the last two names in `{tools}`. */
  stepLimitAnd: string;
  /**
   * A model call failed after a tool had completed: the tools ran, no answer followed, why (`{reason}`),
   * and what to send. The tool steps are kept in the turn, so it says they ran and does not offer a redo.
   */
  interrupted: string;
  /** The model asked for could not be reached before it answered, so the turn ran on another (`{from}`, `{to}`). */
  modelFallback: string;
  saveTimeout: string;
};

const CHAT_TURN_COPY: Record<AppLocale, ChatTurnCopy> = {
  en: {
    thinkPast: "I'll look through earlier chats, then answer from what I find.",
    thinkDesk: "I'll answer from the desk note.",
    lookingAttached: "Looking at what you attached.",
    pastNone: "No earlier chat on this desk matches that.",
    pastOne: 'The earlier chat is "{title}".',
    pastMany: 'Earlier chats include "{title}".',
    deskCite: "From the desk [1] [99].",
    noSource: "This desk did not have a source for that.",
    stepLimit: "{tools} finished, but the answer didn't. Ask me to continue and I will pick up from where I stopped.",
    stepLimitEmpty:
      "No tool finished, but the answer didn't. Ask me to continue and I will pick up from where I stopped.",
    stepLimitAnd: "and",
    interrupted:
      'The tool steps above ran, but I could not finish the answer.\n\nReason: {reason}\n\nSend "continue" and I will try again.',
    modelFallback: "{from} is unavailable; used {to} for this answer.",
    saveTimeout: "Saving this reply is taking too long. Reload the chat in a minute to see whether it was kept.",
  },
  id: {
    thinkPast: "Saya akan meninjau percakapan sebelumnya, lalu menjawab dari yang saya temukan.",
    thinkDesk: "Saya akan menjawab dari catatan meja.",
    lookingAttached: "Melihat yang Anda lampirkan.",
    pastNone: "Tidak ada percakapan sebelumnya di meja ini yang cocok.",
    pastOne: 'Percakapan sebelumnya berjudul "{title}".',
    pastMany: 'Percakapan sebelumnya mencakup "{title}".',
    deskCite: "Dari meja [1] [99].",
    noSource: "Meja ini tidak punya sumber untuk itu.",
    stepLimit:
      "{tools} sudah selesai, tetapi jawabannya belum. Minta saya untuk melanjutkan, dan saya akan meneruskannya dari titik terakhir.",
    stepLimitEmpty:
      "Tidak ada alat yang selesai, tetapi jawabannya belum. Minta saya untuk melanjutkan, dan saya akan meneruskannya dari titik terakhir.",
    stepLimitAnd: "dan",
    interrupted:
      'Langkah alat di atas sudah berjalan, tetapi saya tidak dapat menyelesaikan jawabannya.\n\nAlasan: {reason}\n\nKirim "lanjutkan" dan saya akan mencoba lagi.',
    modelFallback: "{from} tidak tersedia; menggunakan {to} untuk jawaban ini.",
    saveTimeout:
      "Penyimpanan balasan ini terlalu lama. Muat ulang percakapan sebentar lagi untuk melihat apakah balasan sudah tersimpan.",
  },
};

export function chatTurnCopy(locale: AppLocale): ChatTurnCopy {
  return CHAT_TURN_COPY[parseAppLocale(locale)];
}

export function fillChatTurn(template: string, title: string): string {
  return template.replaceAll("{title}", title);
}

/** Puts a failure's own words into a sentence. `replaceAll` with a function, so `$&` in a reason stays literal. */
export function fillChatReason(template: string, reason: string): string {
  return template.replaceAll("{reason}", () => reason);
}

/** Puts the finished-tool list into the step-limit sentence. A `$` in a name stays literal. */
export function fillChatTools(template: string, tools: string): string {
  return template.replaceAll("{tools}", () => tools);
}

function listToolNames(names: readonly string[], andWord: string): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]} ${andWord} ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")} ${andWord} ${names[names.length - 1]}`;
}

/**
 * The step-limit sentence. `finishedTools` are the tool keys that completed, in the order they finished.
 * None finished uses the empty sentence, which still says the answer did not.
 */
export function stepLimitNote(locale: AppLocale, finishedTools: readonly string[]): string {
  const copy = chatTurnCopy(locale);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of finishedTools) {
    const name = tool.replace(/\s+/g, " ").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) {
    return copy.stepLimitEmpty;
  }
  return fillChatTools(copy.stepLimit, listToolNames(names, copy.stepLimitAnd));
}

export function wantsStubClock(summary: string): boolean {
  return CLOCK_RE.test(summary);
}

const PAST_CHAT_RE =
  /\b(earlier chat|previous (?:chat|conversation)|last time we|what did we (?:say|decide|discuss)|we (?:said|decided))\b|percakapan sebelumnya|chat sebelumnya|terakhir kali|yang kita (?:bahas|putuskan|katakan)/i;

const DESK_SOURCE_RE =
  /\bwhat does (?:the|this) desk (?:say|know)\b|\baccording to (?:my|the) (?:notes|sources)\b|menurut (?:catatan|sumber)|apa kata (?:meja|catatan)/i;

/** The person referred to an earlier chat and did not name a tool. */
export function wantsStubPastChat(summary: string): boolean {
  return PAST_CHAT_RE.test(summary);
}

/** The person asked what the desk already knows, without naming a cite format. */
export function wantsStubDeskSource(summary: string): boolean {
  return DESK_SOURCE_RE.test(summary);
}

const CHAT_STUB_ENHANCE_SUFFIX: Record<AppLocale, string> = {
  en: "State the goal, constraints, and the output you want.",
  id: "Nyatakan tujuan, batasan, dan keluaran yang Anda inginkan.",
};

export function stubChatEnhanceSuffix(locale: AppLocale): string {
  return CHAT_STUB_ENHANCE_SUFFIX[parseAppLocale(locale)];
}
