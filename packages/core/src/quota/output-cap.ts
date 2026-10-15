const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
const RESPONSES_SUFFIX = "/responses";
const MESSAGES_SUFFIX = "/messages";
const GEMINI_SUFFIXES = [":generateContent", ":streamGenerateContent"] as const;
const CHAT_CAP_KEYS = ["max_tokens", "max_completion_tokens"] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCap(cap: number): void {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(`output cap must be a positive integer, got ${cap}`);
  }
}

function lowered(existing: unknown, cap: number): number {
  return typeof existing === "number" && Number.isFinite(existing) && existing > 0 ? Math.min(existing, cap) : cap;
}

function wirePath(url: string): string {
  return new URL(url, "http://wire.invalid").pathname.replace(/\/+$/, "");
}

function withChatCap(body: JsonRecord, cap: number): JsonRecord {
  const present = CHAT_CAP_KEYS.filter((key) => body[key] !== undefined);
  if (present.length === 0) {
    return { ...body, max_tokens: cap };
  }
  return { ...body, ...Object.fromEntries(present.map((key) => [key, lowered(body[key], cap)])) };
}

function withGeminiCap(body: JsonRecord, cap: number): JsonRecord {
  const config = isRecord(body.generationConfig) ? body.generationConfig : {};
  return {
    ...body,
    generationConfig: { ...config, maxOutputTokens: lowered(config.maxOutputTokens, cap) },
  };
}

export function withOutputCap(body: unknown, url: string, cap: number): unknown {
  assertCap(cap);
  if (!isRecord(body)) {
    return body;
  }
  const path = wirePath(url);
  if (path.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    return withChatCap(body, cap);
  }
  if (path.endsWith(RESPONSES_SUFFIX)) {
    return { ...body, max_output_tokens: lowered(body.max_output_tokens, cap) };
  }
  if (path.endsWith(MESSAGES_SUFFIX)) {
    return { ...body, max_tokens: lowered(body.max_tokens, cap) };
  }
  if (GEMINI_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return withGeminiCap(body, cap);
  }
  return body;
}
