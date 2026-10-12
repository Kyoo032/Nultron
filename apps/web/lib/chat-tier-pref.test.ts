import { describe, expect, it } from "vitest";
import {
  CHAT_TIER_LAST_KEY,
  CHAT_TIER_THREAD_KEY,
  CHAT_TIER_THREAD_MAX,
  initialChatTier,
  pickChatTier,
  readLastChatTier,
  readThreadChatTier,
  readTierCatalog,
  tierStreamLimits,
  tierThinkingEnabled,
  writeLastChatTier,
  writeThreadChatTier,
  type ChatTierInfo,
} from "./chat-tier-pref";

function memoryStore(initial: Record<string, string> = {}): Storage {
  const data = { ...initial };
  return {
    get length() {
      return Object.keys(data).length;
    },
    clear() {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    },
    getItem(key: string) {
      return key in data ? data[key] : null;
    },
    key() {
      return null;
    },
    removeItem(key: string) {
      delete data[key];
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}

function tier(id: ChatTierInfo["id"], available = true): ChatTierInfo {
  return { id, available, inputModalities: ["text"], contextLength: null };
}

const ALL = [tier("daily"), tier("fast"), tier("reasoning")];
const NO_REASONING = [tier("daily"), tier("fast"), tier("reasoning", false)];

describe("storage keys", () => {
  it("are the two names the spec fixes", () => {
    expect(CHAT_TIER_LAST_KEY).toBe("agentforge-chat-tier");
    expect(CHAT_TIER_THREAD_KEY).toBe("agentforge-chat-thread-tiers");
    expect(CHAT_TIER_THREAD_MAX).toBe(80);
  });
});

describe("pickChatTier", () => {
  it("restores the thread's tier first", () => {
    expect(
      pickChatTier({ tiers: ALL, defaultTier: "daily", threadTier: "reasoning", current: "fast", lastTier: "fast" }),
    ).toBe("reasoning");
  });

  it("keeps the current tier when the thread has no memory", () => {
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily", current: "fast", lastTier: "reasoning" })).toBe("fast");
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily", current: "fast", threadTier: "" })).toBe("fast");
  });

  it("falls to the last choice, then to the default", () => {
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily", lastTier: "fast" })).toBe("fast");
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily" })).toBe("daily");
  });

  it("skips a candidate the host reports unavailable", () => {
    expect(
      pickChatTier({
        tiers: NO_REASONING,
        defaultTier: "daily",
        threadTier: "reasoning",
        current: "reasoning",
        lastTier: "fast",
      }),
    ).toBe("fast");
    expect(pickChatTier({ tiers: NO_REASONING, defaultTier: "daily", threadTier: "reasoning", current: "fast" })).toBe(
      "fast",
    );
  });

  it("skips a candidate the host did not list at all", () => {
    expect(
      pickChatTier({ tiers: [tier("daily")], defaultTier: "daily", threadTier: "fast", lastTier: "reasoning" }),
    ).toBe("daily");
  });

  it("ignores any value that is not a tier id", () => {
    expect(
      pickChatTier({
        tiers: ALL,
        defaultTier: "daily",
        threadTier: "gpt-6-astra",
        current: "Fast",
        lastTier: "__proto__",
      }),
    ).toBe("daily");
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily", current: "constructor" })).toBe("daily");
  });

  it("returns the default when nothing is available, so the host can say why", () => {
    const none = [tier("daily", false), tier("fast", false), tier("reasoning", false)];
    expect(pickChatTier({ tiers: none, defaultTier: "daily", threadTier: "fast", current: "reasoning" })).toBe("daily");
    expect(pickChatTier({ tiers: [], defaultTier: "daily", current: "fast" })).toBe("daily");
  });

  it("reads a default that is not a tier id as Daily", () => {
    expect(pickChatTier({ tiers: ALL, defaultTier: "nonsense" })).toBe("daily");
    expect(pickChatTier({ tiers: ALL })).toBe("daily");
  });
});

describe("initialChatTier", () => {
  it("starts a pane on the open thread's tier, then the last choice, then Daily", () => {
    const storage = memoryStore();
    expect(initialChatTier(undefined, storage)).toBe("daily");
    writeLastChatTier("fast", storage);
    expect(initialChatTier(undefined, storage)).toBe("fast");
    expect(initialChatTier("thread-without-memory", storage)).toBe("fast");
    writeThreadChatTier("thread-a", "reasoning", storage);
    expect(initialChatTier("thread-a", storage)).toBe("reasoning");
    expect(initialChatTier("", storage)).toBe("fast");
  });

  it("is what lets the last choice seed a new pane: pickChatTier ranks the tier on screen above it", () => {
    const storage = memoryStore();
    writeLastChatTier("fast", storage);
    const shown = initialChatTier(undefined, storage);
    expect(
      pickChatTier({ tiers: ALL, defaultTier: "daily", current: shown, lastTier: readLastChatTier(storage) }),
    ).toBe("fast");
    // A pane that began on Daily instead would keep it, and never read the last choice.
    expect(pickChatTier({ tiers: ALL, defaultTier: "daily", current: "daily", lastTier: "fast" })).toBe("daily");
  });

  it("ignores a stored value that is not a tier id", () => {
    const storage = memoryStore({
      "agentforge-chat-tier": "claude-opus-5-5",
      "agentforge-chat-thread-tiers": JSON.stringify({ "thread-a": "kimi-k3" }),
    });
    expect(initialChatTier("thread-a", storage)).toBe("daily");
  });

  it("survives a storage that throws, as in private mode", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {},
    };
    expect(initialChatTier("thread-a", hostile)).toBe("daily");
    expect(initialChatTier(undefined, undefined)).toBe("daily");
  });
});

describe("last choice", () => {
  it("round-trips", () => {
    const storage = memoryStore();
    writeLastChatTier("reasoning", storage);
    expect(readLastChatTier(storage)).toBe("reasoning");
    expect(storage.getItem("agentforge-chat-tier")).toBe("reasoning");
  });

  it("reads nothing for a missing or foreign value, and refuses to write one", () => {
    const storage = memoryStore();
    expect(readLastChatTier(storage)).toBe("");
    storage.setItem("agentforge-chat-tier", "claude-opus-5-5");
    expect(readLastChatTier(storage)).toBe("");
    writeLastChatTier("gpt-6-astra" as never, storage);
    writeLastChatTier("" as never, storage);
    expect(storage.getItem("agentforge-chat-tier")).toBe("claude-opus-5-5");
  });

  it("does nothing without storage", () => {
    expect(readLastChatTier(undefined)).toBe("");
    expect(() => writeLastChatTier("fast", undefined)).not.toThrow();
  });

  it("survives a storage that throws, as in private mode", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readLastChatTier(hostile)).toBe("");
    expect(() => writeLastChatTier("fast", hostile)).not.toThrow();
    expect(readThreadChatTier("a", hostile)).toBe("");
    expect(() => writeThreadChatTier("a", "fast", hostile)).not.toThrow();
  });
});

describe("per-thread choice", () => {
  it("remembers each thread on its own", () => {
    const storage = memoryStore();
    writeThreadChatTier("thread-a", "fast", storage);
    writeThreadChatTier("thread-b", "reasoning", storage);
    expect(readThreadChatTier("thread-a", storage)).toBe("fast");
    expect(readThreadChatTier("thread-b", storage)).toBe("reasoning");
    expect(readThreadChatTier("thread-missing", storage)).toBe("");
  });

  it("overwrites a thread's tier and ignores empty ids and foreign values", () => {
    const storage = memoryStore();
    writeThreadChatTier("thread-a", "fast", storage);
    writeThreadChatTier("thread-a", "reasoning", storage);
    writeThreadChatTier("", "daily", storage);
    writeThreadChatTier("  ", "daily", storage);
    writeThreadChatTier("thread-a", "kimi-k3" as never, storage);
    expect(readThreadChatTier("thread-a", storage)).toBe("reasoning");
    expect(Object.keys(JSON.parse(storage.getItem("agentforge-chat-thread-tiers") ?? "{}"))).toEqual(["thread-a"]);
  });

  it("returns nothing when the stored map is damaged or is not a map", () => {
    const storage = memoryStore({ "agentforge-chat-thread-tiers": "[1]" });
    expect(readThreadChatTier("thread-a", storage)).toBe("");
    storage.setItem("agentforge-chat-thread-tiers", "{not-json");
    expect(readThreadChatTier("thread-a", storage)).toBe("");
    storage.setItem("agentforge-chat-thread-tiers", "null");
    expect(readThreadChatTier("thread-a", storage)).toBe("");
  });

  it("ignores a stored entry that is not a tier id", () => {
    const storage = memoryStore({
      "agentforge-chat-thread-tiers": JSON.stringify({ "thread-a": "gpt-6-astra", "thread-b": "fast", "thread-c": 4 }),
    });
    expect(readThreadChatTier("thread-a", storage)).toBe("");
    expect(readThreadChatTier("thread-b", storage)).toBe("fast");
    expect(readThreadChatTier("thread-c", storage)).toBe("");
  });

  it("drops damaged entries when it writes, keeping the good ones", () => {
    const storage = memoryStore({
      "agentforge-chat-thread-tiers": JSON.stringify({ "thread-a": "gpt-6-astra", "thread-b": "fast" }),
    });
    writeThreadChatTier("thread-c", "daily", storage);
    expect(JSON.parse(storage.getItem("agentforge-chat-thread-tiers") ?? "{}")).toEqual({
      "thread-b": "fast",
      "thread-c": "daily",
    });
  });

  it("never reads a prototype property as a thread's tier", () => {
    const storage = memoryStore();
    writeThreadChatTier("thread-a", "fast", storage);
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(readThreadChatTier(id, storage)).toBe("");
    }
  });

  it("can hold a thread named __proto__ without polluting anything", () => {
    const storage = memoryStore();
    writeThreadChatTier("__proto__", "reasoning", storage);
    expect(readThreadChatTier("__proto__", storage)).toBe("reasoning");
    expect(({} as Record<string, unknown>).reasoning).toBeUndefined();
  });

  it("keeps at most 80 threads and forgets the oldest first", () => {
    const storage = memoryStore();
    for (let i = 0; i < 85; i += 1) {
      writeThreadChatTier(`thread-${i}`, "fast", storage);
    }
    const stored = JSON.parse(storage.getItem("agentforge-chat-thread-tiers") ?? "{}") as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(80);
    expect(readThreadChatTier("thread-0", storage)).toBe("");
    expect(readThreadChatTier("thread-4", storage)).toBe("");
    expect(readThreadChatTier("thread-5", storage)).toBe("fast");
    expect(readThreadChatTier("thread-84", storage)).toBe("fast");
  });

  it("counts a rewrite as the newest use, so an active old thread is not the one forgotten", () => {
    const storage = memoryStore();
    for (let i = 0; i < 80; i += 1) {
      writeThreadChatTier(`thread-${i}`, "fast", storage);
    }
    writeThreadChatTier("thread-0", "reasoning", storage);
    writeThreadChatTier("thread-new", "daily", storage);
    expect(readThreadChatTier("thread-0", storage)).toBe("reasoning");
    expect(readThreadChatTier("thread-1", storage)).toBe("");
    expect(readThreadChatTier("thread-new", storage)).toBe("daily");
  });
});

describe("readTierCatalog", () => {
  it("reads the wire the host sends", () => {
    const catalog = readTierCatalog({
      tiers: [
        { id: "daily", available: true, inputModalities: ["text", "image"], contextLength: 200000 },
        { id: "fast", available: true, inputModalities: ["text"], contextLength: null },
        { id: "reasoning", available: false, inputModalities: ["text"], contextLength: null },
      ],
      defaultTier: "daily",
      models: [{ id: "model-a" }],
    });
    expect(catalog.defaultTier).toBe("daily");
    expect(catalog.tiers.map((item) => [item.id, item.available])).toEqual([
      ["daily", true],
      ["fast", true],
      ["reasoning", false],
    ]);
    expect(catalog.tiers[0]).toEqual({
      id: "daily",
      available: true,
      inputModalities: ["text", "image"],
      contextLength: 200000,
    });
    expect(catalog.tiers[1]?.contextLength).toBeNull();
  });

  it("drops an entry with an unknown id, a repeated id and a non-object, and keeps the spec's order", () => {
    const catalog = readTierCatalog({
      tiers: [
        { id: "reasoning", available: true },
        null,
        "fast",
        { id: "turbo", available: true },
        { id: "daily", available: true },
        { id: "daily", available: false },
      ],
    });
    expect(catalog.tiers.map((item) => [item.id, item.available])).toEqual([
      ["daily", true],
      ["reasoning", true],
    ]);
  });

  it("reads a missing or malformed field as the safe value", () => {
    const catalog = readTierCatalog({
      tiers: [
        { id: "daily" },
        { id: "fast", available: "yes", inputModalities: "text", contextLength: "big" },
        { id: "reasoning", available: true, inputModalities: ["text", 4, "audio"], contextLength: -5 },
      ],
    });
    expect(catalog.tiers).toEqual([
      { id: "daily", available: false, inputModalities: ["text"], contextLength: null },
      { id: "fast", available: false, inputModalities: ["text"], contextLength: null },
      { id: "reasoning", available: true, inputModalities: ["text"], contextLength: null },
    ]);
  });

  it("always offers text, even when the host leaves it out", () => {
    const catalog = readTierCatalog({ tiers: [{ id: "daily", available: true, inputModalities: ["image"] }] });
    expect(catalog.tiers[0]?.inputModalities).toEqual(["text", "image"]);
  });

  it("says nothing is on offer for a payload without tiers, and defaults to Daily", () => {
    for (const payload of [undefined, null, 5, "x", {}, { tiers: "daily" }, { error: { code: "x" } }]) {
      expect(readTierCatalog(payload)).toEqual({ tiers: [], defaultTier: "daily" });
    }
  });

  it("reads a default that is not a tier id as Daily", () => {
    expect(readTierCatalog({ tiers: [], defaultTier: "gpt-6" }).defaultTier).toBe("daily");
    expect(readTierCatalog({ tiers: [], defaultTier: "fast" }).defaultTier).toBe("fast");
  });
});

describe("what a tier means to the pane", () => {
  it("shows the Thinking row for every tier but Fastest, which runs with Thinking off", () => {
    expect(tierThinkingEnabled("daily")).toBe(true);
    expect(tierThinkingEnabled("reasoning")).toBe(true);
    expect(tierThinkingEnabled("fast")).toBe(false);
  });

  it("gives Daily and Reasoning the long stream budget, because the renderer does not know the model", () => {
    expect(tierStreamLimits("reasoning")).toEqual({ ttfbMs: 240_000, idleMs: 180_000 });
    expect(tierStreamLimits("daily")).toEqual({ ttfbMs: 240_000, idleMs: 180_000 });
    expect(tierStreamLimits("fast")).toBeUndefined();
  });
});
