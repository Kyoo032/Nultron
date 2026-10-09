/**
 * What the Meeting desk remembers in this browser between visits: the language meetings are usually held
 * in, and whether the minutes are always translated.
 *
 * Both are conveniences of one viewer, never state a run depends on, so a missing or throwing store
 * (a private window, blocked site data) changes nothing but the default. The store is a parameter so a test
 * can hand it a stub; the default is `window.localStorage`.
 */
import { isAppLocale, type AppLocale } from "@agentforge/core/locale";

const LANGUAGE_KEY = "nultron-meeting-language";
const TRANSLATE_KEY = "nultron-meeting-always-translate";

export type PrefStore = Pick<Storage, "getItem" | "setItem">;

function browserStore(): PrefStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function read(store: PrefStore | undefined, key: string): string | null {
  if (!store) {
    return null;
  }
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(store: PrefStore | undefined, key: string, value: string): void {
  if (!store) {
    return;
  }
  try {
    store.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice simply is not remembered.
  }
}

/** The language a meeting is usually spoken in: what the owner last picked, else the desk's language. */
export function readMeetingLanguage(deskLocale: AppLocale, store: PrefStore | undefined = browserStore()): AppLocale {
  const stored = read(store, LANGUAGE_KEY);
  return isAppLocale(stored) ? stored : deskLocale;
}

export function writeMeetingLanguage(locale: AppLocale, store: PrefStore | undefined = browserStore()): void {
  write(store, LANGUAGE_KEY, locale);
}

/** Whether a run also translates the minutes. Off until the owner turns it on: translation is opt-in. */
export function readAlwaysTranslate(store: PrefStore | undefined = browserStore()): boolean {
  return read(store, TRANSLATE_KEY) === "1";
}

export function writeAlwaysTranslate(value: boolean, store: PrefStore | undefined = browserStore()): void {
  write(store, TRANSLATE_KEY, value ? "1" : "0");
}
