/**
 * Sealing for `oidc_login_states.code_verifier_sealed`.
 *
 * The code verifier and the door parameters a callback needs back are kept server-side and
 * AES-256-GCM sealed (the same primitive the product's secrets use, borrowed as an idiom -- the
 * portal never imports it). The key is derived from the Ed25519 signing key exactly the way
 * `webSessionSecret` derives its HMAC key: Ed25519 signatures are deterministic, so signing a
 * fixed label yields the same 32-byte key across restarts and portal processes, and the secret
 * itself never leaves the key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PortalKey } from "../jwt/keys";

const KEY_LABEL = "portal-oidc-seal-v1";
const FORMAT = "v1";

function sealKey(key: PortalKey): Buffer {
  return createHash("sha256")
    .update(key.sign(Buffer.from(KEY_LABEL, "utf8")))
    .digest();
}

/** The sealed column value: `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealJson(key: PortalKey, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

/** `null` for anything that is not a well-formed envelope this portal sealed. */
export function unsealJson(key: PortalKey, sealed: string): unknown {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    return null;
  }
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const body = Buffer.from(parts[3], "base64url");
  if (iv.length !== 12 || tag.length !== 16 || body.length === 0 || body.length > 8192) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(key), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}
