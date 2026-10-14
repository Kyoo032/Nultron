import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { HostBytesResult, HostRequest } from "../types";

// Isolation: the examples dir is a temp folder, set BEFORE the modules load. The handler opens no
// database, but keep the data dir off the operator's desk regardless.
const dataDir = mkdtempSync(path.join(tmpdir(), "agentforge-video-range-data-"));
const examplesDir = mkdtempSync(path.join(tmpdir(), "agentforge-video-range-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_VIDEO_EXAMPLES_DIR = examplesDir;
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.DATABASE_URL;

const CLIP_BYTES = "0123456789";

function requestFor(name: string, range?: string): HostRequest {
  return {
    method: "GET",
    path: `/api/v1/videos/examples/${name}/file`,
    query: {},
    params: { name },
    headers: range ? { range } : {},
  };
}

describe("GET /api/v1/videos/examples/:name/file honours Range", () => {
  let clip: string;

  beforeAll(async () => {
    const { videoExampleFileNames } = await import("@agentforge/core/edit");
    clip = videoExampleFileNames()[0] as string;
    writeFileSync(path.join(examplesDir, clip), CLIP_BYTES);
    mkdirSync(path.join(examplesDir, "unused"), { recursive: true });
  });

  it("answers 200 with the whole clip and its real mime when there is no Range", async () => {
    const { handleGetVideoExampleFile } = await import("./video-examples");
    const result = (await handleGetVideoExampleFile(requestFor(clip))) as HostBytesResult;
    expect(result.type).toBe("bytes");
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bytes).toString()).toBe(CLIP_BYTES);
    expect(result.contentType).toBe("video/mp4");
    expect(result.headers?.["Accept-Ranges"]).toBe("bytes");
  });

  it("answers 206 with Content-Range for a satisfiable Range", async () => {
    const { handleGetVideoExampleFile } = await import("./video-examples");
    const result = (await handleGetVideoExampleFile(requestFor(clip, "bytes=0-3"))) as HostBytesResult;
    expect(result.status).toBe(206);
    expect(Buffer.from(result.bytes).toString()).toBe("0123");
    expect(result.headers?.["Content-Range"]).toBe(`bytes 0-3/${CLIP_BYTES.length}`);
  });

  it("answers 416 for a Range past the end of the clip", async () => {
    const { handleGetVideoExampleFile } = await import("./video-examples");
    const result = (await handleGetVideoExampleFile(requestFor(clip, "bytes=999-"))) as HostBytesResult;
    expect(result.status).toBe(416);
    expect(result.headers?.["Content-Range"]).toBe(`bytes */${CLIP_BYTES.length}`);
  });

  it("answers 404 for a name that is not in the manifest", async () => {
    const { handleGetVideoExampleFile } = await import("./video-examples");
    const result = await handleGetVideoExampleFile(requestFor("not-a-clip.mp4", "bytes=0-3"));
    expect(result.type).toBe("json");
    expect(result.status).toBe(404);
  });
});
