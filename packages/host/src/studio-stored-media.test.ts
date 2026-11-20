import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, imageGenerateTool, type TenantContext, type VideoRenderCall } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-studio-stored-media-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.DATABASE_URL;

vi.mock("./knowledge-ingest", () => ({
  upsertWorkSource: vi.fn(async () => undefined),
}));

const TENANT = "studio-stored-media-tenant";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const CLIP = `data:video/mp4;base64,${Buffer.from("stub-clip").toString("base64")}`;
const VIDEO_MODEL = "grok-imagine-video";
const IMAGE_MODEL = "gpt-image-2";
const GHOST = "00000000-0000-4000-8000-000000000000";
const CDN_URL = "https://cdn.example/still.png";

let alice: TenantContext;
let ann: TenantContext;
let bob: TenantContext;
let aliceImage: string;
let bobImage: string;
let studio: typeof import("./studio-generate");

type Refusal = { status: number; code: string; message: string };

async function refusal(run: () => unknown): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: error.status, code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a refusal, got a result");
}

function imageBody(imageUrl: string) {
  return { prompt: "make it blue", model: IMAGE_MODEL, imageUrl };
}

function videoBody(imageUrl: string, model = VIDEO_MODEL) {
  return { prompt: "a lantern drifting", aspect: "16:9" as const, model, seconds: 5, imageUrl };
}

function imageTool() {
  return vi
    .spyOn(imageGenerateTool, "execute")
    .mockResolvedValue({ success: true, image: PNG_DATA_URL, model: IMAGE_MODEL });
}

function videoRender() {
  return vi.fn(async (_call: VideoRenderCall) => ({ success: true, video: CLIP, model: VIDEO_MODEL }));
}

beforeAll(async () => {
  await import("./tenant-state-db");
  await import("./tenant-storage-db");
  await import("./entitlement-db");
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  alice = await ensurePortalOwner(db, { tenantId: TENANT, orgId: "org-a", userId: "alice", role: "owner" });
  ann = await ensurePortalOwner(db, { tenantId: TENANT, orgId: "org-a", userId: "ann", role: "member" });
  bob = await ensurePortalOwner(db, { tenantId: TENANT, orgId: "org-b", userId: "bob", role: "owner" });
  const { saveMedia } = await import("./media");
  const png = () => new File([PNG], "lantern.png", { type: "image/png" });
  aliceImage = (await saveMedia(alice, png())).id;
  await saveMedia(ann, png());
  bobImage = (await saveMedia(bob, png())).id;
  const { saveModelCache } = await import("./model-cache");
  const { resetCatalogMemo } = await import("./selectable-models");
  for (const tenant of [alice, ann, bob]) {
    saveModelCache(
      { openai: [{ id: VIDEO_MODEL, label: "Grok Imagine Video", provider: "openai", inputModalities: ["text"] }] },
      tenant,
    );
  }
  resetCatalogMemo();
  studio = await import("./studio-generate");
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("studio image from a stored reference", () => {
  it("sends the caller's own image to the generation request, for the bare id and the relative path", async () => {
    const spy = imageTool();
    const bare = await studio.generateStudioImage(alice, imageBody(aliceImage), { workType: "Edit" });
    const relative = await studio.generateStudioImage(alice, imageBody(`/api/v1/media/${aliceImage}/file`), {
      workType: "Edit",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ image_url: PNG_DATA_URL });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ image_url: PNG_DATA_URL });
    expect(bare.id).toBeTruthy();
    expect(relative.id).toBeTruthy();
  });

  it("passes a URL through exactly as given, even one that carries a media path", async () => {
    const spy = imageTool();
    const url = `https://cdn.example/api/v1/media/${aliceImage}/file`;
    await studio.generateStudioImage(alice, imageBody(url), { workType: "Edit" });
    await studio.generateStudioImage(alice, imageBody(CDN_URL), { workType: "Edit" });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ image_url: url });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ image_url: CDN_URL });
  });

  it("answers another company's image with the same 404 as a missing id", async () => {
    const spy = imageTool();
    const ownAlice = await studio.generateStudioImage(alice, imageBody(aliceImage), { workType: "Edit" });
    const ownBob = await studio.generateStudioImage(bob, imageBody(bobImage), { workType: "Edit" });
    expect(ownAlice.id).toBeTruthy();
    expect(ownBob.id).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);

    const missing = await refusal(() => studio.generateStudioImage(alice, imageBody(GHOST), { workType: "Edit" }));
    const otherCompany = await refusal(() =>
      studio.generateStudioImage(alice, imageBody(bobImage), { workType: "Edit" }),
    );
    const otherCompanyReverse = await refusal(() =>
      studio.generateStudioImage(bob, imageBody(aliceImage), { workType: "Edit" }),
    );

    expect(missing).toEqual({ status: 404, code: "not_found", message: "Media not found" });
    expect(otherCompany).toEqual(missing);
    expect(otherCompanyReverse).toEqual(missing);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refuses a missing reference on the Images page before the stub stand-in, and still serves the caller's own", async () => {
    const spy = imageTool();
    const missing = await refusal(() => studio.generateStudioImage(alice, imageBody(GHOST)));
    expect(missing).toEqual({ status: 404, code: "not_found", message: "Media not found" });
    const own = await studio.generateStudioImage(alice, imageBody(aliceImage));
    expect(own.url).toMatch(/^\/api\/v1\/media\//);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the caller's own image on a desk without server mode, as before", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "");
    const spy = imageTool();
    const result = await studio.generateStudioImage(alice, imageBody(aliceImage), { workType: "Edit" });
    expect(result.id).toBeTruthy();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ image_url: PNG_DATA_URL });
  });
});

describe("studio video from a stored reference", () => {
  it("sends the caller's own image to the render as a data URL, for the bare id and the relative path", async () => {
    const renderVideo = videoRender();
    const bare = await studio.generateStudioVideo(alice, videoBody(aliceImage), { renderVideo });
    const relative = await studio.generateStudioVideo(alice, videoBody(`/api/v1/media/${aliceImage}/file`), {
      renderVideo,
    });
    expect(renderVideo).toHaveBeenCalledTimes(2);
    expect(renderVideo.mock.calls[0]?.[0]).toMatchObject({ image_url: PNG_DATA_URL, model: VIDEO_MODEL });
    expect(renderVideo.mock.calls[1]?.[0]).toMatchObject({ image_url: PNG_DATA_URL });
    expect(bare.id).toBeTruthy();
    expect(relative.id).toBeTruthy();
  });

  it("passes a URL still through exactly as given", async () => {
    const renderVideo = videoRender();
    await studio.generateStudioVideo(alice, videoBody(CDN_URL), { renderVideo });
    expect(renderVideo.mock.calls[0]?.[0]).toMatchObject({ image_url: CDN_URL });
  });

  it("settles what was asked against the model's spec before the render, and reports what it sent", async () => {
    const renderVideo = videoRender();
    // Grok's video takes 6 or 10 seconds, 480p or 720p, 16:9 or 9:16, and has no sound switch.
    const result = await studio.generateStudioVideo(
      alice,
      { prompt: "a lantern drifting", model: VIDEO_MODEL, seconds: 5, resolution: "1080p", aspect: "1:1" },
      { renderVideo },
    );
    const call = renderVideo.mock.calls[0]?.[0];
    expect(call).toMatchObject({ model: VIDEO_MODEL, seconds: 6, resolution: "720p" });
    expect(["16:9", "9:16"]).toContain(call?.aspect_ratio);
    expect(call?.audio).not.toBe(true);
    expect(result.sent).toMatchObject({ seconds: 6, resolution: "720p" });
    const fields = (result.adjusted ?? []).map((item) => item.field);
    expect(fields).toEqual(expect.arrayContaining(["seconds", "resolution"]));
  });

  it("refuses sound on a model that has no sound switch, and renders nothing", async () => {
    const renderVideo = videoRender();
    const refused = await refusal(() =>
      studio.generateStudioVideo(
        alice,
        { prompt: "a lantern drifting", model: VIDEO_MODEL, audio: true },
        { renderVideo },
      ),
    );
    expect(refused.code).toBe("video_audio_unsupported");
    expect(refused.status).toBe(400);
    expect(renderVideo).not.toHaveBeenCalled();
  });

  it("starts from the model's own defaults when no knob is sent: 720p, sound off", async () => {
    const renderVideo = videoRender();
    const result = await studio.generateStudioVideo(
      alice,
      { prompt: "a lantern drifting", model: VIDEO_MODEL },
      { renderVideo },
    );
    expect(renderVideo.mock.calls[0]?.[0]).toMatchObject({ model: VIDEO_MODEL, resolution: "720p" });
    expect(renderVideo.mock.calls[0]?.[0].audio).not.toBe(true);
    expect(result.adjusted ?? []).toEqual([]);
  });

  it("answers another company's image with the same 404 as a missing id, and renders nothing", async () => {
    const renderVideo = videoRender();
    const own = await studio.generateStudioVideo(bob, videoBody(bobImage), { renderVideo });
    expect(own.id).toBeTruthy();
    expect(renderVideo).toHaveBeenCalledTimes(1);

    const missing = await refusal(() => studio.generateStudioVideo(alice, videoBody(GHOST), { renderVideo }));
    const otherCompany = await refusal(() => studio.generateStudioVideo(alice, videoBody(bobImage), { renderVideo }));

    expect(missing).toEqual({ status: 404, code: "not_found", message: "Media not found" });
    expect(otherCompany).toEqual(missing);
    expect(renderVideo).toHaveBeenCalledTimes(1);
  });
});

describe("studio body parsing for a stored reference", () => {
  it("accepts a bare id, a relative media path and a URL as the image source", () => {
    expect(studio.parseImageGenerateBody({ prompt: "x", imageUrl: aliceImage }).imageUrl).toBe(aliceImage);
    expect(studio.parseImageGenerateBody({ prompt: "x", imageUrl: `/api/v1/media/${aliceImage}/file` }).imageUrl).toBe(
      `/api/v1/media/${aliceImage}/file`,
    );
    expect(studio.parseImageGenerateBody({ prompt: "x", imageUrl: CDN_URL }).imageUrl).toBe(CDN_URL);
    expect(studio.parseVideoGenerateBody({ prompt: "x", imageUrl: aliceImage }).imageUrl).toBe(aliceImage);
  });

  it("refuses a malformed reference or a non-URL with a 400 invalid_content_part", async () => {
    const malformed = [
      "lantern",
      "/api/v1/media/123/file",
      `/api/v1/media/${aliceImage}/file/extra`,
      "/api/v1/media/not-a-uuid/file",
      "",
    ];
    for (const imageUrl of malformed) {
      expect(await refusal(() => studio.parseImageGenerateBody({ prompt: "x", imageUrl }))).toMatchObject({
        status: 400,
        code: "invalid_content_part",
      });
      expect(await refusal(() => studio.parseVideoGenerateBody({ prompt: "x", imageUrl }))).toMatchObject({
        status: 400,
        code: "invalid_content_part",
      });
    }
  });

  it("refuses a still on a text-only model, for a stored reference as for a URL", async () => {
    expect(
      await refusal(() => studio.parseVideoGenerateBody({ prompt: "x", model: "omni-fast-v2v", imageUrl: aliceImage })),
    ).toMatchObject({ status: 400, code: "video_still_unsupported" });
    expect(
      await refusal(() => studio.parseVideoGenerateBody({ prompt: "x", model: "omni-fast-v2v", imageUrl: CDN_URL })),
    ).toMatchObject({ status: 400, code: "video_still_unsupported" });
  });
});
