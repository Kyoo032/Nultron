import path from "node:path";
import { readByteRange } from "./byte-range";
import type { HostBytesResult } from "./types";

/**
 * Media types for the files this app writes or bundles, keyed by extension. A download names its
 * type from the file it actually sends, so a WebM export is not labelled MP4 by a fixed constant.
 */
const MEDIA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The `Content-Type` for a file on disk, from its extension. Unknown kinds are sent as binary. */
export function mediaMimeForPath(filePath: string): string {
  return MEDIA_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A bytes result for a file on disk that honours a `Range` request: 200 with the whole file, 206
 * with `Content-Range` for a satisfiable range, 416 for one past the end. Only the requested bytes
 * are read (see `readByteRange`). `filename`, when given, becomes the download name.
 */
export async function rangedFileResult(
  filePath: string,
  rangeHeader: string | undefined,
  filename: string | undefined,
): Promise<HostBytesResult> {
  const ranged = await readByteRange(filePath, rangeHeader);
  return {
    type: "bytes",
    status: ranged.status,
    bytes: ranged.bytes,
    contentType: mediaMimeForPath(filePath),
    headers: ranged.headers,
    ...(filename ? { filename } : {}),
  };
}
