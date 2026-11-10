import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredVoiceMode, voiceEnabled, writeStoredVoiceMode } from "./voice-settings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whether voice is offered", () => {
  it("is on only when the host says `voice.enabled` is true", () => {
    expect(voiceEnabled({ voice: { enabled: true, model: "qwen" } })).toBe(true);
  });

  it("is off when it says false", () => {
    expect(voiceEnabled({ voice: { enabled: false, model: null } })).toBe(false);
  });

  it("is off when the field is missing, as on a host without voice", () => {
    expect(voiceEnabled({})).toBe(false);
    expect(voiceEnabled(null)).toBe(false);
    expect(voiceEnabled(undefined)).toBe(false);
  });

  it("is off for a field that is the wrong shape, and for a truthy value that is not `true`", () => {
    expect(voiceEnabled({ voice: "yes" } as never)).toBe(false);
    expect(voiceEnabled({ voice: null } as never)).toBe(false);
    expect(voiceEnabled({ voice: { enabled: "true" } } as never)).toBe(false);
    expect(voiceEnabled({ voice: { enabled: 1 } } as never)).toBe(false);
  });
});

describe("the remembered talking mode", () => {
  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    return store;
  }

  it("is hands-free until the person chooses otherwise", () => {
    stubStorage();
    expect(readStoredVoiceMode()).toBe("hands_free");
  });

  it("remembers push-to-talk", () => {
    stubStorage();
    writeStoredVoiceMode("push_to_talk");
    expect(readStoredVoiceMode()).toBe("push_to_talk");
    writeStoredVoiceMode("hands_free");
    expect(readStoredVoiceMode()).toBe("hands_free");
  });

  it("ignores anything else that is stored", () => {
    stubStorage({ "nultron.voice.mode": "shouting" });
    expect(readStoredVoiceMode()).toBe("hands_free");
  });

  it("works with no storage at all, as in a private window that blocks it", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readStoredVoiceMode()).toBe("hands_free");
    expect(() => writeStoredVoiceMode("push_to_talk")).not.toThrow();
  });
});
