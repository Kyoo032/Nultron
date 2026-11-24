import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

export type EncryptedEnvelope = {
  v: 1;
  alg: "aes-256-gcm";
  /** base64-encoded 12-byte IV/nonce */
  n: string;
  /** base64-encoded ciphertext */
  ct: string;
  /** base64-encoded 16-byte GCM auth tag */
  tag: string;
  /** Optional key identifier for dual-key / zero-downtime rotation */
  kid?: string;
};

export type EnvelopeOptions = {
  /** Optional GCM Additional Authenticated Data (UTF-8 string). */
  aad?: string;
  /** Optional key identifier stored on the envelope for key-ring selection. */
  kid?: string;
};

export type KeyRingEntry = {
  readonly kid?: string;
  readonly key: Buffer;
};

export type OpenWithKeysOptions = EnvelopeOptions & {
  /** Optional key ring entries; matching `kid` is tried before other candidates. */
  keyRing?: readonly KeyRingEntry[];
};

export function wrappingKeyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptJson(value: unknown, key: Buffer, options?: EnvelopeOptions): EncryptedEnvelope {
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (options?.aad !== undefined) {
    cipher.setAAD(Buffer.from(options.aad, "utf8"));
  }
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EncryptedEnvelope = {
    v: 1,
    alg: "aes-256-gcm",
    n: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
  if (options?.kid !== undefined) {
    envelope.kid = options.kid;
  }
  return envelope;
}

export function decryptJson<T>(envelope: EncryptedEnvelope, key: Buffer, options?: EnvelopeOptions): T {
  const iv = Buffer.from(envelope.n, "base64");
  const ct = Buffer.from(envelope.ct, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (options?.aad !== undefined) {
    decipher.setAAD(Buffer.from(options.aad, "utf8"));
  }
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    e["v"] === 1 &&
    e["alg"] === "aes-256-gcm" &&
    typeof e["n"] === "string" &&
    typeof e["ct"] === "string" &&
    typeof e["tag"] === "string" &&
    (e["kid"] === undefined || typeof e["kid"] === "string")
  );
}

export function sealPayload(value: unknown, key: Buffer, options?: EnvelopeOptions): EncryptedEnvelope {
  return encryptJson(value, key, options);
}

export function openPayload<T>(stored: unknown, key: Buffer, options?: EnvelopeOptions): T {
  if (isEnvelope(stored)) {
    return decryptJson<T>(stored, key, options);
  }
  return stored as T;
}

/**
 * Open a sealed payload (or pass through legacy plaintext) using a list of candidate keys.
 * If the envelope carries `kid` and a matching entry exists in `keyRing` (or `keys`), that key is
 * tried first, followed by the remaining candidate keys for zero-downtime key rotation.
 */
export function openPayloadWithKeys<T>(
  stored: unknown,
  keys: readonly (Buffer | KeyRingEntry)[],
  options?: OpenWithKeysOptions,
): T {
  if (!isEnvelope(stored)) {
    return stored as T;
  }

  const entries: KeyRingEntry[] = [
    ...(options?.keyRing ?? []),
    ...keys.map((entry) => (Buffer.isBuffer(entry) ? { key: entry } : entry)),
  ];

  const ordered: Buffer[] = [];
  if (stored.kid !== undefined) {
    for (const entry of entries) {
      if (entry.kid === stored.kid) {
        ordered.push(entry.key);
      }
    }
  }
  for (const entry of entries) {
    if (stored.kid === undefined || entry.kid !== stored.kid) {
      ordered.push(entry.key);
    }
  }

  let lastError: unknown;
  for (const key of ordered) {
    try {
      return decryptJson<T>(stored, key, options);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to decrypt envelope with any candidate key");
}
