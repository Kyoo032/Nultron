/**
 * What the runner may print or store about words. A caption, a transcript or a saved message is the
 * desk owner's speech: by default only its length and a short hash leave this module, so two runs can be
 * compared ("the same words came back") without the words being anywhere. `--show-text` turns that off.
 */
import { createHash } from "node:crypto";

export type TextPolicy = { readonly showText: boolean };

/** First 8 hex digits of the SHA-256 of the normalised text. Enough to tell two replies apart. */
export function shortHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 8);
}

/** The text as it may appear in output: `"..."` with `--show-text`, else `12 chars #a1b2c3d4`. */
export function describeText(text: string, policy: TextPolicy): string {
  return policy.showText ? JSON.stringify(text) : `${text.length} chars #${shortHash(text)}`;
}

/** Lower case, one space between words, no punctuation, so "Halo, apa kabar?" and "halo apa kabar" are alike. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((word) => word.length >= 3);
}

/**
 * The share of the expected text's words (three letters or more) that the actual text also holds, 0 to 1.
 * The speech model hears short speech roughly ("Stop, tunggu dulu." came back as "Tunggu dulu."), so a
 * caption "carries" a clip when at least half of its words are there, never on an exact match.
 */
export function wordOverlap(actual: string, expected: string): number {
  const wanted = words(expected);
  if (wanted.length === 0) {
    return 1;
  }
  const have = new Set(words(actual));
  return wanted.filter((word) => have.has(word)).length / wanted.length;
}

export const CAPTION_MATCH_MIN = 0.5;

export function carriesText(actual: string, expected: string): boolean {
  return wordOverlap(actual, expected) >= CAPTION_MATCH_MIN;
}
