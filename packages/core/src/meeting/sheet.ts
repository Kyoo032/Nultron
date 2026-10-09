import { parseAppLocale, type AppLocale } from "../locale";
import { minutesAgree } from "./agree";
import { emptyMinutesMessage, invalidMinutesMessage, translationRetryNote } from "./copy";
import { userEditedText } from "./edits";
import { markMinutesEvidence } from "./evidence";
import { guardMinutesGrounding } from "./ground";
import { guardMinutesNames } from "./guard";
import { meetingMinutesSchema, withoutMarks, type MeetingMinutes } from "./minutes";
import { translatePrompt } from "./prompts";

export class MeetingSheetError extends Error {
  readonly code: "invalid_minutes" | "generation_failed";

  constructor(code: "invalid_minutes" | "generation_failed", message: string) {
    super(message);
    this.name = "MeetingSheetError";
    this.code = code;
  }
}

/** The other language still disagrees after its one retry. The minutes themselves are already settled. */
export class MeetingTranslationError extends Error {
  readonly code = "translation_disagreed" as const;

  constructor() {
    super("translation_disagreed");
    this.name = "MeetingTranslationError";
  }
}

export type SettledMinutes = {
  minutes: MeetingMinutes;
  unverifiedNames: string[];
  replacedNames: number;
  clearedDates: number;
  replacedFigures: number;
};

function jsonObject(raw: string): string {
  let trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced?.[1]) {
    trimmed = fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no object");
  }
  return trimmed.slice(start, end + 1);
}

/**
 * Parse one model answer into the minutes sheet. A prose answer or the wrong shape throws. Whatever the model
 * sent under `evidence` or `edited` is dropped: those are the code's, set after the checks.
 */
export function parseMeetingMinutes(raw: string, locale: AppLocale): MeetingMinutes {
  const lang = parseAppLocale(locale);
  if (!raw.trim()) {
    throw new MeetingSheetError("generation_failed", emptyMinutesMessage(lang));
  }
  let jsonText: string;
  try {
    jsonText = jsonObject(raw);
  } catch {
    throw new MeetingSheetError("invalid_minutes", invalidMinutesMessage(lang));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new MeetingSheetError("invalid_minutes", invalidMinutesMessage(lang));
  }
  const result = meetingMinutesSchema.safeParse(withoutMarks(parsed));
  if (!result.success) {
    throw new MeetingSheetError("invalid_minutes", invalidMinutesMessage(lang));
  }
  return result.data;
}

/**
 * Names, then dates and figures, then the evidence marks, over minutes that already parsed. All of it is
 * code. None of it calls the model. The minutes call runs its checks and repair first
 * (`host/src/meeting/run.ts`); this is the last word on what the transcript does not support. `locale` is the
 * language the transcript was spoken in, which decides how an ambiguous date or a magnitude word is read.
 */
export function settleParsedMinutes(
  minutes: MeetingMinutes,
  transcript: string,
  locale: AppLocale = "en",
): SettledMinutes {
  const named = guardMinutesNames(minutes, transcript);
  const grounded = guardMinutesGrounding(named.minutes, transcript, locale);
  return {
    minutes: markMinutesEvidence(grounded.minutes, transcript, locale),
    unverifiedNames: named.unverified,
    replacedNames: named.replaced,
    clearedDates: grounded.clearedDates,
    replacedFigures: grounded.replacedFigures,
  };
}

/**
 * One model answer parsed into the sheet, then settled. A prose answer or the wrong shape throws. `locale` is
 * the language the failure message is in; `transcriptLocale` (default the same) is the transcript's.
 */
export function settleMinutes(
  raw: string,
  transcript: string,
  locale: AppLocale,
  transcriptLocale: AppLocale = locale,
): SettledMinutes {
  return settleParsedMinutes(parseMeetingMinutes(raw, locale), transcript, transcriptLocale);
}

function acceptTranslation(
  raw: string,
  evidence: string,
  source: MeetingMinutes,
  locale: AppLocale,
  transcriptLocale: AppLocale,
): SettledMinutes | null {
  let settled: SettledMinutes;
  try {
    settled = settleMinutes(raw, evidence, locale, transcriptLocale);
  } catch (error) {
    if (error instanceof MeetingSheetError) {
      return null;
    }
    throw error;
  }
  if (!minutesAgree(source, settled.minutes).ok) {
    return null;
  }
  return settled;
}

type Marked = { readonly evidence?: "verified" | "unverified" | undefined; readonly edited?: boolean | undefined };

/** `to` with the marks `from` carries. The translation's items line up with the source's, so each takes its own. */
function withMarksOf<T extends Marked>(from: Marked, to: T): T {
  const { evidence: _evidence, edited: _edited, ...rest } = to;
  return {
    ...rest,
    ...(from.evidence ? { evidence: from.evidence } : {}),
    ...(from.edited ? { edited: true } : {}),
  } as T;
}

/**
 * The translated sheet with the source's verdicts on it. The quotes came back unchanged (`minutesAgree`), and
 * so did the owners and the due dates, so the translated item is backed exactly as far as its source was, and
 * an item the owner edited is still marked edited.
 */
function withSourceMarks(source: MeetingMinutes, translated: SettledMinutes): SettledMinutes {
  return {
    ...translated,
    minutes: {
      ...translated.minutes,
      decisions: translated.minutes.decisions.map((item, at) => withMarksOf(source.decisions[at] ?? {}, item)),
      actionItems: translated.minutes.actionItems.map((item, at) => withMarksOf(source.actionItems[at] ?? {}, item)),
    },
  };
}

/**
 * One translation of the settled sheet, and a second only when the first is not the same sheet. A network
 * failure is not retried. After the second miss the minutes stay and the translation does not. The guards read
 * the transcript plus the owner's own edited words, so a name the owner typed is not taken for an invented one;
 * `transcriptLocale` defaults to the language the sheet was written in, the other one of the two.
 */
export async function translateMeetingSheet(input: {
  transcript: string;
  source: MeetingMinutes;
  locale: AppLocale;
  transcriptLocale?: AppLocale;
  ask: (prompt: string) => Promise<string>;
  onAttempt?: (attempt: 1 | 2) => void;
}): Promise<SettledMinutes> {
  const locale = parseAppLocale(input.locale);
  const transcriptLocale = input.transcriptLocale ?? (locale === "en" ? "id" : "en");
  const evidence = [input.transcript, userEditedText(input.source)].filter((part) => part !== "").join("\n");
  const prompt = translatePrompt(input.source, locale);
  input.onAttempt?.(1);
  const first = acceptTranslation(await input.ask(prompt), evidence, input.source, locale, transcriptLocale);
  if (first) {
    return withSourceMarks(input.source, first);
  }
  input.onAttempt?.(2);
  const second = settleMinutes(
    await input.ask(`${prompt}\n\n${translationRetryNote(locale)}`),
    evidence,
    locale,
    transcriptLocale,
  );
  if (!minutesAgree(input.source, second.minutes).ok) {
    throw new MeetingTranslationError();
  }
  return withSourceMarks(input.source, second);
}
