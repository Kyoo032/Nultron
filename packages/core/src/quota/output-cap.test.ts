import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { withOutputCap } from "./output-cap";

const CHAT = "https://gateway.example/v1/chat/completions";
const RESPONSES = "https://gateway.example/v1/responses";
const MESSAGES = "https://gateway.example/v1/messages";
const GEMINI = "https://gateway.example/v1beta/models/gemini-2.5-flash:generateContent?alt=sse";
const GEMINI_STREAM = "https://gateway.example/v1beta/models/gemini-2.5-flash:streamGenerateContent";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe("withOutputCap on OpenAI chat completions", () => {
  it("sets max_tokens when the body sets no cap", () => {
    expect(withOutputCap({ model: "m", messages: [] }, CHAT, 4096)).toEqual({
      model: "m",
      messages: [],
      max_tokens: 4096,
    });
  });

  it("keeps a smaller existing max_tokens and lowers a larger one", () => {
    expect(withOutputCap({ max_tokens: 1000 }, CHAT, 4096)).toEqual({ max_tokens: 1000 });
    expect(withOutputCap({ max_tokens: 9000 }, CHAT, 4096)).toEqual({ max_tokens: 4096 });
  });

  it("uses max_completion_tokens when that is the key the body already uses", () => {
    const capped = withOutputCap({ max_completion_tokens: 8000 }, CHAT, 4096);
    expect(capped).toEqual({ max_completion_tokens: 4096 });
    expect(capped).not.toHaveProperty("max_tokens");
  });

  it("applies the minimum to both keys when a body carries both", () => {
    expect(withOutputCap({ max_tokens: 9000, max_completion_tokens: 2000 }, CHAT, 4096)).toEqual({
      max_tokens: 4096,
      max_completion_tokens: 2000,
    });
  });

  it("overwrites an existing cap that is not a finite positive number", () => {
    for (const existing of ["lots", 0, -5, null, Number.NaN]) {
      expect(withOutputCap({ max_tokens: existing }, CHAT, 4096)).toEqual({ max_tokens: 4096 });
    }
  });

  it("matches the parsed path, so a trailing slash and a relative URL both resolve", () => {
    expect(withOutputCap({}, "https://gateway.example/v1/chat/completions/", 10)).toEqual({ max_tokens: 10 });
    expect(withOutputCap({}, "/v1/chat/completions", 10)).toEqual({ max_tokens: 10 });
  });
});

describe("withOutputCap on the other wires", () => {
  it("sets max_output_tokens on Responses and keeps a smaller one", () => {
    expect(withOutputCap({ input: "hi" }, RESPONSES, 4096)).toEqual({ input: "hi", max_output_tokens: 4096 });
    expect(withOutputCap({ max_output_tokens: 300 }, RESPONSES, 4096)).toEqual({ max_output_tokens: 300 });
  });

  it("sets max_tokens on Anthropic messages, which always needs one", () => {
    expect(withOutputCap({}, MESSAGES, 4096)).toEqual({ max_tokens: 4096 });
    expect(withOutputCap({ max_tokens: 1024 }, MESSAGES, 4096)).toEqual({ max_tokens: 1024 });
  });

  it("sets generationConfig.maxOutputTokens on Gemini, for generate and stream, keeping the other fields", () => {
    expect(withOutputCap({ contents: [], generationConfig: { temperature: 0.2 } }, GEMINI, 4096)).toEqual({
      contents: [],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });
    expect(withOutputCap({ generationConfig: { maxOutputTokens: 500 } }, GEMINI_STREAM, 4096)).toEqual({
      generationConfig: { maxOutputTokens: 500 },
    });
    expect(withOutputCap({ contents: [] }, GEMINI_STREAM, 4096)).toEqual({
      contents: [],
      generationConfig: { maxOutputTokens: 4096 },
    });
  });
});

describe("withOutputCap after a forced Messages cap of 16384", () => {
  it("lowers a forced 16384 to a smaller cap", () => {
    expect(withOutputCap({ max_tokens: 16384 }, MESSAGES, 4096)).toEqual({ max_tokens: 4096 });
    expect(withOutputCap({ max_tokens: 16384 }, CHAT, 4096)).toEqual({ max_tokens: 4096 });
    expect(withOutputCap({ max_output_tokens: 16384 }, RESPONSES, 4096)).toEqual({ max_output_tokens: 4096 });
  });

  it("keeps a forced 16384 when the cap is larger, so the cap never raises a limit", () => {
    expect(withOutputCap({ max_tokens: 16384 }, MESSAGES, 20_000)).toEqual({ max_tokens: 16384 });
  });

  it("lowers a forced Gemini maxOutputTokens of 16384 and keeps the other generation fields", () => {
    expect(
      withOutputCap({ contents: [], generationConfig: { maxOutputTokens: 16384, topP: 0.9 } }, GEMINI, 4096),
    ).toEqual({ contents: [], generationConfig: { maxOutputTokens: 4096, topP: 0.9 } });
  });

  it("never writes a value above the cap for any existing value", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10, max: 100_000 }),
          fc.double({ min: -1000, max: 100_000, noNaN: true }),
          fc.constantFrom(null, "16384", "lots", true),
        ),
        fc.integer({ min: 1, max: 100_000 }),
        (existing, cap) => {
          const result = withOutputCap({ max_tokens: existing }, MESSAGES, cap) as { max_tokens: number };
          const kept = typeof existing === "number" && Number.isFinite(existing) && existing > 0;
          expect(result.max_tokens).toBe(kept ? Math.min(existing as number, cap) : cap);
          expect(result.max_tokens).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("withOutputCap passes through what it does not recognise", () => {
  it("returns the same body for an unknown URL", () => {
    const body = { input: "x" };
    expect(withOutputCap(body, "https://gateway.example/v1/embeddings", 4096)).toBe(body);
  });

  it("returns a non-object body unchanged", () => {
    for (const body of ["text", [1, 2], null, 3]) {
      expect(withOutputCap(body, CHAT, 4096)).toBe(body);
    }
  });
});

describe("withOutputCap immutability", () => {
  it("never mutates a deep-frozen body and returns a new object", () => {
    const body = deepFreeze({ model: "m", max_tokens: 9000, nested: { keep: true } });
    const before = JSON.parse(JSON.stringify(body)) as unknown;
    const result = withOutputCap(body, CHAT, 4096);
    expect(result).not.toBe(body);
    expect(result).toEqual({ model: "m", max_tokens: 4096, nested: { keep: true } });
    expect(body).toEqual(before);
  });

  it("copies generationConfig rather than writing into the frozen one", () => {
    const body = deepFreeze({ contents: [], generationConfig: { temperature: 0.2 } });
    const before = JSON.parse(JSON.stringify(body)) as unknown;
    const result = withOutputCap(body, GEMINI, 4096);
    expect(result).toEqual({ contents: [], generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } });
    expect(body).toEqual(before);
  });
});

describe("withOutputCap cap validation", () => {
  it("refuses a cap that is not a positive integer", () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => withOutputCap({}, CHAT, cap)).toThrow(RangeError);
    }
  });
});
