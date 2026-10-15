import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-files-personal-parity-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const OTHER = "some-other-member";
const PNG = Buffer.from("png-bytes-personal-parity");

let local: TenantContext;

function request(method: string, path: string, params: Record<string, string> = {}): HostRequest {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  return { method, path: concrete, query: {}, params, headers: {} };
}

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

describe("generated files on Personal", () => {
  beforeAll(async () => {
    const { getTenant } = await import("./tenant");
    local = await getTenant();
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("any row on the desk is deleted by id, whoever wrote it, as before", async () => {
    const { saveMedia } = await import("./media");
    const saved = await saveMedia(
      { ...local, userId: OTHER },
      new File([PNG], "delete-parity.png", { type: "image/png" }),
    );
    const result = await dispatch(request("DELETE", "/api/v1/media/:mediaId", { mediaId: saved.id }), {
      serverMode: false,
    });
    expect(jsonBody<{ deleted: boolean }>(result).deleted).toBe(true);
  });

  it("an artifact on the desk is deleted by id, whoever wrote it, as before", async () => {
    const { artifactStore } = await import("./artifacts");
    const record = artifactStore().create(
      { ...local, userId: OTHER },
      {
        mode: "documents",
        kind: "draft",
        title: "Parity draft",
        mime: "text/markdown",
        body: "# Parity\n\nbody",
        meta: {},
      },
    );
    const result = await dispatch(request("DELETE", "/api/v1/artifacts/:artifactId", { artifactId: record.id }), {
      serverMode: false,
    });
    expect(result.status).toBe(200);
    expect(artifactStore().get(local, record.id)).toBeNull();
  });

  it("the galleries and the storage list show every row on the desk", async () => {
    const { saveMedia } = await import("./media");
    const saved = await saveMedia(
      { ...local, userId: OTHER },
      new File([PNG], "gallery-parity.png", { type: "image/png" }),
    );
    const images = jsonBody<{ items: Array<{ id: string }> }>(
      await dispatch(request("GET", "/api/v1/images"), { serverMode: false }),
    ).items;
    expect(images.map((item) => item.id)).toContain(saved.id);

    const storage = jsonBody<{ largest: Array<{ id: string }> }>(
      await dispatch(request("GET", "/api/v1/storage/usage"), { serverMode: false }),
    ).largest;
    expect(storage.map((item) => item.id)).toContain(saved.id);
  });

  it("a job mode inlines another member's picture, and Edit's output lookup finds it, off server mode", async () => {
    const { saveMedia } = await import("./media");
    const { inlineLocalMediaParts } = await import("./inline-local-media");
    const { loadMediaRow } = await import("./edit/wire-generate");
    const saved = await saveMedia(
      { ...local, userId: OTHER },
      new File([PNG], "inline-parity.png", { type: "image/png" }),
    );
    const parts = await inlineLocalMediaParts(local, [
      { type: "image_url", image_url: { url: `/api/v1/media/${saved.id}/file` } },
    ]);
    const first = parts[0];
    expect(first?.type === "image_url" ? first.image_url.url : "").toMatch(/^data:image\/png;base64,/);
    expect(await loadMediaRow(saved.id)).not.toBeNull();
  });
});
