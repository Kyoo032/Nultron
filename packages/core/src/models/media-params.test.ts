import { describe, expect, it } from "vitest";
import pricingRows from "./__fixtures__/pricing-media-rows.json";
import { ApiError } from "../errors";
import { mediaKind } from "./media-kind";
import {
  imageShapeOptions,
  imageSpecFor,
  ratioOf,
  settleImage,
  settleVideo,
  snapVideoLength,
  tierRank,
  videoLengthOptions,
  videoSpecFor,
} from "./media-params";
import { parsePublishedMediaParams } from "./media-params-published";
import { allowedVideoSeconds, snapVideoSeconds, videoCapabilities } from "./video-capabilities";

describe("a spec built from what the gateway published", () => {
  const published = parsePublishedMediaParams(pricingRows);

  it("reads the real price list rows: only the Seedance rows publish parameters", () => {
    expect(Object.keys(published).sort()).toEqual([
      "seedance-1.0-pro",
      "seedance-2.0",
      "seedance-2.0-fast",
      "seedance-2.0-mini",
      "seedance-2.5",
    ]);
    expect(published["seedance-2.0-fast"]).toMatchObject({
      hasContent: true,
      resolutionEnum: ["480p", "720p"],
      duration: { default: 5 },
      audio: { default: true },
    });
    // gpt-image-2 publishes no config.parameters, so nothing is read for it.
    expect(published["gpt-image-2"]).toBeUndefined();
  });

  it("uses the published resolution enum: seedance-2.0-fast offers 480p and 720p only", () => {
    const spec = videoSpecFor("seedance-2.0-fast", published["seedance-2.0-fast"]);
    expect(spec.source).toBe("published");
    expect(spec.resolution).toEqual({ field: "size", values: ["480p", "720p"], default: "720p" });
    expect(spec.audio).toEqual({ supported: true, field: "metadata.generate_audio", default: true });
    expect(spec.unverified).not.toContain("resolution");
  });

  it("makes a model the table has never heard of work with no code change", () => {
    const body = {
      data: [
        {
          model_name: "seedance-9.9-ultra",
          supported_endpoints: {
            "seedance2-native-video": {
              config: {
                parameters: {
                  content: { type: "array", required: true },
                  ratio: { type: "string" },
                  resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
                  duration: { type: "integer", default: 6 },
                  generate_audio: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        {
          // No Seedance in the id at all: the published `content` array is what says so.
          model_name: "mystery-video-1",
          supported_endpoints: {
            "native-video": { config: { parameters: { content: { type: "array" }, resolution: { enum: ["720p"] } } } },
          },
        },
      ],
    };
    const map = parsePublishedMediaParams(body);
    const spec = videoSpecFor("seedance-9.9-ultra", map["seedance-9.9-ultra"]);
    expect(spec.bodyStyle).toBe("seedance-content");
    expect(spec.source).toBe("published");
    expect(spec.resolution?.values).toEqual(["480p", "720p", "1080p"]);
    expect(spec.length.default).toBe(6);
    expect(snapVideoLength(spec.length, undefined)).toBe(6);
    const mystery = videoSpecFor("mystery-video-1", map["mystery-video-1"]);
    expect(mystery.bodyStyle).toBe("seedance-content");
    expect(mystery.resolution?.values).toEqual(["720p"]);
  });

  it("lets a changed enum take effect: a published 4k makes 4k valid", () => {
    const spec = videoSpecFor("seedance-2.0-fast", { hasContent: true, resolutionEnum: ["480p", "720p", "1080p", "4k"] });
    expect(settleVideo(spec, { resolution: "4k" }).resolution).toBe("4k");
  });

  it("treats a row that publishes the native body but no generate_audio as silent", () => {
    const spec = videoSpecFor("seedance-1.0-pro", published["seedance-1.0-pro"]);
    expect(spec.audio.supported).toBe(false);
  });

  it("ignores a size enum that is only a type, and an empty map", () => {
    expect(parsePublishedMediaParams({ data: [{ model_name: "x", supported_endpoints: {} }] })).toEqual({});
    expect(parsePublishedMediaParams(null)).toEqual({});
  });
});

describe("the built-in table", () => {
  it("sends the Seedance length as the string `seconds` the route reads, and keeps it driven on seedance-2.0-fast only", () => {
    const built = videoSpecFor("seedance-2.0-fast");
    // Live 2026-11-12: `seconds: "6"` gave a 6.04 s clip and `"15"` a 15.04 s one; `duration` was ignored.
    expect(built.length).toMatchObject({ field: "seconds", wireType: "string", min: 4, max: 15, default: 5 });
    expect(built.unverified).not.toContain("length");
    expect(built.evidence.length).toContain("15.04 s");
    // Every other Seedance id shares the route, not the evidence: its length stays unverified.
    for (const id of ["seedance-2.0", "seedance-2.0-mini", "seedance-2.5", "seedance-1.5-pro", "seedance-9.9-ultra"]) {
      expect(videoSpecFor(id).length, id).toMatchObject({ field: "seconds", wireType: "string" });
      expect(videoSpecFor(id).unverified, id).toContain("length");
    }
    const published = videoSpecFor("seedance-2.0-fast", {
      hasContent: true,
      duration: { default: 5 },
      resolutionEnum: ["480p", "720p"],
      audio: { default: true },
    });
    expect(published.source).toBe("published");
    // The published duration is the native endpoint's: it moves neither the field nor the proven status.
    expect(published.length).toMatchObject({ field: "seconds", wireType: "string", min: 4, max: 15 });
    expect(published.unverified).not.toContain("length");
    expect(published.unverified).not.toContain("resolution");
    expect(published.unverified).not.toContain("audio");
  });

  it("knows the Seedance families by their published and documented values", () => {
    const fast = videoSpecFor("seedance-2.0-fast");
    expect(fast).toMatchObject({
      source: "built-in",
      bodyStyle: "seedance-content",
      route: "/v1/video/generations",
      length: { field: "seconds", min: 4, max: 15, default: 5, wireType: "string" },
      audio: { supported: true, field: "metadata.generate_audio", default: true },
    });
    expect(fast.aspect?.values).toEqual(["16:9", "9:16", "3:4", "1:1", "4:3"]);
    expect(fast.resolution?.values).toEqual(["480p", "720p"]);
    expect(videoSpecFor("seedance-2.0").resolution?.values).toEqual(["480p", "720p", "1080p", "4k"]);
    expect(videoSpecFor("seedance-2.5").length.max).toBe(30);
    expect(videoSpecFor("seedance-2.5").resolution?.values).toEqual(["480p", "720p"]);
    expect(videoSpecFor("doubao-seedance-2-0-fast-260128").resolution?.values).toEqual(["480p", "720p"]);
  });

  it("keeps evidence for every entry's fields", () => {
    for (const id of ["seedance-2.0-fast", "grok-imagine-video", "kling-3.0-turbo", "omni-fast", "veo_3_1"]) {
      const spec = videoSpecFor(id);
      expect(spec.evidence.route, id).toBeTruthy();
      expect(spec.evidence.length, id).toBeTruthy();
    }
    expect(imageSpecFor("gpt-image-2").evidence.quality).toContain(":4307");
  });

  it("marks only what nobody published as unverified", () => {
    expect(videoSpecFor("kling-3.0-turbo").unverified).toEqual([]);
    expect(videoSpecFor("grok-imagine-video").unverified).toEqual(["aspect", "length", "resolution"]);
    expect(videoSpecFor("veo_3_1-fast").unverified).toContain("length");
  });

  it("routes each family by what its docs name", () => {
    expect(videoSpecFor("grok-imagine-video")).toMatchObject({ bodyStyle: "grok-videos", route: "/v1/videos" });
    expect(videoSpecFor("omni-fast")).toMatchObject({ bodyStyle: "omni-fast", route: "/v1/videos" });
    expect(videoSpecFor("kling-v3")).toMatchObject({
      bodyStyle: "kling-native",
      route: "/kling/v1/videos/text2video",
      stillRoute: "/kling/v1/videos/image2video",
    });
    expect(videoSpecFor("kling-v3-omni").route).toBe("/kling/v1/videos/omni-video");
    expect(videoSpecFor("kling-3.0-turbo").route).toBe("/kling/text-to-video/kling-3.0-turbo");
    expect(videoSpecFor("veo_3_1-fast")).toMatchObject({ bodyStyle: "veo-generic", route: "/v1/video/generations" });
  });

  it("gives gpt-image-2 its documented sizes, qualities and format", () => {
    const spec = imageSpecFor("gpt-image-2");
    expect(spec.source).toBe("built-in");
    expect(spec.shape.mode).toBe("size");
    expect(imageShapeOptions(spec).map((option) => option.value)).toContain("3840x2160");
    expect(spec.quality?.values).toEqual(["low", "medium", "high", "auto"]);
    expect(spec.quality?.default).toBe("low");
    expect(spec.outputFormat?.values).toEqual(["png", "jpeg"]);
    expect(spec.editRoute).toBe("/v1/images/edits");
  });

  it("gives nano-banana ratios and tiers, and the count model only its three aspects", () => {
    const nano = imageSpecFor("nano-banana-2");
    expect(nano.shape).toMatchObject({ mode: "aspect", field: "aspect_ratio" });
    expect(nano.tier?.values).toEqual(["0.5k", "1k", "2k", "4k"]);
    expect(imageShapeOptions(imageSpecFor("gpt-image-2-count")).map((option) => option.aspect)).toEqual([
      "1:1",
      "3:2",
      "2:3",
    ]);
    expect(imageSpecFor("gpt-image-2-count").quality).toBeUndefined();
  });

  it("classifies kling_image and kling_omni_image as image models, not video", () => {
    expect(mediaKind("kling_image")).toBe("image");
    expect(mediaKind("kling_omni_image")).toBe("image");
    expect(mediaKind("kling-v3")).toBe("video");
    expect(mediaKind("kling-3.0-turbo")).toBe("video");
  });
});

describe("an unknown model falls back to its family default", () => {
  it("offers an unlisted Seedance id only the values every Seedance id takes", () => {
    const spec = videoSpecFor("seedance-9.9-ultra");
    expect(spec.source).toBe("family-default");
    expect(spec.family).toBe("seedance");
    expect(spec.bodyStyle).toBe("seedance-content");
    expect(spec.resolution?.values).toEqual(["480p", "720p"]);
    expect(spec.length.values).toEqual([5]);
    expect(spec.unverified).toEqual(expect.arrayContaining(["length", "resolution"]));
  });

  it("copies the nearest family for Kling, Veo and Grok ids", () => {
    expect(videoSpecFor("kling-v9").bodyStyle).toBe("kling-native");
    expect(videoSpecFor("kling-v9-omni").bodyStyle).toBe("kling-omni");
    expect(videoSpecFor("kling-9.0-turbo").bodyStyle).toBe("kling-turbo");
    expect(videoSpecFor("veo_4_0").bodyStyle).toBe("veo-generic");
    expect(videoSpecFor("grok-imagine-video-2").bodyStyle).toBe("grok-videos");
    for (const id of ["kling-v9", "veo_4_0", "grok-imagine-video-2"]) {
      expect(videoSpecFor(id).source).toBe("family-default");
      expect(videoSpecFor(id).unverified).toEqual(expect.arrayContaining(["aspect", "length"]));
    }
  });

  it("gives a video id nobody knows the generic route, a prompt and a length, and nothing else", () => {
    const spec = videoSpecFor("totally-unknown-video");
    expect(spec).toMatchObject({ bodyStyle: "openai-video", route: "/v1/video/generations", source: "family-default" });
    expect(spec.aspect).toBeUndefined();
    expect(spec.resolution).toBeUndefined();
    expect(spec.audio.supported).toBe(false);
    expect(spec.imageInput.firstFrame).toBe(false);
  });

  it("gives an image id nobody knows a square and nothing else", () => {
    const spec = imageSpecFor("totally-unknown-image");
    expect(spec.source).toBe("family-default");
    expect(imageShapeOptions(spec)).toEqual([{ value: "1024x1024", aspect: "1:1", label: "1024 × 1024 · 1:1" }]);
    expect(spec.quality).toBeUndefined();
    expect(spec.count).toBeUndefined();
    expect(imageSpecFor("kling_image").bodyStyle).toBe("generic-image");
  });

  it("sends medium to the two gpt-image-2.5 ids that were driven, and nothing to the variants nobody drove", () => {
    // Live 2026-11-12: flare and sunburst accepted quality medium and echoed it; low and high were not driven.
    for (const id of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      expect(imageSpecFor(id).quality, id).toEqual({ field: "quality", values: ["medium"], default: "medium" });
      expect(imageSpecFor(id).unverified, id).not.toContain("quality");
    }
    for (const id of ["gpt-image-2.5-sunburst-token", "gpt-image-2.5-flare-count"]) {
      expect(imageSpecFor(id).quality, id).toBeUndefined();
      expect(imageSpecFor(id).unverified, id).toContain("quality");
      expect(imageShapeOptions(imageSpecFor(id)).map((option) => option.value), id).toEqual(["1024x1024"]);
    }
  });

  it("offers the three sizes gpt-image-2.5 drew live, and no others", () => {
    expect(imageShapeOptions(imageSpecFor("gpt-image-2.5-flare")).map((option) => option.value)).toEqual([
      "1024x1024",
      "1536x1024",
      "1024x1536",
    ]);
  });
});

describe("settling a video request against a spec", () => {
  it("moves 1080p to 720p on seedance-2.0-fast, and says so", () => {
    const settled = settleVideo(videoSpecFor("seedance-2.0-fast"), { resolution: "1080p" });
    expect(settled.resolution).toBe("720p");
    expect(settled.adjustments).toContainEqual({ field: "resolution", asked: "1080p", used: "720p", reason: "not_offered" });
    expect(settleVideo(videoSpecFor("seedance-2.0-mini"), { resolution: "4k" }).resolution).toBe("720p");
    expect(settleVideo(videoSpecFor("seedance-2.5"), { resolution: "1080p" }).resolution).toBe("720p");
  });

  it("keeps 4k where the model takes it, instead of collapsing it to 720p", () => {
    expect(settleVideo(videoSpecFor("seedance-2.0"), { resolution: "4k" }).resolution).toBe("4k");
    expect(settleVideo(videoSpecFor("omni-fast"), { resolution: "2k" }).resolution).toBe("2k");
  });

  it("moves Veo's 5 s to 4 s (a tie goes to the shorter clip) and 7 s to 6 s", () => {
    expect(settleVideo(videoSpecFor("veo_3_1-fast"), { seconds: 5 }).seconds).toBe(4);
    expect(settleVideo(videoSpecFor("veo_3_1-fast"), { seconds: 7 }).seconds).toBe(6);
    expect(settleVideo(videoSpecFor("veo_3_1-fast"), { seconds: 12 }).seconds).toBe(8);
    expect(snapVideoSeconds("veo_3_1-fast", 5)).toBe(4);
  });

  it("takes any whole second in a range, and clamps outside it", () => {
    const fast = videoSpecFor("seedance-2.0-fast");
    expect(settleVideo(fast, { seconds: 11 }).seconds).toBe(11);
    expect(settleVideo(fast, { seconds: 2 })).toMatchObject({
      seconds: 4,
      adjustments: [{ field: "seconds", asked: 2, used: 4, reason: "out_of_range" }],
    });
    expect(settleVideo(fast, { seconds: 30 }).seconds).toBe(15);
    expect(settleVideo(videoSpecFor("seedance-2.5"), { seconds: 30 }).seconds).toBe(30);
    expect(settleVideo(videoSpecFor("kling-3.0-turbo"), { seconds: 15 }).seconds).toBe(15);
    expect(settleVideo(videoSpecFor("omni-fast"), { seconds: 30 }).seconds).toBe(30);
  });

  it("uses the model's default length, and 720p where offered", () => {
    expect(settleVideo(videoSpecFor("seedance-2.0-fast"), {})).toMatchObject({ seconds: 5, resolution: "720p", aspect: "16:9" });
    expect(settleVideo(videoSpecFor("kling-3.0-turbo"), {}).resolution).toBe("720p");
  });

  it("offers every ratio Seedance takes, and moves one it does not to the nearest", () => {
    const fast = videoSpecFor("seedance-2.0-fast");
    expect(settleVideo(fast, { aspect: "3:4" }).aspect).toBe("3:4");
    expect(settleVideo(fast, { aspect: "4:3" }).aspect).toBe("4:3");
    expect(settleVideo(fast, { aspect: "21:9" })).toMatchObject({
      aspect: "16:9",
      adjustments: [{ field: "aspect", asked: "21:9", used: "16:9", reason: "not_offered" }],
    });
    // Grok has two ratios: a square is a tie, and the tie keeps the default.
    expect(settleVideo(videoSpecFor("grok-imagine-video"), { aspect: "1:1" }).aspect).toBe("16:9");
    expect(settleVideo(videoSpecFor("grok-imagine-video"), { aspect: "3:4" }).aspect).toBe("9:16");
  });

  it("leaves out a control the model does not have, and says so", () => {
    const turbo = settleVideo(videoSpecFor("kling-3.0-turbo"), { aspect: "16:9" });
    expect(turbo.aspect).toBeUndefined();
    expect(turbo.adjustments).toContainEqual({ field: "aspect", asked: "16:9", used: undefined, reason: "not_supported" });
    const silent = settleVideo(videoSpecFor("kling-v3"), { resolution: "1080p" });
    expect(silent.resolution).toBeUndefined();
  });

  it("keeps sound off unless asked, and turns it on where the model has a switch", () => {
    const fast = videoSpecFor("seedance-2.0-fast");
    expect(settleVideo(fast, {}).audio).toBe(false);
    expect(settleVideo(fast, { audio: true }).audio).toBe(true);
    expect(settleVideo(videoSpecFor("kling-v3"), {}).audio).toBeUndefined();
    expect(settleVideo(videoSpecFor("kling-v3"), { audio: false }).audio).toBeUndefined();
  });

  it("refuses sound on a model that makes silent clips", () => {
    let caught: unknown;
    try {
      settleVideo(videoSpecFor("kling-v3"), { audio: true }, { model: "kling-v3" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("video_audio_unsupported");
    expect((caught as ApiError).message).toContain("kling-v3");
    expect(() => settleVideo(videoSpecFor("veo_3_1"), { audio: true })).toThrow(ApiError);
  });

  it("lists lengths a picker can show: a fixed set whole, a range thinned to round numbers", () => {
    expect(videoLengthOptions(videoSpecFor("veo_3_1"))).toEqual([4, 6, 8]);
    expect(videoLengthOptions(videoSpecFor("seedance-1.0-pro"))).toEqual([5, 10]);
    expect(videoLengthOptions(videoSpecFor("seedance-2.0-fast"))).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(videoLengthOptions(videoSpecFor("seedance-2.5"))).toEqual([4, 5, 6, 8, 10, 12, 15, 20, 25, 30]);
    expect(allowedVideoSeconds("kling-3.0-turbo")).toEqual([3, 5, 6, 8, 10, 12, 15]);
  });

  it("keeps the old capability flags, derived from the spec", () => {
    expect(videoCapabilities("seedance-2.0-fast")).toEqual({
      ratio: true,
      resolution: true,
      seconds: true,
      still: true,
      imageToVideo: true,
      audio: true,
    });
    expect(videoCapabilities("kling-3.0-turbo")).toMatchObject({ ratio: false, resolution: true, audio: false });
    expect(videoCapabilities("unknown-video-model").imageToVideo).toBe(false);
    expect(videoCapabilities("kling-v3-omni").imageToVideo).toBe(false);
  });
});

describe("settling an image request against a spec", () => {
  it("uses quality medium by default where the model has quality, and the model's own list", () => {
    const spec = imageSpecFor("gpt-image-2");
    expect(settleImage(spec, {})).toMatchObject({ shapeValue: "1024x1024", quality: "medium", count: 1 });
    expect(settleImage(spec, { quality: "high" }).quality).toBe("high");
    expect(settleImage(spec, { quality: "auto" }).quality).toBe("auto");
    expect(settleImage(spec, { quality: "ultra" })).toMatchObject({
      quality: "medium",
      adjustments: [{ field: "quality", asked: "ultra", used: "medium", reason: "not_offered" }],
    });
  });

  it("sends no quality to a model that has none", () => {
    const settled = settleImage(imageSpecFor("nano-banana-2"), { quality: "high" });
    expect(settled.quality).toBeUndefined();
    expect(settled.adjustments).toContainEqual({ field: "quality", asked: "high", used: undefined, reason: "not_supported" });
  });

  it("maps the loose shape to the nearest size the model takes, with no fuss", () => {
    const gpt = imageSpecFor("gpt-image-2");
    expect(settleImage(gpt, { shape: "landscape" })).toMatchObject({ shapeValue: "1536x1024", aspect: "3:2", adjustments: [] });
    expect(settleImage(gpt, { shape: "portrait" }).shapeValue).toBe("1024x1536");
    expect(settleImage(gpt, { shape: "square" }).shapeValue).toBe("1024x1024");
    expect(settleImage(imageSpecFor("nano-banana"), { shape: "landscape" }).shapeValue).toBe("3:2");
    expect(settleImage(imageSpecFor("totally-unknown-image"), { shape: "landscape" }).shapeValue).toBe("1024x1024");
  });

  it("takes an exact size it offers, and moves one it does not to the nearest", () => {
    const gpt = imageSpecFor("gpt-image-2");
    expect(settleImage(gpt, { size: "3840x2160" }).shapeValue).toBe("3840x2160");
    expect(settleImage(gpt, { size: "1500x1000" })).toMatchObject({
      shapeValue: "1536x1024",
      adjustments: [{ field: "size", asked: "1500x1000", used: "1536x1024", reason: "not_offered" }],
    });
    expect(settleImage(gpt, { aspectRatio: "16:9" }).shapeValue).toBe("2048x1152");
  });

  it("takes a ratio and a tier where the model has them", () => {
    const nano = imageSpecFor("nano-banana-2");
    expect(settleImage(nano, { aspectRatio: "4:3", tier: "2k" })).toMatchObject({ shapeValue: "4:3", tier: "2k" });
    expect(settleImage(nano, {}).tier).toBe("1k");
    expect(settleImage(nano, { tier: "8k" }).tier).toBe("4k");
    expect(settleImage(nano, { tier: "1024" }).tier).toBe("1k");
  });

  it("holds the count to one image where only one is verified, and to the model's max where it says more", () => {
    const gpt = imageSpecFor("gpt-image-2");
    expect(settleImage(gpt, { count: 3 })).toMatchObject({
      count: 1,
      adjustments: [{ field: "count", asked: 3, used: 1, reason: "not_supported" }],
    });
    const many = imageSpecFor("gpt-image-2", { countMax: 4 });
    expect(many.count).toEqual({ field: "n", max: 4, default: 1 });
    expect(many.source).toBe("published");
    expect(settleImage(many, { count: 3 }).count).toBe(3);
    expect(settleImage(many, { count: 9 })).toMatchObject({ count: 4, adjustments: [{ field: "count", reason: "out_of_range" }] });
  });

  it("takes an output format the model lists", () => {
    const gpt = imageSpecFor("gpt-image-2");
    expect(settleImage(gpt, { outputFormat: "jpeg" }).outputFormat).toBe("jpeg");
    expect(settleImage(gpt, { outputFormat: "gif" })).toMatchObject({ outputFormat: "png" });
    expect(settleImage(imageSpecFor("gpt-image-2.5-sunburst"), { outputFormat: "jpeg" }).outputFormat).toBeUndefined();
  });
});

describe("number helpers", () => {
  it("orders resolution tiers and reads ratios", () => {
    expect(tierRank("480p")).toBeLessThan(tierRank("720p") ?? 0);
    expect(tierRank("1080p")).toBeLessThan(tierRank("2k") ?? 0);
    expect(tierRank("4k")).toBe(4000);
    expect(tierRank("512")).toBe(512);
    expect(tierRank("big")).toBeUndefined();
    expect(ratioOf("16:9")).toBeCloseTo(1.7778, 3);
    expect(ratioOf("1536x1024")).toBe(1.5);
    expect(ratioOf("wide")).toBeUndefined();
  });
});
