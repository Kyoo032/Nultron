import { decryptJson, isEnvelope, sealPayload } from "@agentforge/core";

/**
 * A desk file's text as the bytes the object store holds: the artifact envelope (AES-256-GCM under
 * the wrap key), serialised. The store only ever sees ciphertext, so a bucket or a disk image of the
 * object tree reads as noise.
 */
export function sealBody(text: string, key: Buffer): Uint8Array {
  return Buffer.from(JSON.stringify(sealPayload(text, key)), "utf8");
}

/**
 * The text inside a sealed object. Unlike an artifact's `open`, it never falls back to the stored
 * bytes: an object that is not our envelope is corruption, and handing it back as the file's text
 * would show a reader whatever was written there. Throws on anything else wrong (a different key, a
 * flipped bit), leaving the caller to say so without the cause.
 */
export function openBody(stored: Uint8Array, key: Buffer): string {
  const parsed: unknown = JSON.parse(Buffer.from(stored).toString("utf8"));
  if (!isEnvelope(parsed)) {
    throw new Error("not a sealed envelope");
  }
  const text = decryptJson<unknown>(parsed, key);
  if (typeof text !== "string") {
    throw new Error("sealed body is not text");
  }
  return text;
}
