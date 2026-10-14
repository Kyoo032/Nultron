import { isEnvelope, openPayload, sealPayload } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";

/** A card description or comment body at rest: the envelope as JSON, like message bodies (`threads.ts`). */
export function sealBoardText(text: string): string {
  return JSON.stringify(sealPayload(text, getLocalVaultKey()));
}

/**
 * The text back, or the empty string. Never the stored value itself: a row that will not open (a wrap
 * key rotated without it, a hand edit) must not put ciphertext or a plaintext guess on a card.
 */
export function openBoardText(stored: string | null): string {
  if (!stored) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isEnvelope(parsed)) {
      return "";
    }
    const text = openPayload<unknown>(parsed, getLocalVaultKey());
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}
