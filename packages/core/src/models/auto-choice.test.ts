import { describe, expect, it } from "vitest";
import { attachmentCountOf, typedTextOf } from "../security/injection-guard";
import { AUTO_LIMITS, decideAuto, estimateContextTokens, WORDING_CUES } from "./auto-choice";

const decide = (typedText: string, attachmentCount = 0, contextTokens = 10, everydayWindow: number | null = null) =>
  decideAuto({ typedText, attachmentCount, contextTokens, everydayWindow });

describe("WORDING_CUES", () => {
  it("holds the starter terms for English and Bahasa Indonesia", () => {
    expect(WORDING_CUES.en).toEqual([
      "analyze",
      "compare",
      "versus",
      "plan",
      "strategy",
      "roadmap",
      "trade-offs",
      "pros and cons",
      "evaluate",
      "audit",
      "step by step",
      "root cause",
      "forecast",
    ]);
    expect(WORDING_CUES.id).toEqual([
      "analisis",
      "bandingkan",
      "perbandingan",
      "rencana",
      "strategi",
      "evaluasi",
      "kelebihan dan kekurangan",
      "langkah demi langkah",
      "penyebab utama",
    ]);
  });
});

describe("decideAuto: wording cues", () => {
  it("picks Reasoning for an English comparison typed by the person", () => {
    expect(decide("compare these two options")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("picks Reasoning for the Bahasa Indonesia comparison wording", () => {
    expect(decide("bandingkan dua opsi ini")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("does not match a cue inside a longer word", () => {
    expect(decide("planet facts")).toEqual({ pick: "everyday", reason: "default" });
  });

  it("matches a cue on its own word in any letter case", () => {
    expect(decide("PLAN for the trip")).toEqual({ pick: "reasoning", reason: "wording_cue" });
    expect(decide("Kelebihan dan Kekurangan produk ini")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("matches a multi-word cue across a line break", () => {
    expect(decide("list the pros and\ncons")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("matches a hyphenated cue with a hyphen or a space", () => {
    expect(decide("list the trade-offs")).toEqual({ pick: "reasoning", reason: "wording_cue" });
    expect(decide("list the trade offs")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("matches every starter term in both locales", () => {
    for (const term of [...WORDING_CUES.en, ...WORDING_CUES.id]) {
      expect(decide(`please ${term} this`)).toEqual({ pick: "reasoning", reason: "wording_cue" });
    }
  });

  it("reads English and Bahasa Indonesia cues on one desk in the same run", () => {
    expect(decide("analyze the churn numbers")).toEqual({ pick: "reasoning", reason: "wording_cue" });
    expect(decide("analisis angka churn")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("gives the same answer on repeated calls with the same text", () => {
    expect(decide("compare")).toEqual({ pick: "reasoning", reason: "wording_cue" });
    expect(decide("compare")).toEqual({ pick: "reasoning", reason: "wording_cue" });
    expect(decide("compare")).toEqual({ pick: "reasoning", reason: "wording_cue" });
  });

  it("does not read a cue from an attached file's body", () => {
    const message = "summarize this\n\n--- a.txt ---\nplease compare X and Y";
    expect(
      decideAuto({
        typedText: typedTextOf(message),
        attachmentCount: 0,
        contextTokens: 10,
        everydayWindow: null,
      }),
    ).toEqual({ pick: "everyday", reason: "default" });
  });
});

describe("decideAuto: attachments", () => {
  it("picks Reasoning for one attachment", () => {
    expect(decide("hi", 1)).toEqual({ pick: "reasoning", reason: "attachment" });
  });

  it("counts an attached file from the message and gives the attachment reason", () => {
    const message = "summarize this\n\n--- a.txt ---\nplease compare X and Y";
    expect(
      decideAuto({
        typedText: typedTextOf(message),
        attachmentCount: attachmentCountOf(message),
        contextTokens: 10,
        everydayWindow: null,
      }),
    ).toEqual({ pick: "reasoning", reason: "attachment" });
  });

  it("gives the attachment reason before the cue and the long-context reasons", () => {
    expect(decide("compare these", 1)).toEqual({ pick: "reasoning", reason: "attachment" });
    expect(decide("hi", 1, 40000)).toEqual({ pick: "reasoning", reason: "attachment" });
  });
});

describe("decideAuto: long context", () => {
  it("picks Reasoning at the long-context token threshold", () => {
    expect(AUTO_LIMITS.LONG_CONTEXT_TOKENS).toBe(32000);
    expect(decide("hi", 0, 32000)).toEqual({ pick: "reasoning", reason: "long_context" });
  });

  it("stays Everyday one token below the long-context threshold", () => {
    expect(decide("hi", 0, 31999)).toEqual({ pick: "everyday", reason: "default" });
  });

  it("gives the long-context reason before the wording cue", () => {
    expect(decide("compare", 0, 40000)).toEqual({ pick: "reasoning", reason: "long_context" });
  });

  it("uses a fraction of a known Everyday window", () => {
    expect(decideAuto({ typedText: "hi", attachmentCount: 0, contextTokens: 4000, everydayWindow: 8000 })).toEqual({
      pick: "reasoning",
      reason: "long_context",
    });
    expect(decideAuto({ typedText: "hi", attachmentCount: 0, contextTokens: 3999, everydayWindow: 8000 })).toEqual({
      pick: "everyday",
      reason: "default",
    });
  });

  it("ignores the window when it is unknown", () => {
    expect(decideAuto({ typedText: "hi", attachmentCount: 0, contextTokens: 4000, everydayWindow: null })).toEqual({
      pick: "everyday",
      reason: "default",
    });
  });

  it("ignores a window that is not a positive finite number", () => {
    for (const everydayWindow of [0, -8000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideAuto({ typedText: "hi", attachmentCount: 0, contextTokens: 10, everydayWindow })).toEqual({
        pick: "everyday",
        reason: "default",
      });
    }
  });
});

describe("decideAuto: default", () => {
  it("picks Everyday for a plain greeting", () => {
    expect(decide("hi")).toEqual({ pick: "everyday", reason: "default" });
  });

  it("picks Everyday for empty typed text", () => {
    expect(decide("")).toEqual({ pick: "everyday", reason: "default" });
  });
});

describe("attachmentCountOf", () => {
  it("counts zero when there is no attachment block", () => {
    expect(attachmentCountOf("hello there")).toBe(0);
  });

  it("counts one attachment block after the typed text", () => {
    expect(attachmentCountOf("typed\n\n--- a.txt ---\nbody")).toBe(1);
  });

  it("counts an attachment block that starts the text", () => {
    expect(attachmentCountOf("--- a.txt ---\nbody")).toBe(1);
  });

  it("counts two attachment blocks", () => {
    expect(attachmentCountOf("typed\n\n--- a.txt ---\nbody\n\n--- b.txt ---\nmore")).toBe(2);
  });

  it("does not count a dashed phrase inside a line", () => {
    expect(attachmentCountOf("a --- b ---")).toBe(0);
  });
});

describe("estimateContextTokens", () => {
  it("is about one token per four characters, rounded up", () => {
    expect(estimateContextTokens(["abcd", "efgh"], 0)).toBe(2);
    expect(estimateContextTokens(["abcde"], 0)).toBe(2);
    expect(estimateContextTokens([], 0)).toBe(0);
  });

  it("adds a fixed amount per image", () => {
    expect(estimateContextTokens([], 2)).toBe(2000);
    expect(estimateContextTokens(["abcd"], 1)).toBe(1001);
  });

  it("treats a negative or NaN image count as none", () => {
    expect(estimateContextTokens(["abcd"], -3)).toBe(1);
    expect(estimateContextTokens(["abcd"], Number.NaN)).toBe(1);
  });
});
