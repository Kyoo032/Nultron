#!/usr/bin/env node
/**
 * Authenticated backup encryption/decryption (SR-171, security spec S6).
 *
 * Replaces unauthenticated `openssl enc -aes-256-cbc` with chunked AES-256-GCM + scryptSync.
 * Each chunk binds its magic header, 64-bit chunk index, and final-chunk flag via GCM AAD so
 * ciphertext tampering, truncation, chunk reordering, or wrong passphrases fail verification.
 *
 * Usage:
 *   BACKUP_KEY=... node webapp-deploy/scripts/aead-crypt.mjs encrypt [--in <file>] [--out <file>]
 *   BACKUP_KEY=... node webapp-deploy/scripts/aead-crypt.mjs decrypt [--in <file>] [--out <file>]
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAGIC = Buffer.from("NAEAD001", "ascii");
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const CHUNK_SIZE = 64 * 1024;
const FRAME_HEADER_BYTES = IV_BYTES + 1 + 4;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("BACKUP_KEY must be a non-empty passphrase");
  }
  return scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

function chunkAad(index, flags) {
  const aad = Buffer.alloc(MAGIC.length + 8 + 1);
  MAGIC.copy(aad, 0);
  aad.writeBigUInt64BE(BigInt(index), MAGIC.length);
  aad.writeUInt8(flags, MAGIC.length + 8);
  return aad;
}

function sealChunk(key, index, flags, plaintextChunk) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(chunkAad(index, flags));
  const ct = Buffer.concat([cipher.update(plaintextChunk), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  iv.copy(header, 0);
  header.writeUInt8(flags, IV_BYTES);
  header.writeUInt32BE(ct.length, IV_BYTES + 1);
  return Buffer.concat([header, ct, tag]);
}

function openChunk(key, index, flags, iv, ct, tag) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(chunkAad(index, flags));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt an in-memory Buffer using chunked AES-256-GCM. */
export function encryptBuffer(plaintext, passphrase) {
  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(passphrase, salt);
  const parts = [MAGIC, salt];
  if (input.length === 0) {
    parts.push(sealChunk(key, 0, 1, Buffer.alloc(0)));
    return Buffer.concat(parts);
  }
  let index = 0;
  for (let offset = 0; offset < input.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, input.length);
    const isFinal = end >= input.length ? 1 : 0;
    parts.push(sealChunk(key, index, isFinal, input.subarray(offset, end)));
    index += 1;
  }
  return Buffer.concat(parts);
}

/** Decrypt an in-memory Buffer sealed by `encryptBuffer`, throwing on any tampering or truncation. */
export function decryptBuffer(encrypted, passphrase) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  const headerLen = MAGIC.length + SALT_BYTES;
  if (buf.length < headerLen) {
    throw new Error("AEAD payload is truncated (missing header)");
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("AEAD payload has invalid magic header");
  }
  const salt = buf.subarray(MAGIC.length, headerLen);
  const key = deriveKey(passphrase, salt);

  const out = [];
  let offset = headerLen;
  let index = 0;
  let sawFinal = false;

  while (offset < buf.length) {
    if (sawFinal) {
      throw new Error("AEAD payload contains trailing data after final chunk");
    }
    if (offset + FRAME_HEADER_BYTES > buf.length) {
      throw new Error("AEAD payload is truncated (incomplete frame header)");
    }
    const iv = buf.subarray(offset, offset + IV_BYTES);
    const flags = buf.readUInt8(offset + IV_BYTES);
    const ctLen = buf.readUInt32BE(offset + IV_BYTES + 1);
    offset += FRAME_HEADER_BYTES;

    if (flags !== 0 && flags !== 1) {
      throw new Error("AEAD frame has invalid flags");
    }
    if (ctLen > CHUNK_SIZE) {
      throw new Error("AEAD frame exceeds maximum chunk size");
    }
    if (offset + ctLen + TAG_BYTES > buf.length) {
      throw new Error("AEAD payload is truncated (incomplete frame body or tag)");
    }
    const ct = buf.subarray(offset, offset + ctLen);
    const tag = buf.subarray(offset + ctLen, offset + ctLen + TAG_BYTES);
    offset += ctLen + TAG_BYTES;

    out.push(openChunk(key, index, flags, iv, ct, tag));
    index += 1;
    if (flags === 1) {
      sawFinal = true;
    }
  }

  if (!sawFinal) {
    throw new Error("AEAD payload is truncated (missing final chunk)");
  }
  return Buffer.concat(out);
}

async function writeChunk(stream, data) {
  if (data.length === 0) {
    return;
  }
  if (!stream.write(data)) {
    await new Promise((resolveWrite, rejectWrite) => {
      stream.once("drain", resolveWrite);
      stream.once("error", rejectWrite);
    });
  }
}

/** Stream-encrypt `input` into `output` in constant memory. */
export async function encryptStream(input, output, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(passphrase, salt);
  await writeChunk(output, Buffer.concat([MAGIC, salt]));

  let pending = Buffer.alloc(0);
  let index = 0;

  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length === 0) {
      continue;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length > CHUNK_SIZE) {
      const slice = pending.subarray(0, CHUNK_SIZE);
      pending = pending.subarray(CHUNK_SIZE);
      await writeChunk(output, sealChunk(key, index, 0, slice));
      index += 1;
    }
  }

  await writeChunk(output, sealChunk(key, index, 1, pending));
}

/** Stream-decrypt `input` into `output`, verifying every chunk's auth tag and completeness. */
export async function decryptStream(input, output, passphrase) {
  const headerLen = MAGIC.length + SALT_BYTES;
  let buf = Buffer.alloc(0);
  let key = null;
  let index = 0;
  let sawFinal = false;

  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length === 0) {
      continue;
    }
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    if (!key) {
      if (buf.length < headerLen) {
        continue;
      }
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error("AEAD payload has invalid magic header");
      }
      const salt = buf.subarray(MAGIC.length, headerLen);
      key = deriveKey(passphrase, salt);
      buf = buf.subarray(headerLen);
    }

    while (buf.length >= FRAME_HEADER_BYTES) {
      if (sawFinal) {
        throw new Error("AEAD payload contains trailing data after final chunk");
      }
      const flags = buf.readUInt8(IV_BYTES);
      const ctLen = buf.readUInt32BE(IV_BYTES + 1);
      if (flags !== 0 && flags !== 1) {
        throw new Error("AEAD frame has invalid flags");
      }
      if (ctLen > CHUNK_SIZE) {
        throw new Error("AEAD frame exceeds maximum chunk size");
      }
      const frameLen = FRAME_HEADER_BYTES + ctLen + TAG_BYTES;
      if (buf.length < frameLen) {
        break;
      }
      const iv = buf.subarray(0, IV_BYTES);
      const ct = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + ctLen);
      const tag = buf.subarray(FRAME_HEADER_BYTES + ctLen, frameLen);
      buf = buf.subarray(frameLen);

      const plaintext = openChunk(key, index, flags, iv, ct, tag);
      await writeChunk(output, plaintext);
      index += 1;
      if (flags === 1) {
        sawFinal = true;
      }
    }

    if (sawFinal && buf.length > 0) {
      throw new Error("AEAD payload contains trailing data after final chunk");
    }
  }

  if (!key) {
    throw new Error("AEAD payload is truncated (missing header)");
  }
  if (!sawFinal || buf.length > 0) {
    throw new Error("AEAD payload is truncated (missing final chunk)");
  }
}

function parseCliArgs(argv) {
  const mode = argv[0];
  if (mode !== "encrypt" && mode !== "decrypt") {
    throw new Error("Usage: aead-crypt.mjs <encrypt|decrypt> [--in <path>] [--out <path>]");
  }
  let inPath = null;
  let outPath = null;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") {
      inPath = argv[++i] ?? null;
      if (!inPath) throw new Error("--in requires a file path");
    } else if (arg === "--out") {
      outPath = argv[++i] ?? null;
      if (!outPath) throw new Error("--out requires a file path");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode, inPath, outPath };
}

async function finishWritable(stream, closeOnFinish) {
  if (!closeOnFinish) {
    return;
  }
  await new Promise((resolveFinish, rejectFinish) => {
    stream.once("finish", resolveFinish);
    stream.once("error", rejectFinish);
    stream.end();
  });
}

async function runCli(argv) {
  const { mode, inPath, outPath } = parseCliArgs(argv);
  const passphrase = process.env.BACKUP_KEY ?? "";
  if (!passphrase) {
    throw new Error("BACKUP_KEY is empty");
  }
  const input = inPath ? createReadStream(inPath) : process.stdin;
  const output = outPath ? createWriteStream(outPath, { mode: 0o600 }) : process.stdout;
  try {
    if (mode === "encrypt") {
      await encryptStream(input, output, passphrase);
    } else {
      await decryptStream(input, output, passphrase);
    }
    await finishWritable(output, Boolean(outPath));
  } catch (error) {
    if (outPath) {
      output.destroy();
      try {
        rmSync(outPath, { force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
    throw error;
  }
}

const isEntry = process.argv[1] && basename(resolve(process.argv[1])) === basename(fileURLToPath(import.meta.url));
if (isEntry) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`aead-crypt: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
