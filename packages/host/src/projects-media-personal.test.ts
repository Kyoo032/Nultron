import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-media-personal-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import type { HostRequest } from "./types";

const { dispatch } = await import("./router");

let local: TenantContext;

function request(method: string, path: string, params: Record<string, string> = {}, body?: unknown): HostRequest {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  return {
    method,
    path: concrete,
    query: {},
    params,
    headers: {},
    ...(body === undefined ? {} : { body }),
  };
}

describe("generated media on Personal", () => {
  beforeAll(async () => {
    const { getTenant } = await import("./tenant");
    local = await getTenant();
  });

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a desk reads every media row on it by id, whoever's tenant user wrote it, as before", async () => {
    const { saveMedia } = await import("./media");
    const saved = await saveMedia(
      { ...local, userId: "some-other-member" },
      new File([Buffer.from("png-bytes-personal")], "personal.png", { type: "image/png" }),
    );
    const read = await dispatch(request("GET", "/api/v1/media/:mediaId/file", { mediaId: saved.id }), {
      serverMode: false,
    });
    expect(read.type).toBe("bytes");
    expect(read.status).toBe(200);
  });

  it("the by-reference reads of chat and the Edit jobs stay desk-wide off server mode", async () => {
    const { saveMedia } = await import("./media");
    const { readMediaDataUrl, statMedia } = await import("./media");
    const { chatMediaReferenceResolver } = await import("./chat-media-resolver");
    const saved = await saveMedia(
      { ...local, userId: "some-other-member" },
      new File([Buffer.from("png-bytes-reference")], "reference.png", { type: "image/png" }),
    );
    expect((await statMedia(local, saved.id))?.kind).toBe("image");
    expect(await readMediaDataUrl(local, saved.id)).toMatch(/^data:image\/png;base64,/);
    expect(await chatMediaReferenceResolver(local, saved.id)).toMatch(/^data:image\/png;base64,/);
  });

  it("the project routes, media included, answer the router's own 404", async () => {
    const unknown = await dispatch(request("GET", "/api/v1/no-such-route"), { serverMode: false });
    const id = "00000000-0000-7000-8000-000000000000";
    const media = [
      request("POST", "/api/v1/projects/:id/files", { id }, { mediaId: id }),
      request("DELETE", "/api/v1/projects/:id/media/:mediaId", { id, mediaId: id }),
    ];
    for (const req of media) {
      const result = await dispatch(req, { serverMode: false });
      expect(result.status, `${req.method} ${req.path}`).toBe(404);
      expect((result as { body: unknown }).body, `${req.method} ${req.path}`).toEqual(
        (unknown as { body: unknown }).body,
      );
    }
  });
});
