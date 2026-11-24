import { isEnvelope, openPayload, sealPayload } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";

/**
 * Seal one `threads.title` string at rest with the local AES-256-GCM vault key, serialized as a
 * JSON envelope so the TEXT column holds ciphertext instead of plaintext titles.
 */
export function sealThreadTitle(title: string): string {
  return JSON.stringify(sealPayload(title, getLocalVaultKey()));
}

/** True when `stored` is a serialized AES-256-GCM envelope produced by `sealThreadTitle`. */
export function isSealedThreadTitle(stored: string): boolean {
  if (!stored.startsWith("{")) {
    return false;
  }
  try {
    return isEnvelope(JSON.parse(stored) as unknown);
  } catch {
    return false;
  }
}

/**
 * Open a `threads.title` value. Sealed envelopes are decrypted with the local vault key; legacy
 * plaintext rows (written before sealing or by direct SQL fixtures) are returned unchanged.
 *
 * `getLocalVaultKey()` is resolved outside the decrypt catch so a server with a missing or weak
 * wrap key fails loudly rather than returning raw ciphertext JSON.
 */
export function openThreadTitle(stored: string): string {
  if (!stored.startsWith("{")) {
    return stored;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return stored;
  }
  if (!isEnvelope(parsed)) {
    return stored;
  }
  const key = getLocalVaultKey();
  try {
    const opened = openPayload<unknown>(parsed, key);
    return typeof opened === "string" ? opened : stored;
  } catch {
    return stored;
  }
}
