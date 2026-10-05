import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { FOLDER_BINARY_SNIFF_BYTES, FOLDER_TEXT_MAX_BYTES } from "./constants";
import { refuse } from "./refusal";

export type TextFile = { readonly text: string; readonly sha256: string; readonly bytes: number };

export function sha256Of(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, FOLDER_BINARY_SNIFF_BYTES).includes(0);
}

// `ignoreBOM: true` keeps a byte-order mark in the string, so writing the text back is byte-exact.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The raw bytes of a regular file, or a refusal. Reads through one open handle, so the size that is
 * checked and the bytes that are read belong to the same file even if the path is swapped between.
 * The buffer holds one byte more than the cap, so a file that grew after the size check is caught.
 */
export async function readFileBytes(real: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, "r");
  } catch {
    return refuse("not_found");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return refuse("bad_path");
    }
    if (info.size > FOLDER_TEXT_MAX_BYTES) {
      return refuse("too_large");
    }
    const buffer = Buffer.alloc(Math.min(info.size, FOLDER_TEXT_MAX_BYTES) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    if (filled > FOLDER_TEXT_MAX_BYTES) {
      return refuse("too_large");
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/** Decode bytes the agent may read: valid UTF-8 with no NUL near the start, or `denied`. */
export function decodeText(data: Buffer): TextFile {
  if (looksBinary(data)) {
    return refuse("denied");
  }
  let text: string;
  try {
    text = STRICT_UTF8.decode(data);
  } catch {
    return refuse("denied");
  }
  return { text, sha256: sha256Of(data), bytes: data.byteLength };
}

export async function readTextFile(real: string): Promise<TextFile> {
  return decodeText(await readFileBytes(real));
}
