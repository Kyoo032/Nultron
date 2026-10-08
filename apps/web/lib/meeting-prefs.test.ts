/**
 * What the Meeting desk remembers between visits: the language a meeting is usually held in, and whether
 * the minutes are always translated. Both are conveniences of one browser, never state a run depends on,
 * so a missing or throwing store must change nothing but the default.
 */
import { describe, expect, it } from "vitest";
import {
  readAlwaysTranslate,
  readMeetingLanguage,
  writeAlwaysTranslate,
  writeMeetingLanguage,
} from "./meeting-prefs";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const THROWS = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("the remembered spoken language", () => {
  it("is the desk's language until the owner picks one", () => {
    expect(readMeetingLanguage("id", memory())).toBe("id");
    expect(readMeetingLanguage("en", memory())).toBe("en");
  });

  it("is what the owner last picked, whatever the desk language is", () => {
    const store = memory();
    writeMeetingLanguage("id", store);
    expect(readMeetingLanguage("en", store)).toBe("id");
  });

  it("ignores a value that is not a language", () => {
    expect(readMeetingLanguage("en", memory({ "nultron-meeting-language": "fr" }))).toBe("en");
  });

  it("survives a store that is missing or throws", () => {
    expect(readMeetingLanguage("id", undefined)).toBe("id");
    expect(readMeetingLanguage("id", THROWS)).toBe("id");
    expect(() => writeMeetingLanguage("en", THROWS)).not.toThrow();
    expect(() => writeMeetingLanguage("en", undefined)).not.toThrow();
  });
});

describe("the remembered always-translate choice", () => {
  it("is off by default: translation is opt-in", () => {
    expect(readAlwaysTranslate(memory())).toBe(false);
    expect(readAlwaysTranslate(undefined)).toBe(false);
  });

  it("is on once chosen, and off again once unchosen", () => {
    const store = memory();
    writeAlwaysTranslate(true, store);
    expect(readAlwaysTranslate(store)).toBe(true);
    writeAlwaysTranslate(false, store);
    expect(readAlwaysTranslate(store)).toBe(false);
  });

  it("reads anything but the one value it writes as off", () => {
    expect(readAlwaysTranslate(memory({ "nultron-meeting-always-translate": "yes" }))).toBe(false);
  });

  it("survives a store that throws", () => {
    expect(readAlwaysTranslate(THROWS)).toBe(false);
    expect(() => writeAlwaysTranslate(true, THROWS)).not.toThrow();
  });
});
