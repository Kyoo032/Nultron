import { parseAppLocale, type AppLocale } from "../locale";

export type MeetingPhaseLabel = "writing" | "fixing" | "grounding" | "saving" | "translating" | "translating-again";

const PHASE: Record<MeetingPhaseLabel, Record<AppLocale, string>> = {
  writing: { en: "Writing the minutes", id: "Menulis notulen" },
  // The one repair round the minutes checks spend (`host/src/meeting/run.ts`, `onRound`).
  fixing: {
    en: "Fixing what the checks found in the minutes",
    id: "Memperbaiki temuan pemeriksaan pada notulen",
  },
  grounding: {
    en: "Checking names, dates, and figures",
    id: "Memeriksa nama, tanggal, dan angka",
  },
  saving: { en: "Saving the minutes", id: "Menyimpan notulen" },
  translating: { en: "Translating the minutes", id: "Menerjemahkan notulen" },
  "translating-again": { en: "Translating the minutes again", id: "Menerjemahkan notulen sekali lagi" },
};

/** Progress label for the desk. Follows the desk locale, not the language the minutes are written in. */
export function meetingPhaseLabel(phase: MeetingPhaseLabel, locale: AppLocale): string {
  return PHASE[phase][parseAppLocale(locale)];
}

/** Told to the model when the first translation changed the sheet. Follows the target language. */
export function translationRetryNote(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "The previous translation changed the sheet. Keep the same counts, owners, dates, figures, and markers, and copy every quote exactly as it is, untranslated.",
    id: "Terjemahan sebelumnya mengubah lembarnya. Pertahankan jumlah butir, penanggung jawab, tanggal, angka, dan setiap penanda, dan salin setiap kutipan persis apa adanya, tanpa diterjemahkan.",
  };
  return copy[parseAppLocale(locale)];
}

export function emptyMinutesMessage(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "The model returned no minutes.",
    id: "Model tidak mengembalikan notulen.",
  };
  return copy[parseAppLocale(locale)];
}

export function invalidMinutesMessage(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "The model returned minutes that are not the sheet.",
    id: "Model mengembalikan notulen yang bukan lembar itu.",
  };
  return copy[parseAppLocale(locale)];
}

/** Shown on the desk when the other language still does not match. Follows the desk locale. */
export function translationDisagreedMessage(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "The other language did not match these minutes, so only this set was kept.",
    id: "Bahasa satunya tidak sama dengan notulen ini, jadi hanya set ini yang disimpan.",
  };
  return copy[parseAppLocale(locale)];
}

/** Why a transcript file could not become a transcript. */
export type TranscriptFileProblem =
  | "missing"
  | "type"
  | "empty"
  | "no_text"
  | "too_large"
  | "encoding"
  | "needs_ocr"
  | "encrypted"
  | "unreadable"
  | "timeout";

const TRANSCRIPT_FILE_PROBLEM: Record<TranscriptFileProblem, Record<AppLocale, string>> = {
  missing: {
    en: 'Attach one transcript file under the field "file".',
    id: 'Lampirkan satu berkas transkrip pada kolom "file".',
  },
  type: {
    en: "That file type is not a transcript. Use .txt, .md, .vtt, .srt, .docx or .pdf.",
    id: "Jenis berkas itu bukan transkrip. Gunakan .txt, .md, .vtt, .srt, .docx, atau .pdf.",
  },
  empty: { en: "That file is empty.", id: "Berkas itu kosong." },
  no_text: { en: "No text could be read from that file.", id: "Tidak ada teks yang bisa dibaca dari berkas itu." },
  too_large: {
    en: "That transcript is too long. A transcript is capped at {max} characters.",
    id: "Transkrip itu terlalu panjang. Transkrip dibatasi {max} karakter.",
  },
  encoding: {
    en: "That text file is not UTF-8. Save it as UTF-8 and try again.",
    id: "Berkas teks itu bukan UTF-8. Simpan sebagai UTF-8 lalu coba lagi.",
  },
  needs_ocr: {
    en: "This PDF is scanned, so it has no text to read. OCR is not available here, and nothing was sent anywhere.",
    id: "PDF ini hasil pindaian, jadi tidak ada teks yang bisa dibaca. OCR belum tersedia di sini, dan tidak ada yang dikirim ke mana pun.",
  },
  encrypted: {
    en: "That file is password protected. Remove the password and try again.",
    id: "Berkas itu dilindungi kata sandi. Hapus kata sandinya lalu coba lagi.",
  },
  unreadable: {
    en: "That file could not be read. It may be damaged.",
    id: "Berkas itu tidak bisa dibaca. Mungkin rusak.",
  },
  timeout: { en: "That file took too long to read.", id: "Berkas itu terlalu lama dibaca." },
};

/** The sentence the desk shows for a transcript file that was refused. Follows the desk locale. */
export function transcriptFileMessage(problem: TranscriptFileProblem, locale: AppLocale, max?: number): string {
  return TRANSCRIPT_FILE_PROBLEM[problem][parseAppLocale(locale)].replace("{max}", String(max ?? ""));
}

/** Translating needs minutes to translate. Follows the desk locale. */
export function minutesRequiredMessage(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "Write the minutes first, then translate them.",
    id: "Tulis notulen dulu, baru terjemahkan.",
  };
  return copy[parseAppLocale(locale)];
}

/** An edit named an item the minutes do not have. Follows the desk locale. */
export function itemNotFoundMessage(locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: "The minutes have no such item. Reload them and try again.",
    id: "Notulen tidak memiliki butir itu. Muat ulang lalu coba lagi.",
  };
  return copy[parseAppLocale(locale)];
}

/** A request for the minutes that is too long to send. Follows the desk locale. */
export function requestTooLongMessage(max: number, locale: AppLocale): string {
  const copy: Record<AppLocale, string> = {
    en: `What you asked for can be at most ${max} characters.`,
    id: `Permintaan Anda paling banyak ${max} karakter.`,
  };
  return copy[parseAppLocale(locale)];
}
