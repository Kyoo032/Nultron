/**
 * What the gateway published for an image or video model, laid over the built-in table (2026-11-11).
 *
 * The price list is read once by `refreshModelCache` and kept in the model cache; `media-spec.ts` reads
 * it back so the studios and the generation tools see one spec per model. Nothing here calls the
 * gateway: `fetch` answers the two free reads (the key's model list and the public price list).
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT_ID, publishedMediaParamsFor, type TenantContext } from "@agentforge/core";
import { attachMediaSpecs, imageSpecForScope, publishedMediaParams, videoSpecForScope } from "./media-spec";
import { loadModelCache, saveModelCache } from "./model-cache";
import { refreshModelCache, resetCatalogMemo } from "./selectable-models";
import { loadSettings, saveSettings } from "./settings-store";

const KEY = "sk-test-key-media-0123456789abcdef";

const tenant: TenantContext = {
  tenantId: LOCAL_TENANT_ID,
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "owner",
};

/** A video model no table has heard of, publishing the Seedance native body and its own values. */
const LUMEN_VIDEO = {
  model_name: "lumen-clip-9",
  supported_endpoint_types: ["seedance2-native-video"],
  supported_endpoints: {
    "seedance2-native-video": {
      path: "/api/v3/contents/generations/tasks",
      config: {
        parameters: {
          content: { type: "array", required: true },
          resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
          ratio: { type: "string", enum: ["16:9", "9:16", "3:4"] },
          duration: { type: "integer", enum: [4, 8], default: 4 },
          generate_audio: { type: "boolean", default: false },
        },
      },
    },
  },
};

const GPT_IMAGE = {
  model_name: "gpt-image-2",
  supported_endpoint_types: ["image-generation"],
  supported_endpoints: {
    "image-generation": {
      path: "/v1/images/generations",
      config: {
        parameters: {
          quality: { type: "string", enum: ["low", "medium", "high"] },
          n: { type: "integer", maximum: 4 },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"] },
        },
      },
    },
  },
};

function stubGateway(rows: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        const data = ["gpt-image-2", "seedance-2.0-fast", "lumen-clip-9"].map((id) => ({ id }));
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      if (url.endsWith("/api/pricing")) {
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

async function refresh(): Promise<void> {
  saveSettings({ openaiApiKey: KEY }, tenant);
  await refreshModelCache(loadSettings(tenant), { scope: tenant });
  resetCatalogMemo();
}

function cacheFile(): string {
  return process.env.AGENTFORGE_MODELS_CACHE_PATH ?? `${process.env.AGENTFORGE_DATA_DIR}/models-cache.json`;
}

beforeEach(() => {
  rmSync(cacheFile(), { force: true });
  resetCatalogMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a desk that has published nothing", () => {
  it("answers from the built-in table, so Seedance fast offers no 1080p", () => {
    expect(publishedMediaParams("seedance-2.0-fast", tenant)).toBeUndefined();
    const spec = videoSpecForScope("seedance-2.0-fast", tenant);
    expect(spec.source).toBe("built-in");
    expect(spec.resolution?.values).toEqual(["480p", "720p"]);
  });

  it("marks a model nobody knows as a family default, with what is unverified", () => {
    const spec = videoSpecForScope("never-heard-of-it-video", tenant);
    expect(spec.source).toBe("family-default");
    expect(spec.unverified.length).toBeGreaterThan(0);
  });
});

describe("a price list that publishes parameters", () => {
  it("keeps them in the model cache and lays them over a model the table does not know", async () => {
    stubGateway([LUMEN_VIDEO, GPT_IMAGE]);
    await refresh();

    expect(loadModelCache(tenant).mediaParams?.["lumen-clip-9"]).toMatchObject({
      hasContent: true,
      resolutionEnum: ["480p", "720p", "1080p"],
      ratioEnum: ["16:9", "9:16", "3:4"],
      duration: { enum: [4, 8], default: 4 },
      audio: { default: false },
    });

    const spec = videoSpecForScope("lumen-clip-9", tenant);
    expect(spec.source).toBe("published");
    expect(spec.bodyStyle).toBe("seedance-content");
    expect(spec.resolution?.values).toEqual(["480p", "720p", "1080p"]);
    expect(spec.aspect?.values).toEqual(["16:9", "9:16", "3:4"]);
    expect(spec.length.values).toEqual([4, 8]);
    expect(spec.audio.supported).toBe(true);
  });

  it("reads a model's published image values", async () => {
    stubGateway([LUMEN_VIDEO, GPT_IMAGE]);
    await refresh();
    const spec = imageSpecForScope("gpt-image-2", tenant);
    expect(spec.quality?.values).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    expect(spec.count?.max).toBe(4);
    expect(spec.outputFormat?.values).toEqual(expect.arrayContaining(["png", "jpeg", "webp"]));
  });

  it("is what the generation tools ask for, through the core source installed at boot", async () => {
    stubGateway([LUMEN_VIDEO]);
    await refresh();
    expect(publishedMediaParamsFor("LUMEN-clip-9", tenant)).toEqual(publishedMediaParams("lumen-clip-9", tenant));
    expect(publishedMediaParamsFor("lumen-clip-9", tenant)).toBeDefined();
    expect(publishedMediaParamsFor("seedance-2.0-fast", tenant)).toBeUndefined();
  });

  it("clears them when the next price list publishes none, so a stale value never outlives its source", async () => {
    stubGateway([LUMEN_VIDEO]);
    await refresh();
    expect(loadModelCache(tenant).mediaParams).toBeDefined();
    stubGateway([{ model_name: "gpt-image-2", supported_endpoint_types: ["image-generation"] }]);
    await refresh();
    expect(loadModelCache(tenant).mediaParams).toBeUndefined();
    expect(videoSpecForScope("lumen-clip-9", tenant).source).toBe("family-default");
  });
});

describe("attachMediaSpecs", () => {
  it("attaches each listed model's spec as `media`, of the kind asked for", async () => {
    stubGateway([LUMEN_VIDEO, GPT_IMAGE]);
    await refresh();

    const videos = attachMediaSpecs([{ id: "lumen-clip-9" }, { id: "seedance-2.0-fast" }], "video", tenant);
    expect(videos.map((model) => model.media.kind)).toEqual(["video", "video"]);
    const lumen = videos[0]?.media;
    const fast = videos[1]?.media;
    expect(lumen?.kind === "video" && lumen.source).toBe("published");
    expect(fast?.kind === "video" && fast.resolution?.values).toEqual(["480p", "720p"]);

    const images = attachMediaSpecs([{ id: "gpt-image-2" }], "image", tenant);
    expect(images[0]?.media.kind).toBe("image");
  });

  it("keeps the model's own fields and survives an unreadable cache", () => {
    const withSpecs = attachMediaSpecs([{ id: "seedance-2.0-fast", label: "Seedance Fast" }], "video", tenant);
    expect(withSpecs[0]).toMatchObject({ id: "seedance-2.0-fast", label: "Seedance Fast" });
    // A cache that cannot be read is no cache: the table answers.
    saveModelCache({}, tenant);
    expect(attachMediaSpecs([{ id: "seedance-2.0-fast" }], "video", tenant)[0]?.media.source).toBe("built-in");
  });
});
