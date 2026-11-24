import { isEnvelope, openPayload, sealPayload } from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";

/**
 * Seal one `knowledge_vectors.body` string at rest with the local AES-256-GCM vault key, serialized
 * as a JSON envelope so the TEXT column holds ciphertext instead of plaintext chunks.
 */
export function sealVectorBody(body: string): string {
  return JSON.stringify(sealPayload(body, getLocalVaultKey()));
}

/** True when `stored` is a serialized AES-256-GCM envelope produced by `sealVectorBody`. */
export function isSealedVectorBody(stored: string): boolean {
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
 * Open a `knowledge_vectors.body` value. Sealed envelopes are decrypted with the local vault key;
 * legacy plaintext rows (written before sealing or by direct SQL fixtures) are returned unchanged.
 */
export function openVectorBody(stored: string): string {
  if (!stored.startsWith("{")) {
    return stored;
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!isEnvelope(parsed)) {
      return stored;
    }
    const opened = openPayload<unknown>(parsed, getLocalVaultKey());
    return typeof opened === "string" ? opened : stored;
  } catch {
    return stored;
  }
}
