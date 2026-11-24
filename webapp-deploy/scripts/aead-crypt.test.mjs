import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHUNK_SIZE,
  MAGIC,
  SALT_BYTES,
  decryptBuffer,
  decryptStream,
  encryptBuffer,
  encryptStream,
} from "./aead-crypt.mjs";

const SCRIPT = fileURLToPath(new URL("./aead-crypt.mjs", import.meta.url));
const KEY = "correct-horse-battery-staple-backup-key";
const WRONG_KEY = "wrong-horse-battery-staple-backup-key";

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("aead-crypt (AES-256-GCM authenticated backup encryption)", () => {
  it("round-trips empty, small, and multi-chunk payloads", () => {
    for (const sample of [
      Buffer.alloc(0),
      Buffer.from("hello nultron backup\n", "utf8"),
      Buffer.alloc(CHUNK_SIZE * 2 + 123, 0x5a),
    ]) {
      const sealed = encryptBuffer(sample, KEY);
      assert.equal(sealed.subarray(0, MAGIC.length).equals(MAGIC), true);
      const opened = decryptBuffer(sealed, KEY);
      assert.equal(opened.equals(sample), true);
    }
  });

  it("rejects decryption with the wrong passphrase", () => {
    const sealed = encryptBuffer(Buffer.from("sensitive sqlite dump"), KEY);
    assert.throws(() => decryptBuffer(sealed, WRONG_KEY));
  });

  it("detects any byte-level tampering (ciphertext, tag, iv, flags, magic, salt)", () => {
    const sealed = encryptBuffer(Buffer.from("backup archive bytes 12345"), KEY);
    // Flip a byte in the auth tag (very end)
    const tamperedTag = Buffer.from(sealed);
    tamperedTag[tamperedTag.length - 1] ^= 0xff;
    assert.throws(() => decryptBuffer(tamperedTag, KEY));

    // Flip a byte in the ciphertext
    const ctOffset = MAGIC.length + SALT_BYTES + 12 + 1 + 4;
    const tamperedCt = Buffer.from(sealed);
    tamperedCt[ctOffset] ^= 0x01;
    assert.throws(() => decryptBuffer(tamperedCt, KEY));

    // Flip a byte in the IV
    const ivOffset = MAGIC.length + SALT_BYTES;
    const tamperedIv = Buffer.from(sealed);
    tamperedIv[ivOffset] ^= 0x01;
    assert.throws(() => decryptBuffer(tamperedIv, KEY));

    // Flip a byte in the magic header
    const tamperedMagic = Buffer.from(sealed);
    tamperedMagic[0] ^= 0x01;
    assert.throws(() => decryptBuffer(tamperedMagic, KEY));

    // Flip a byte in the salt
    const tamperedSalt = Buffer.from(sealed);
    tamperedSalt[MAGIC.length] ^= 0x01;
    assert.throws(() => decryptBuffer(tamperedSalt, KEY));
  });

  it("detects truncation and trailing garbage", () => {
    const sealed = encryptBuffer(Buffer.alloc(CHUNK_SIZE + 100, 0x42), KEY);
    // Truncated before end
    assert.throws(() => decryptBuffer(sealed.subarray(0, sealed.length - 1), KEY));
    // Truncated after first chunk (missing final chunk)
    const firstFrameLen = MAGIC.length + SALT_BYTES + (12 + 1 + 4 + CHUNK_SIZE + 16);
    assert.throws(() => decryptBuffer(sealed.subarray(0, firstFrameLen), KEY), /missing final chunk/);
    // Trailing garbage appended after final chunk
    assert.throws(() => decryptBuffer(Buffer.concat([sealed, Buffer.from([0x00])]), KEY), /trailing data/);
  });

  it("stream encrypt/decrypt matches buffer format and detects stream tampering", async () => {
    const payload = Buffer.alloc(CHUNK_SIZE * 2 + 77, 0x71);
    const encIn = new PassThrough();
    const encOut = new PassThrough();
    const encChunks = [];
    encOut.on("data", (c) => encChunks.push(c));
    const encDone = encryptStream(encIn, encOut, KEY);
    encIn.end(payload);
    await encDone;
    const sealed = Buffer.concat(encChunks);

    const decIn = new PassThrough();
    const decOut = new PassThrough();
    const decChunks = [];
    decOut.on("data", (c) => decChunks.push(c));
    const decDone = decryptStream(decIn, decOut, KEY);
    decIn.end(sealed);
    await decDone;
    assert.equal(Buffer.concat(decChunks).equals(payload), true);

    // Tamper stream
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 5] ^= 0x80;
    const badIn = new PassThrough();
    const badOut = new PassThrough();
    badOut.resume();
    badIn.end(tampered);
    await assert.rejects(() => decryptStream(badIn, badOut, KEY));
  });

  it("CLI encrypts via stdin->file and fails non-zero when tampered", () => {
    const dir = mkdtempSync(join(tmpdir(), "aead-crypt-cli-"));
    tempDirs.push(dir);
    const encFile = join(dir, "backup.enc");
    const env = { ...process.env, BACKUP_KEY: KEY };

    const encRun = spawnSync(process.execPath, [SCRIPT, "encrypt", "--out", encFile], {
      input: Buffer.from("cli-backup-payload"),
      env,
      encoding: "utf8",
    });
    assert.equal(encRun.status, 0, encRun.stderr);

    const decRun = spawnSync(process.execPath, [SCRIPT, "decrypt", "--in", encFile], {
      env,
    });
    assert.equal(decRun.status, 0, decRun.stderr?.toString());
    assert.equal(decRun.stdout.toString("utf8"), "cli-backup-payload");

    // Tamper encrypted file on disk -> decrypt must exit non-zero and emit no plaintext
    const bytes = readFileSync(encFile);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(encFile, bytes);
    const badRun = spawnSync(process.execPath, [SCRIPT, "decrypt", "--in", encFile], {
      env,
    });
    assert.notEqual(badRun.status, 0);
    assert.equal(badRun.stdout.length, 0);
  });
});
