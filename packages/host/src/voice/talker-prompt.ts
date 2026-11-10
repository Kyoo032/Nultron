/**
 * The talker's fixed words. They stay short and stable so the provider can cache them.
 * Tool JSON is the chat-completions shape (`function` nested). `ask.ts` declares the same
 * tool for the realtime socket, with the name at the top level; this file does not change that.
 */
import type { VoiceLocale } from "./turns";

export const ASK_NULTRON_NAME = "ask_nultron";
export const KEEP_LISTENING_NAME = "keep_listening";

/**
 * When `on` is true, a reply offers `keep_listening` unless the host set `mustAnswer`.
 * Live check 2026-11-10 left this off: unfinished waited on 2 of 3 runs, and no other fixture waited.
 */
export const OFFER_KEEP_LISTENING = { on: false };

export const TALKER_INSTRUCTIONS: Readonly<Record<VoiceLocale, string>> = {
  en: [
    "You are Nultron, speaking aloud. Answer in one short sentence, two only when needed,",
    "about twenty words at most unless you are speaking a tool result.",
    "No lists. Ask no follow-up question unless the person asked for help choosing.",
    "For any fact, data, file, Knowledge Base or task question, call ask_nultron",
    "with the person's request in their own words and say nothing yourself.",
    "Never answer a fact from memory. Never say a tool's name.",
    'Handle small talk, "repeat that", "slower" and "stop" yourself.',
    "When you speak a tool result, say it naturally and add no facts.",
  ].join(" "),
  id: [
    "Kamu Nultron dan sedang berbicara. Jawab dengan satu kalimat pendek, dua hanya bila perlu,",
    "paling banyak sekitar dua puluh kata kecuali saat mengucapkan hasil dari alat.",
    "Jangan membuat daftar. Jangan mengajukan pertanyaan lanjutan kecuali orang itu meminta bantuan memilih.",
    "Untuk pertanyaan tentang fakta, data, berkas, Basis Pengetahuan, atau tugas, panggil ask_nultron",
    "dengan permintaan orang itu dalam kata-katanya sendiri dan jangan berkata apa-apa sendiri.",
    "Jangan menjawab fakta dari ingatan. Jangan pernah menyebut nama alat.",
    'Obrolan ringan, "ulangi itu", "lebih pelan", dan "berhenti" kamu tangani sendiri.',
    "Saat mengucapkan hasil dari alat, ucapkan secara alami dan jangan menambah fakta.",
  ].join(" "),
};

/** Played while the desk looks something up. Cached only when the model says this and nothing else. */
export const ACK_SENTENCE: Readonly<Record<VoiceLocale, string>> = {
  en: "One moment, let me check.",
  id: "Sebentar, saya cek dulu.",
};

export const ACK_INSTRUCTIONS: Readonly<Record<VoiceLocale, string>> = {
  en: "Say exactly the user's sentence and nothing else.",
  id: "Ucapkan persis kalimat pengguna dan jangan menambah apa pun.",
};

/** Rough words for a short stretch. The caller's word rules tolerate a miss. */
export const HEAR_SHORT_INSTRUCTIONS: Readonly<Record<VoiceLocale, string>> = {
  en: "Write exactly what the person said.",
  id: "Tuliskan persis kata-kata pengguna, tanpa menjawab dan tanpa tambahan.",
};

export const ASK_NULTRON_GATEWAY_TOOL = {
  type: "function",
  function: {
    name: ASK_NULTRON_NAME,
    description:
      "Ask Nultron's desk for facts, the person's files and Knowledge Base, or to start work. Use it for every factual or task question. Pass the person's request in their own words.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The person's request, in their own words." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
} as const;

export const KEEP_LISTENING_GATEWAY_TOOL = {
  type: "function",
  function: {
    name: KEEP_LISTENING_NAME,
    description:
      "The person's sentence is clearly unfinished: they trailed off or stopped on a filler such as " +
      "'yang', 'eh', 'anu', 'jadi', 'terus', 'and', 'so'. Call this and say nothing.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
} as const;

/** `ask_nultron`, plus `keep_listening` only when the switch is on and the host will still wait. */
export function gatewayTools(mustAnswer: boolean): readonly object[] {
  if (OFFER_KEEP_LISTENING.on && !mustAnswer) {
    return [ASK_NULTRON_GATEWAY_TOOL, KEEP_LISTENING_GATEWAY_TOOL];
  }
  return [ASK_NULTRON_GATEWAY_TOOL];
}
