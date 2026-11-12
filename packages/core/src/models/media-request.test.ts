import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { buildImageRequest, buildVideoRequest } from "./media-request";

/**
 * Each builder's output is compared with the example body the gateway's docs print for that model.
 * `docs llms-full.txt:<line>` is a line of the English section of the gateway's `llms-full.txt`
 * (research snapshot 2026-11-11). Where our body carries a field the example does not, the test says
 * which and why.
 */

function thrown(fn: () => unknown): { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("did not throw");
}

const OCEAN = "Ocean waves gently rolling onto a sandy beach at golden hour, cinematic";

describe("video builders against the documented bodies", () => {
  it("seedance-content: the generic body (docs llms-full.txt:5985-5996, field mapping :5975-5984)", () => {
    const request = buildVideoRequest({
      model: "doubao-seedance-2-0-260128",
      prompt: "A golden Shiba Inu running under cherry blossoms, camera slowly rising",
      choice: { resolution: "480p", aspect: "16:9", seconds: 5, audio: true },
    });
    expect(request.route).toBe("/v1/video/generations");
    expect(request.pollRoute).toBe("/v1/video/generations/{id}");
    // The documented example with the length where the route reads it (live 2026-11-12): `seconds`, as a STRING.
    // The docs example prints `duration`, which the route ignored; a number for `seconds` is a 400.
    expect(request.body).toEqual({
      model: "doubao-seedance-2-0-260128",
      prompt: "A golden Shiba Inu running under cherry blossoms, camera slowly rising",
      seconds: "5",
      size: "480p",
      metadata: { ratio: "16:9", generate_audio: true, watermark: false },
    });
    expect(request.sent).toEqual({ aspect: "16:9", seconds: 5, resolution: "480p", audio: true });
    expect(request.adjustments).toEqual([]);
  });

  it("seedance-content, image to video: `image` (docs llms-full.txt:6010-6020), a reference_image on Seedance 2", () => {
    const request = buildVideoRequest({
      model: "doubao-seedance-2-0-fast-260128",
      prompt: "Have the person in the frame slowly turn around and smile",
      imageUrl: "https://example.com/photo.jpg",
      choice: { resolution: "720p", aspect: "16:9", seconds: 5 },
    });
    expect(request.body).toEqual({
      model: "doubao-seedance-2-0-fast-260128",
      prompt: "Have the person in the frame slowly turn around and smile",
      image: "https://example.com/photo.jpg",
      seconds: "5",
      size: "720p",
      // Sound is always sent explicitly (off unless asked for), because the gateway's own default is on.
      metadata: { ratio: "16:9", generate_audio: false, watermark: false },
    });
  });

  it("seedance-content: the defaults, with sound off", () => {
    const request = buildVideoRequest({ model: "seedance-2.0-fast", prompt: "p", choice: {} });
    expect(request.body).toEqual({
      model: "seedance-2.0-fast",
      prompt: "p",
      seconds: "5",
      size: "720p",
      metadata: { ratio: "16:9", generate_audio: false, watermark: false },
    });
  });

  it("seedance-content: the longest clip seedance-2.0-fast made live (15 s), and no `duration` anywhere in the body", () => {
    // Live 2026-11-12: `seconds: "15"` came back as a 15.04 s clip; a `duration` beside it was ignored.
    const request = buildVideoRequest({
      model: "seedance-2.0-fast",
      prompt: "p",
      choice: { resolution: "480p", seconds: 15, aspect: "16:9", audio: false },
    });
    expect(request.body).toEqual({
      model: "seedance-2.0-fast",
      prompt: "p",
      seconds: "15",
      size: "480p",
      metadata: { ratio: "16:9", generate_audio: false, watermark: false },
    });
    expect(request.body).not.toHaveProperty("duration");
    expect(request.sent.seconds).toBe(15);
    expect(request.adjustments).toEqual([]);
  });

  it("seedance-content: a length past 15 s on a Seedance 2.0 moves to 15 and says so", () => {
    const request = buildVideoRequest({ model: "seedance-2.0-fast", prompt: "p", choice: { seconds: 16 } });
    expect(request.body.seconds).toBe("15");
    expect(request.adjustments).toContainEqual({ field: "seconds", asked: 16, used: 15, reason: "out_of_range" });
  });

  it("seedance-content: a 4 s, 3:4, sound-on body at 480p, every knob in the field the route reads", () => {
    const request = buildVideoRequest({
      model: "seedance-2.0-fast",
      prompt: "p",
      choice: { resolution: "480p", seconds: 4, aspect: "3:4", audio: true },
    });
    expect(request.body).toEqual({
      model: "seedance-2.0-fast",
      prompt: "p",
      seconds: "4",
      size: "480p",
      metadata: { ratio: "3:4", generate_audio: true, watermark: false },
    });
    // The official body's top-level fields are not read on this route (live 2026-11-11), so none is sent. Nor is
    // `duration` (ignored live 2026-11-12, even beside a `seconds` that was read).
    for (const dropped of ["ratio", "resolution", "generate_audio", "content", "watermark", "duration"]) {
      expect(request.body).not.toHaveProperty(dropped);
    }
  });

  it("seedance 1.x: no sound field, and its still is unverified", () => {
    const request = buildVideoRequest({ model: "seedance-1.0-pro", prompt: "p", imageUrl: "https://x/y.png", choice: {} });
    expect(request.body.image).toBe("https://x/y.png");
    expect(request.body.metadata).not.toHaveProperty("generate_audio");
  });

  it("grok-videos: aspect_ratio, video_length, resolution_name, preset (docs llms-full.txt:3698-3708)", () => {
    const request = buildVideoRequest({
      model: "grok-imagine-video-1.5-preview",
      prompt: "Make the person in the image wave at the camera",
      choice: { aspect: "9:16", seconds: 10, resolution: "720p" },
    });
    expect(request.route).toBe("/v1/videos");
    expect(request.pollRoute).toBe("/v1/videos/{id}");
    expect(request.body).toEqual({
      model: "grok-imagine-video-1.5-preview",
      prompt: "Make the person in the image wave at the camera",
      aspect_ratio: "9:16",
      video_length: 10,
      resolution_name: "720p",
      preset: "normal",
    });
    // `seconds` is never sent to Grok: a number there is a 400 (probe 2026-11-11), `video_length` is the field.
    expect(request.body).not.toHaveProperty("seconds");
  });

  it("grok-videos: a still goes as `image` (docs llms-full.txt:3710)", () => {
    const request = buildVideoRequest({ model: "grok-imagine-video", prompt: "p", imageUrl: "data:image/png;base64,AAAA", choice: {} });
    expect(request.body).toMatchObject({ image: "data:image/png;base64,AAAA", aspect_ratio: "16:9", video_length: 6 });
  });

  it("grok-videos: 1080p is moved to 720p and reported, not hidden", () => {
    const request = buildVideoRequest({ model: "grok-imagine-video", prompt: "p", choice: { resolution: "1080p" } });
    expect(request.body).toMatchObject({ resolution_name: "720p" });
    expect(request.adjustments).toContainEqual({ field: "resolution", asked: "1080p", used: "720p", reason: "not_offered" });
  });

  it("omni-fast: seconds as a string, to /v1/videos (docs llms-full.txt:5707-5717)", () => {
    const request = buildVideoRequest({
      model: "omni-fast",
      prompt: OCEAN,
      choice: { seconds: 8, aspect: "16:9", resolution: "720p" },
    });
    expect(request.route).toBe("/v1/videos");
    expect(request.body).toEqual({
      model: "omni-fast",
      prompt: OCEAN,
      seconds: "8",
      aspect_ratio: "16:9",
      resolution: "720p",
    });
  });

  it("omni-fast: a first frame goes as first_image_url (docs llms-full.txt:5662)", () => {
    const request = buildVideoRequest({ model: "omni-fast", prompt: "p", imageUrl: "https://x/a.png", choice: {} });
    expect(request.body).toMatchObject({ first_image_url: "https://x/a.png" });
  });

  it("kling-native: model_name, duration as a string, aspect_ratio (docs llms-full.txt:4977-4987)", () => {
    const request = buildVideoRequest({
      model: "kling-v2-6",
      prompt: "A cat runs through a neon street on a rainy night.",
      choice: { seconds: 5, aspect: "16:9" },
    });
    expect(request.route).toBe("/kling/v1/videos/text2video");
    expect(request.pollRoute).toBe("/kling/v1/videos/text2video/{id}");
    expect(request.body).toEqual({
      model_name: "kling-v2-6",
      prompt: "A cat runs through a neon street on a rainy night.",
      duration: "5",
      aspect_ratio: "16:9",
    });
  });

  it("kling-native, image to video: /image2video with `image` (docs llms-full.txt:4677-4687)", () => {
    const request = buildVideoRequest({
      model: "kling-v2-6",
      prompt: "The person slowly turns toward the camera.",
      imageUrl: "https://your-cdn.com/start-frame.png",
      choice: { seconds: 5, aspect: "16:9" },
    });
    expect(request.route).toBe("/kling/v1/videos/image2video");
    expect(request.pollRoute).toBe("/kling/v1/videos/image2video/{id}");
    expect(request.body).toEqual({
      model_name: "kling-v2-6",
      image: "https://your-cdn.com/start-frame.png",
      prompt: "The person slowly turns toward the camera.",
      duration: "5",
      aspect_ratio: "16:9",
    });
  });

  it("kling-omni: contents and settings (docs llms-full.txt:4913-4923)", () => {
    const request = buildVideoRequest({
      model: "kling-v3-omni",
      prompt: "A character walks into a rainy street and speaks.",
      choice: { seconds: 5, aspect: "16:9" },
    });
    expect(request.route).toBe("/kling/v1/videos/omni-video");
    expect(request.pollRoute).toBe("/kling/v1/videos/omni-video/{id}");
    expect(request.body).toEqual({
      model_name: "kling-v3-omni",
      contents: [{ type: "prompt", text: "A character walks into a rainy street and speaks." }],
      settings: { duration: 5, aspect_ratio: "16:9" },
    });
  });

  it("kling-turbo, image to video: its own route, contents and settings (docs llms-full.txt:5040-5055)", () => {
    const request = buildVideoRequest({
      model: "kling-3.0-turbo",
      prompt: "A girl sat on the train, looking out the window.",
      imageUrl: "https://your-cdn.com/start-frame.jpg",
      choice: { resolution: "1080p", seconds: 10 },
    });
    expect(request.route).toBe("/kling/image-to-video/kling-3.0-turbo");
    expect(request.pollRoute).toBe("/kling/tasks?task_ids={id}");
    expect(request.body).toEqual({
      contents: [
        { type: "prompt", text: "A girl sat on the train, looking out the window." },
        { type: "first_frame", url: "https://your-cdn.com/start-frame.jpg" },
      ],
      settings: { resolution: "1080p", duration: 10 },
      // The documented example also sets callback_url and external_task_id; only the watermark switch is sent.
      options: { watermark_info: { enabled: false } },
    });
  });

  it("kling-turbo, text to video: /text-to-video (docs llms-full.txt:5017)", () => {
    const request = buildVideoRequest({ model: "kling-3.0-turbo", prompt: "p", choice: {} });
    expect(request.route).toBe("/kling/text-to-video/kling-3.0-turbo");
    expect(request.body).toEqual({
      contents: [{ type: "prompt", text: "p" }],
      settings: { resolution: "720p", duration: 5 },
      options: { watermark_info: { enabled: false } },
    });
  });

  it("veo-generic: duration and size on the generic route (p_video_create-video-generation example)", () => {
    const request = buildVideoRequest({
      model: "veo_3_1",
      prompt: "A robotic arm assembling chips in a modern factory",
      choice: { seconds: 8, aspect: "16:9", resolution: "720p" },
    });
    expect(request.route).toBe("/v1/video/generations");
    expect(request.body).toEqual({
      model: "veo_3_1",
      prompt: "A robotic arm assembling chips in a modern factory",
      duration: 8,
      size: "16:9",
      // The documented example has no resolution; `resolution` is a field of the generic body.
      resolution: "720p",
    });
  });

  it("openai-video: an unknown model gets prompt and duration, never both seconds and duration", () => {
    const request = buildVideoRequest({ model: "totally-unknown-video", prompt: "p", choice: { seconds: 9, aspect: "16:9" } });
    expect(request.route).toBe("/v1/video/generations");
    expect(request.body).toEqual({ model: "totally-unknown-video", prompt: "p", duration: 5 });
    expect(request.body).not.toHaveProperty("seconds");
    expect(request.sent).toEqual({ seconds: 5 });
  });

  it("refuses a still for a model that takes none, and sound for a model that makes silent clips", () => {
    expect(
      thrown(() => buildVideoRequest({ model: "kling-v3-omni", prompt: "p", imageUrl: "https://x/a.png", choice: {} })).code,
    ).toBe("video_still_unsupported");
    const silent = thrown(() => buildVideoRequest({ model: "grok-imagine-video", prompt: "p", choice: { audio: true } }));
    expect(silent).toBeInstanceOf(ApiError);
    expect(silent.code).toBe("video_audio_unsupported");
  });

  it("uses the field names a published spec carries", () => {
    const request = buildVideoRequest({
      model: "seedance-2.0-fast",
      prompt: "p",
      choice: { resolution: "1080p" },
      published: { hasContent: true, resolutionEnum: ["480p", "720p", "1080p"], audio: { default: true } },
    });
    expect(request.body).toMatchObject({ size: "1080p" });
    expect(request.adjustments).toEqual([]);
  });
});

describe("image builders against the documented bodies", () => {
  it("openai-image: size and quality (docs llms-full.txt:4321-4326)", () => {
    const request = buildImageRequest({
      model: "gpt-image-2",
      prompt: "a red panda eating bamboo, flat vector illustration",
      choice: { size: "1024x1024", quality: "medium" },
    });
    expect(request.route).toBe("/v1/images/generations");
    expect(request.body).toEqual({
      model: "gpt-image-2",
      prompt: "a red panda eating bamboo, flat vector illustration",
      size: "1024x1024",
      quality: "medium",
    });
  });

  it("openai-image: a landscape size at high quality (docs llms-full.txt:3991-3998)", () => {
    const request = buildImageRequest({
      model: "gpt-image-2",
      prompt: "A cinematic product photo of a ceramic cup",
      choice: { size: "1536x1024", quality: "high" },
    });
    expect(request.body).toEqual({
      model: "gpt-image-2",
      prompt: "A cinematic product photo of a ceramic cup",
      size: "1536x1024",
      quality: "high",
    });
  });

  it("openai-image: the default is quality medium, one image, no format (the app's choice, not the gateway's low)", () => {
    const request = buildImageRequest({ model: "gpt-image-2", prompt: "p", choice: { shape: "landscape" } });
    expect(request.body).toEqual({ model: "gpt-image-2", prompt: "p", size: "1536x1024", quality: "medium" });
    expect(request.sent).toMatchObject({ shapeValue: "1536x1024", aspect: "3:2", quality: "medium", count: 1 });
  });

  it("openai-image: an edit goes to /v1/images/edits with `image` (docs llms-full.txt:4334-4343)", () => {
    const request = buildImageRequest({
      model: "gpt-image-2",
      prompt: "make the mug matte black, keep the composition unchanged",
      imageUrl: "https://your-cdn/reference.png",
      choice: { size: "3840x2160", quality: "medium" },
    });
    expect(request.route).toBe("/v1/images/edits");
    expect(request.body).toEqual({
      model: "gpt-image-2",
      prompt: "make the mug matte black, keep the composition unchanged",
      image: "https://your-cdn/reference.png",
      size: "3840x2160",
      quality: "medium",
    });
    expect(request.file).toBeUndefined();
  });

  it("openai-image: a local picture goes up as a multipart file, not as a URL the gateway cannot fetch", () => {
    const request = buildImageRequest({
      model: "gpt-image-2",
      prompt: "p",
      imageUrl: "data:image/png;base64,AAAA",
      choice: {},
    });
    expect(request.route).toBe("/v1/images/edits");
    expect(request.file).toEqual({ field: "image", dataUrl: "data:image/png;base64,AAAA" });
    expect(request.body).not.toHaveProperty("image");
  });

  it("openai-image: output_format is sent when chosen or not the default, and response_format never", () => {
    expect(buildImageRequest({ model: "gpt-image-2", prompt: "p", choice: { outputFormat: "jpeg" } }).body).toMatchObject({
      output_format: "jpeg",
    });
    expect(buildImageRequest({ model: "gpt-image-2", prompt: "p", choice: {} }).body).not.toHaveProperty("output_format");
    expect(buildImageRequest({ model: "gpt-image-2", prompt: "p", choice: { outputFormat: "jpeg" } }).body).not.toHaveProperty(
      "response_format",
    );
  });

  it("nano-banana: images, aspect_ratio, resolution, output_format (docs llms-full.txt:3963-3975)", () => {
    const request = buildImageRequest({
      model: "nano-banana-2",
      prompt: "Replace the item in the poster with a cup",
      imageUrl: "https://example.com/input.png",
      choice: { aspectRatio: "4:3", tier: "2k", outputFormat: "png" },
    });
    expect(request.route).toBe("/v1/images/edits");
    expect(request.body).toEqual({
      model: "nano-banana-2",
      prompt: "Replace the item in the poster with a cup",
      images: ["https://example.com/input.png"],
      aspect_ratio: "4:3",
      resolution: "2k",
      output_format: "png",
      // The documented example also sets enable_web_search and enable_image_search to false: both are
      // optional, default off, and not sent.
    });
  });

  it("nano-banana: no quality field, whatever was asked", () => {
    const request = buildImageRequest({ model: "nano-banana", prompt: "p", choice: { quality: "high" } });
    expect(request.body).toEqual({ model: "nano-banana", prompt: "p", aspect_ratio: "1:1", resolution: "1k" });
    expect(request.adjustments).toContainEqual({ field: "quality", asked: "high", used: undefined, reason: "not_supported" });
  });

  it("gemini-image: response_format b64_json (docs llms-full.txt:4393-4399)", () => {
    const request = buildImageRequest({
      model: "gemini-2.5-flash-image-preview",
      prompt: "a red panda eating bamboo, flat vector illustration",
      choice: { size: "1024x1024" },
    });
    expect(request.route).toBe("/v1/images/generations");
    expect(request.body).toEqual({
      model: "gemini-2.5-flash-image-preview",
      prompt: "a red panda eating bamboo, flat vector illustration",
      size: "1024x1024",
      response_format: "b64_json",
      // The documented example also sends n: 1, which is the default and is left out.
    });
  });

  it("seedream and grok-image: the shape each is assumed to read (unverified, see the spec)", () => {
    expect(buildImageRequest({ model: "seedream-4.5", prompt: "p", choice: { shape: "landscape" } }).body).toEqual({
      model: "seedream-4.5",
      prompt: "p",
      size: "2304x1728",
    });
    expect(buildImageRequest({ model: "grok-imagine-image", prompt: "p", choice: { shape: "portrait" } }).body).toEqual({
      model: "grok-imagine-image",
      prompt: "p",
      aspect_ratio: "2:3",
    });
  });

  it("generic-image: an unknown model gets a square and nothing else", () => {
    expect(buildImageRequest({ model: "wan2.7-image", prompt: "p", choice: { shape: "landscape", quality: "high" } }).body).toEqual({
      model: "wan2.7-image",
      prompt: "p",
      size: "1024x1024",
    });
  });

  it("gpt-image-2.5: quality medium and a square by default, the body driven live on flare and sunburst (2026-11-12)", () => {
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      expect(buildImageRequest({ model, prompt: "p", choice: {} }).body, model).toEqual({
        model,
        prompt: "p",
        size: "1024x1024",
        quality: "medium",
      });
    }
  });

  it("gpt-image-2.5: the two other sizes drawn live go through, a size nobody drove moves to the nearest, and low and high become medium", () => {
    const wide = buildImageRequest({ model: "gpt-image-2.5-flare", prompt: "p", choice: { size: "1536x1024" } });
    expect(wide.body).toMatchObject({ size: "1536x1024", quality: "medium" });
    const tall = buildImageRequest({ model: "gpt-image-2.5-flare", prompt: "p", choice: { shape: "portrait" } });
    expect(tall.body).toMatchObject({ size: "1024x1536" });
    const moved = buildImageRequest({
      model: "gpt-image-2.5-flare",
      prompt: "p",
      choice: { size: "2048x2048", quality: "high" },
    });
    expect(moved.body).toMatchObject({ size: "1024x1024", quality: "medium" });
    expect(moved.adjustments.map((item) => item.field).sort()).toEqual(["quality", "size"]);
  });

  it("gpt-image-2.5 variants nobody drove (-count, -token): no quality is invented, a square only", () => {
    expect(buildImageRequest({ model: "gpt-image-2.5-flare-count", prompt: "p", choice: {} }).body).toEqual({
      model: "gpt-image-2.5-flare-count",
      prompt: "p",
      size: "1024x1024",
    });
  });

  it("refuses a reference picture for a model that takes none", () => {
    expect(
      thrown(() =>
        buildImageRequest({ model: "gpt-image-2.5-sunburst", prompt: "p", imageUrl: "https://x/a.png", choice: {} }),
      ).code,
    ).toBe("image_input_unsupported");
  });

  it("sends n when the model says it makes more than one", () => {
    const request = buildImageRequest({
      model: "gpt-image-2",
      prompt: "p",
      choice: { count: 2 },
      published: { countMax: 4 },
    });
    expect(request.body).toMatchObject({ n: 2 });
    expect(request.sent.count).toBe(2);
  });
});
