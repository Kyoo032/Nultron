export const APP_LOCALES = ["en", "id"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = "en";

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "id";
}

/** Unknown or missing values become English. Do not treat a typo as Indonesian. */
export function parseAppLocale(value: unknown): AppLocale {
  return isAppLocale(value) ? value : DEFAULT_APP_LOCALE;
}

/** Browsers send well under 200 characters; anything past this is not read, so a hostile header is cheap. */
const ACCEPT_LANGUAGE_MAX_LENGTH = 1024;

/** A language tag shaped like BCP 47: a primary subtag, then optional `-`-joined subtags. `*` is not one. */
const LANGUAGE_TAG = /^([a-z]{1,8})(?:-[a-z0-9]{1,8})*$/;

/** `q=0`, `q=0.8`, `q=1`, `q=1.000`, `q=.5`. Sign, exponent, `NaN` and `Infinity` do not match. */
const QUALITY_PARAMETER = /^q=(\d+(?:\.\d*)?|\.\d+)$/;

/** The primary subtags this app serves. `in` is the legacy ISO 639 code for Indonesian. */
const SERVED_PRIMARY_SUBTAGS: ReadonlyMap<string, AppLocale> = new Map<string, AppLocale>([
  ["id", "id"],
  ["in", "id"],
  ["en", "en"],
]);

/**
 * The weight an entry's parameters give it: `1` when it carries no `q`, the value when it carries a
 * readable one in 0..1, and `null` when the `q` is malformed or out of range, so that entry is dropped
 * rather than guessed at. Other parameters (`level=1`) are ignored.
 */
function weightOf(parameters: readonly string[]): number | null {
  for (const parameter of parameters) {
    const compact = parameter.replace(/\s+/g, "").toLowerCase();
    if (!compact.startsWith("q=")) {
      continue;
    }
    const match = QUALITY_PARAMETER.exec(compact);
    if (!match) {
      return null;
    }
    const weight = Number(match[1]);
    return weight <= 1 ? weight : null;
  }
  return 1;
}

/**
 * The language an `Accept-Language` header asks for, among the ones this app serves, or `null` when it
 * names none of them (or is empty, missing, not a string, or garbage).
 *
 * Highest weight wins, and a tie goes to the tag listed first, as the header's own order says. `q=0`
 * means "not acceptable" and never wins. `id`, `id-*` and the legacy `in` are Indonesian; `en` and
 * `en-*` are English; every other tag is skipped, so `fr, id;q=0.5` is Indonesian. `null` is "no
 * opinion", which is not the same as English: the caller decides what no opinion falls back to.
 *
 * Pure and bounded: only the first {@link ACCEPT_LANGUAGE_MAX_LENGTH} characters are read.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): AppLocale | null {
  if (typeof header !== "string") {
    return null;
  }
  let best: AppLocale | null = null;
  let bestWeight = 0;
  for (const entry of header.slice(0, ACCEPT_LANGUAGE_MAX_LENGTH).split(",")) {
    const [rawTag = "", ...parameters] = entry.split(";");
    const tag = LANGUAGE_TAG.exec(rawTag.trim().toLowerCase());
    const locale = tag?.[1] ? SERVED_PRIMARY_SUBTAGS.get(tag[1]) : undefined;
    if (!locale) {
      continue;
    }
    const weight = weightOf(parameters);
    if (weight !== null && weight > bestWeight) {
      best = locale;
      bestWeight = weight;
    }
  }
  return best;
}
