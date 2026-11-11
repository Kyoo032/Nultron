import { createHmac, randomBytes } from "node:crypto";

/**
 * The id a key's lessons are filed under: an HMAC of the key under this install's salt, cut to 16 hex
 * characters. Not the key, and not something a second install can match: the salt is random per
 * install and lives only beside the lessons. A blank key has no id (a stub desk learns nothing).
 */
export function availabilityKeyId(apiKey: string | undefined | null, salt: string): string | null {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed || !salt) {
    return null;
  }
  return `k_${createHmac("sha256", salt).update(trimmed, "utf8").digest("hex").slice(0, 16)}`;
}

export function newAvailabilitySalt(): string {
  return randomBytes(16).toString("hex");
}
