/**
 * `GET /api/v1/edit/projects/:projectId/export/:jobId/file` — a finished render, served the way a
 * browser asks for it. A video element seeks with `Range`, and a plain download sends none, so the
 * route answers 200 for a whole file, 206 for a range and 416 for one past the end. The mime and the
 * download name come from the file the job actually wrote, not from a fixed MP4 label.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-export-route-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import { db, editJobs } from "@agentforge/db";
import { dispatch } from "../router";
import type { HostBytesResult, HostResult } from "../types";
import { seedEditProject } from "./harness";

const RENDER_BYTES = "0123456789";

function exportFile(projectId: string, jobId: string, range?: string): Promise<HostResult> {
  return dispatch({
    method: "GET",
    path: `/api/v1/edit/projects/${projectId}/export/${jobId}/file`,
    query: {},
    params: { projectId, jobId },
    headers: range ? { range } : {},
  });
}

async function finishedRender(projectId: string, file: string | null, status: "succeeded" | "running") {
  const id = crypto.randomUUID();
  await db.insert(editJobs).values({
    id,
    projectId,
    kind: "render",
    status,
    targetClipIdsJson: [],
    requestJson: {},
    progress: status === "succeeded" ? 100 : 10,
    outputAssetIdsJson: file ? [file] : null,
  });
  return id;
}

describe("GET …/export/:jobId/file", () => {
  let projectId: string;
  let renderFile: string;

  beforeAll(async () => {
    const seeded = await seedEditProject("export-file-route");
    projectId = seeded.project.id;
    renderFile = join(dataDir, "export.mp4");
    writeFileSync(renderFile, RENDER_BYTES);
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort: an open handle can refuse the delete on Windows.
    }
  });

  it("answers 200 with the whole render, its real mime and a download name", async () => {
    const jobId = await finishedRender(projectId, renderFile, "succeeded");
    const result = (await exportFile(projectId, jobId)) as HostBytesResult;
    expect(result.type).toBe("bytes");
    expect(result.status).toBe(200);
    expect(Buffer.from(result.bytes).toString()).toBe(RENDER_BYTES);
    expect(result.contentType).toBe("video/mp4");
    expect(result.filename).toBe("export.mp4");
    expect(result.headers?.["Accept-Ranges"]).toBe("bytes");
  });

  it("answers 206 with Content-Range for a satisfiable Range", async () => {
    const jobId = await finishedRender(projectId, renderFile, "succeeded");
    const result = (await exportFile(projectId, jobId, "bytes=1-4")) as HostBytesResult;
    expect(result.status).toBe(206);
    expect(Buffer.from(result.bytes).toString()).toBe("1234");
    expect(result.headers?.["Content-Range"]).toBe(`bytes 1-4/${RENDER_BYTES.length}`);
  });

  it("answers 416 for a Range past the end of the render", async () => {
    const jobId = await finishedRender(projectId, renderFile, "succeeded");
    const result = (await exportFile(projectId, jobId, "bytes=500-")) as HostBytesResult;
    expect(result.status).toBe(416);
    expect(result.headers?.["Content-Range"]).toBe(`bytes */${RENDER_BYTES.length}`);
  });

  it("answers 404 while the render is not finished", async () => {
    const jobId = await finishedRender(projectId, null, "running");
    const result = await exportFile(projectId, jobId);
    expect(result.type).toBe("json");
    expect(result.type === "json" && result.status).toBe(404);
  });
});
