import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { scanPii, type PiiFinding, type PiiKind } from "./pii";

export const PII_VAULT_HKDF_INFO = "nultron-pii-vault-v1";
const SEALED_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_BYTES = 32;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const VAULT_TOKEN_RE = /\[(?:email|phone|id|card|nik|npwp|account|name)#\d+\]/g;

export type PiiVaultAad = string | Uint8Array | { readonly tenantId?: string; readonly runId?: string };

export type PiiVaultOptions = {
  readonly key: string | Uint8Array;
  readonly aad?: PiiVaultAad;
};

export type PiiVaultMaskResult = {
  readonly masked: string;
  readonly sealedMap: string;
  /** Number of PII occurrences replaced in this call. */
  readonly count: number;
};

export interface PiiVault {
  mask(text: string): PiiVaultMaskResult;
  unmask(text: string, sealedMap: string): string;
}

function keyBytes(key: string | Uint8Array): Buffer {
  const buf = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (buf.length === 0) {
    throw new Error("PII vault key must not be empty");
  }
  return buf;
}

function deriveSubkey(masterKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, Buffer.alloc(0), Buffer.from(PII_VAULT_HKDF_INFO, "utf8"), SUBKEY_BYTES),
  );
}

function encodeAad(aad: PiiVaultAad | undefined): Buffer | null {
  if (aad === undefined) {
    return null;
  }
  if (typeof aad === "string") {
    return Buffer.from(aad, "utf8");
  }
  if (aad instanceof Uint8Array) {
    return Buffer.from(aad);
  }
  return Buffer.from(JSON.stringify({ tenantId: aad.tenantId ?? "", runId: aad.runId ?? "" }), "utf8");
}

function nonOverlappingLeftToRight(findings: ReadonlyArray<PiiFinding>): PiiFinding[] {
  if (findings.length <= 1) {
    return [...findings];
  }
  const sorted = [...findings].sort(
    (left, right) => left.index - right.index || right.match.length - left.match.length,
  );
  const kept: PiiFinding[] = [];
  let cursor = 0;
  for (const finding of sorted) {
    if (finding.index < cursor) {
      continue;
    }
    kept.push(finding);
    cursor = finding.index + finding.match.length;
  }
  return kept;
}

function sealMap(map: Readonly<Record<string, string>>, subkey: Buffer, aadBytes: Buffer | null): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subkey, iv);
  if (aadBytes) {
    cipher.setAAD(aadBytes);
  }
  const plaintext = Buffer.from(JSON.stringify(map), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEALED_VERSION}.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

function openMap(sealedMap: string, subkey: Buffer, aadBytes: Buffer | null): Record<string, string> {
  if (typeof sealedMap !== "string") {
    throw new Error("Invalid sealed PII map");
  }
  const parts = sealedMap.split(".");
  if (parts.length !== 4 || parts[0] !== SEALED_VERSION) {
    throw new Error("Invalid sealed PII map format");
  }
  const [, ivPart, ctPart, tagPart] = parts;
  if (!ivPart || !ctPart || !tagPart || !BASE64URL_RE.test(ivPart) || !BASE64URL_RE.test(ctPart) || !BASE64URL_RE.test(tagPart)) {
    throw new Error("Malformed sealed PII map encoding");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const ct = Buffer.from(ctPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Invalid sealed PII map envelope lengths");
  }
  const decipher = createDecipheriv("aes-256-gcm", subkey, iv);
  decipher.setAuthTag(tag);
  if (aadBytes) {
    decipher.setAAD(aadBytes);
  }
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid sealed PII map payload");
  }
  const entries: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [token, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Invalid sealed PII map entry");
    }
    entries[token] = value;
  }
  return entries;
}

/**
 * Creates a reversible AES-256-GCM PII tokenization vault using an HKDF-SHA256 subkey
 * (`info = "nultron-pii-vault-v1"`) and optional AAD binding (`tenantId` / `runId`).
 * Deterministic numbered tokens (`[email#1]`, `[name#1]`, `[nik#1]`, ...) remain stable across
 * calls on the same vault instance.
 */
export function createPiiVault(options: PiiVaultOptions): PiiVault {
  const subkey = deriveSubkey(keyBytes(options.key));
  const aadBytes = encodeAad(options.aad);
  const kindCounts = new Map<PiiKind, number>();
  const valueToToken = new Map<string, string>();
  const tokenToValue = new Map<string, string>();

  const tokenFor = (kind: PiiKind, original: string): string => {
    const lookupKey = `${kind}\u0000${original}`;
    const existing = valueToToken.get(lookupKey);
    if (existing) {
      return existing;
    }
    const next = (kindCounts.get(kind) ?? 0) + 1;
    kindCounts.set(kind, next);
    const token = `[${kind}#${next}]`;
    valueToToken.set(lookupKey, token);
    tokenToValue.set(token, original);
    return token;
  };

  return {
    mask(text: string): PiiVaultMaskResult {
      const spans = nonOverlappingLeftToRight(scanPii(text));
      if (spans.length === 0) {
        return {
          masked: text,
          sealedMap: sealMap(Object.fromEntries(tokenToValue), subkey, aadBytes),
          count: 0,
        };
      }
      let cursor = 0;
      let masked = "";
      for (const span of spans) {
        masked += text.slice(cursor, span.index);
        masked += tokenFor(span.kind, span.match);
        cursor = span.index + span.match.length;
      }
      masked += text.slice(cursor);
      return {
        masked,
        sealedMap: sealMap(Object.fromEntries(tokenToValue), subkey, aadBytes),
        count: spans.length,
      };
    },

    unmask(text: string, sealedMap: string): string {
      const map = openMap(sealedMap, subkey, aadBytes);
      if (!text) {
        return text;
      }
      return text.replace(VAULT_TOKEN_RE, (token) => (token in map ? (map[token] ?? token) : token));
    },
  };
}
