import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mediaMimeForPath, rangedFileResult } from "./file-bytes";

async function clipOnDisk(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentforge-file-bytes-"));
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
}

describe("mediaMimeForPath", () => {
  it("names the type from the actual file extension", () => {
    expect(mediaMimeForPath("/d/export.mp4")).toBe("video/mp4");
    expect(mediaMimeForPath("/d/clip.WEBM")).toBe("video/webm");
    expect(mediaMimeForPath("/d/clip.mov")).toBe("video/quicktime");
    expect(mediaMimeForPath("/d/voice.m4a")).toBe("audio/mp4");
  });

  it("falls back to a binary type for anything it does not know", () => {
    expect(mediaMimeForPath("/d/blob")).toBe("application/octet-stream");
    expect(mediaMimeForPath("/d/archive.xyz")).toBe("application/octet-stream");
  });
});

describe("rangedFileResult", () => {
  it("answers 200 with the whole file when no Range is sent", async () => {
    const file = await clipOnDisk("export.mp4", "0123456789");
    const result = await rangedFileResult(file, undefined, "export.mp4");
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bytes).toString()).toBe("0123456789");
    expect(result.contentType).toBe("video/mp4");
    expect(result.filename).toBe("export.mp4");
    expect(result.headers?.["Accept-Ranges"]).toBe("bytes");
  });

  it("answers 206 with Content-Range for a satisfiable Range", async () => {
    const file = await clipOnDisk("export.mp4", "0123456789");
    const result = await rangedFileResult(file, "bytes=2-5", undefined);
    expect(result.status).toBe(206);
    expect(Buffer.from(result.bytes).toString()).toBe("2345");
    expect(result.headers?.["Content-Range"]).toBe("bytes 2-5/10");
    expect(result.contentType).toBe("video/mp4");
  });

  it("answers 416 with the file size for a Range past the end", async () => {
    const file = await clipOnDisk("export.mp4", "0123456789");
    const result = await rangedFileResult(file, "bytes=50-", undefined);
    expect(result.status).toBe(416);
    expect(result.bytes.byteLength).toBe(0);
    expect(result.headers?.["Content-Range"]).toBe("bytes */10");
  });

  it("keeps the mime of the real file, not a fixed one", async () => {
    const file = await clipOnDisk("clip.webm", "abc");
    const result = await rangedFileResult(file, undefined, undefined);
    expect(result.contentType).toBe("video/webm");
    expect(result.filename).toBeUndefined();
  });
});
