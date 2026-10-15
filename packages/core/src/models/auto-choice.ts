export type AutoPick = "everyday" | "reasoning";

export type AutoReason = "attachment" | "long_context" | "wording_cue" | "default";

export type AutoInput = {
  typedText: string;
  attachmentCount: number;
  contextTokens: number;
  everydayWindow: number | null;
};

export type AutoDecision = { pick: AutoPick; reason: AutoReason };

export const AUTO_LIMITS = {
  LONG_CONTEXT_TOKENS: 32_000,
  WINDOW_FRACTION: 0.5,
  CHARS_PER_TOKEN: 4,
  TOKENS_PER_IMAGE: 1_000,
} as const;

export const WORDING_CUES = {
  en: Object.freeze([
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
  ]),
  id: Object.freeze([
    "analisis",
    "bandingkan",
    "perbandingan",
    "rencana",
    "strategi",
    "evaluasi",
    "kelebihan dan kekurangan",
    "langkah demi langkah",
    "penyebab utama",
  ]),
} as const;

const WORD_CHAR_CLASS = "\\p{L}\\p{N}_";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cuePattern = (term: string): RegExp => {
  const body = term
    .split(/[\s-]+/)
    .map(escapeRegExp)
    .join("[\\s-]+");
  return new RegExp(`(?<![${WORD_CHAR_CLASS}])${body}(?![${WORD_CHAR_CLASS}])`, "iu");
};

const WORDING_CUE_PATTERNS: readonly RegExp[] = Object.freeze([...WORDING_CUES.en, ...WORDING_CUES.id].map(cuePattern));

const wholeCount = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

const isLongContext = (contextTokens: number, everydayWindow: number | null): boolean => {
  if (contextTokens >= AUTO_LIMITS.LONG_CONTEXT_TOKENS) {
    return true;
  }
  if (everydayWindow === null || !Number.isFinite(everydayWindow) || everydayWindow <= 0) {
    return false;
  }
  return contextTokens >= everydayWindow * AUTO_LIMITS.WINDOW_FRACTION;
};

const hasWordingCue = (typedText: string): boolean => WORDING_CUE_PATTERNS.some((pattern) => pattern.test(typedText));

export function decideAuto(input: AutoInput): AutoDecision {
  if (input.attachmentCount > 0) {
    return { pick: "reasoning", reason: "attachment" };
  }
  if (isLongContext(input.contextTokens, input.everydayWindow)) {
    return { pick: "reasoning", reason: "long_context" };
  }
  if (hasWordingCue(input.typedText)) {
    return { pick: "reasoning", reason: "wording_cue" };
  }
  return { pick: "everyday", reason: "default" };
}

export function estimateContextTokens(texts: readonly string[], imageCount: number): number {
  const characters = texts.reduce((total, text) => total + text.length, 0);
  return Math.ceil(characters / AUTO_LIMITS.CHARS_PER_TOKEN) + wholeCount(imageCount) * AUTO_LIMITS.TOKENS_PER_IMAGE;
}
