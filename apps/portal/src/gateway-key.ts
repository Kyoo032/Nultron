/**
 * The write-only bearer key an operator issues for one user's assigned gateway endpoint
 * (DFIND-155): sealed at rest in `users.gateway_key_sealed` (migration 0018), opened only to emit
 * `gateway_key` in that user's `/auth/token` bodies.
 *
 * THE KEY. The portal's own AES-256-GCM envelope (the host's `encryptJson` idiom, copied, not
 * imported — rule 1). The wrapping key is HKDF-SHA256 over the signing key's PKCS#8 DER with an
 * empty salt and info `portal-gateway-key-v1`, 32 bytes: a purpose-separated key, so neither the
 * signing key itself nor any blob sealed for another purpose can open one of these. An ephemeral
 * dev signing key seals as well as a real one; a restart on a new ephemeral key simply opens
 * nothing, and the column is written again on the next `set-endpoint`.
 *
 * FAILURE IS A VALUE. `openGatewayKey` answers `null` for anything that does not open under this
 * key: a corrupt blob, a blob sealed by another portal or another signing key. The caller emits no
 * `gateway_key`, and the host fails closed to needs_key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { PortalKey } from "./jwt/keys";

const WRAP_INFO = "portal-gateway-key-v1";
const WRAP_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_VERSION = 1;

/** The key this portal seals and opens endpoint keys under. DER export, never the seed alone. */
export function gatewayKeyWrap(key: PortalKey): Buffer {
  const der = key.privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(hkdfSync("sha256", der, Buffer.alloc(0), WRAP_INFO, WRAP_BYTES));
}

type Envelope = { v: number; iv: string; tag: string; data: string };

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === PAYLOAD_VERSION &&
    typeof record.iv === "string" &&
    typeof record.tag === "string" &&
    typeof record.data === "string"
  );
}

/** `{"v":1,"iv","tag","data"}` — what `users.gateway_key_sealed` holds. */
export function sealGatewayKey(raw: string, key: PortalKey): string {
  const wrap = gatewayKeyWrap(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrap, iv);
  const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const envelope: Envelope = {
    v: PAYLOAD_VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

/** The raw key, or null for anything that does not open as one under this portal key. Never throws. */
export function openGatewayKey(sealed: string, key: PortalKey): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(sealed);
  } catch {
    return null;
  }
  if (!isEnvelope(envelope)) {
    return null;
  }
  try {
    const wrap = gatewayKeyWrap(key);
    const decipher = createDecipheriv("aes-256-gcm", wrap, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const data = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]);
    const raw = data.toString("utf8");
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
