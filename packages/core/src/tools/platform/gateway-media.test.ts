import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors";
import { classifyGatewayRefusal, GatewayRefusalError } from "../../models/availability";
import {
  buildGatewayVideoPayload,
  extractGatewayVideoUrl,
  formatVideoGatewayFailure,
  generateGatewayImage,
  generateGatewayVideo,
  openaiImageSize,
  parseGatewayImage,
  readGatewayError,
  readVideoJobFailure,
  studioVideoFailureStatus,
  videoCapabilities,
  videoTaskId,
} from "./gateway-media";

describe("parse helpers", () => {
  it("reads OpenAI url and b64 image payloads", () => {
    expect(parseGatewayImage({ data: [{ url: "https://cdn.example/a.png" }] })).toBe("https://cdn.example/a.png");
    expect(parseGatewayImage({ data: [{ b64_json: "abc" }] })).toBe("data:image/png;base64,abc");
    expect(parseGatewayImage({ data: [{ file_output: { public_url: "https://cdn.example/fo.png" } }] })).toBe(
      "https://cdn.example/fo.png",
    );
  });

  it("reads nested, object, and top-level image URL shapes", () => {
    expect(parseGatewayImage({ data: { result_url: "https://cdn.example/r.png", status: "SUCCESS" } })).toBe(
      "https://cdn.example/r.png",
    );
    expect(parseGatewayImage({ data: { url: "https://cdn.example/obj.png" } })).toBe("https://cdn.example/obj.png");
    expect(parseGatewayImage({ data: { data: [{ url: "https://cdn.example/nested.png" }] } })).toBe(
      "https://cdn.example/nested.png",
    );
    expect(parseGatewayImage({ url: "https://cdn.example/top.png" })).toBe("https://cdn.example/top.png");
  });

  it("reads NewAPI video task ids and result URLs", () => {
    expect(videoTaskId({ task_id: "abcd", id: "video_123" })).toBe("abcd");
    expect(videoTaskId({ id: "video_123" })).toBe("video_123");
    expect(extractGatewayVideoUrl({ data: { result_url: "https://cdn.example/a.mp4" } })).toBe(
      "https://cdn.example/a.mp4",
    );
    expect(extractGatewayVideoUrl({ status: "succeeded", content_url: "https://cdn.example/c.mp4" })).toBe(
      "https://cdn.example/c.mp4",
    );
    expect(extractGatewayVideoUrl({ status: "succeeded", url: "https://cdn.example/b.mp4" })).toBe(
      "https://cdn.example/b.mp4",
    );
  });

  it("surfaces new_api_error messages", () => {
    expect(
      readGatewayError(
        { error: { type: "new_api_error", code: "model_not_found", message: "No available channel" } },
        "fallback",
      ),
    ).toBe("No available channel");
  });

  it("treats a prepaid code-only body as prepaid, not a rejected key", () => {
    const detail = readGatewayError({ code: "prepaid_async_requires_fixed_price", data: null }, "HTTP 403");
    expect(detail).toBe("prepaid_async_requires_fixed_price");
    const message = formatVideoGatewayFailure(403, detail);
    expect(message).not.toMatch(/rejected the API key/i);
    expect(studioVideoFailureStatus(message)).toBe(400);
  });

  it("maps aspect ratios to OpenAI image sizes", () => {
    expect(openaiImageSize("square")).toBe("1024x1024");
    expect(openaiImageSize("landscape")).toBe("1536x1024");
    expect(openaiImageSize("portrait")).toBe("1024x1536");
  });

  it("sends Seedance content + duration × 720p, not OpenAI prompt/size", () => {
    expect(buildGatewayVideoPayload({ model: "seedance-2.0-fast", prompt: "hero", aspectRatio: "16:9" })).toEqual({
      model: "seedance-2.0-fast",
      prompt: "hero",
      content: [{ type: "text", text: "hero" }],
      duration: 5,
      resolution: "720p",
      ratio: "16:9",
      generate_audio: false,
      watermark: false,
    });
    expect(
      buildGatewayVideoPayload({
        model: "seedance-2.0-mini",
        prompt: "hero",
        aspectRatio: "9:16",
        imageUrl: "https://cdn.example/still.png",
      }),
    ).toMatchObject({
      content: [
        { type: "text", text: "hero" },
        { type: "image_url", image_url: { url: "https://cdn.example/still.png" }, role: "first_frame" },
      ],
      image: "https://cdn.example/still.png",
      ratio: "9:16",
    });
    expect(buildGatewayVideoPayload({ model: "veo_3_1-fast", prompt: "hero", aspectRatio: "16:9" })).not.toHaveProperty(
      "image",
    );
    expect(
      buildGatewayVideoPayload({
        model: "veo_3_1-fast",
        prompt: "hero",
        imageUrl: "data:image/png;base64,AAAA",
        seconds: 4,
      }),
    ).toMatchObject({ image: "data:image/png;base64,AAAA", duration: 4 });
    // An id on neither the Seedance wire nor the Grok one keeps the plain prompt/duration body.
    expect(buildGatewayVideoPayload({ model: "omni-fast-v2v", prompt: "rain", aspectRatio: "16:9" })).toEqual({
      model: "omni-fast-v2v",
      prompt: "rain",
      duration: 5,
      seconds: "5",
    });
    expect(buildGatewayVideoPayload({ model: "omni-fast-v2v", prompt: "rain" })).not.toHaveProperty("size");
    expect(buildGatewayVideoPayload({ model: "omni-fast-v2v", prompt: "rain" })).not.toHaveProperty("ratio");
    expect(buildGatewayVideoPayload({ model: "omni-fast-v2v", prompt: "rain" })).not.toHaveProperty("resolution");
  });

  it("sends the documented Grok body for /v1/videos (2026-11-11)", () => {
    // Docs, "Grok Video Generation": aspect_ratio, video_length, resolution_name, preset. `seconds` is not
    // sent: as a number it is a 400, and `video_length` is the field the docs name.
    expect(buildGatewayVideoPayload({ model: "grok-imagine-video", prompt: "rain", aspectRatio: "16:9" })).toEqual({
      model: "grok-imagine-video",
      prompt: "rain",
      aspect_ratio: "16:9",
      video_length: 5,
      resolution_name: "720p",
      preset: "normal",
    });
    expect(
      buildGatewayVideoPayload({
        model: "grok-imagine-video-1.5-preview",
        prompt: "wave",
        aspectRatio: "9:16",
        seconds: 8,
        resolution: "480p",
        imageUrl: "https://cdn.example/still.png",
      }),
    ).toEqual({
      model: "grok-imagine-video-1.5-preview",
      prompt: "wave",
      aspect_ratio: "9:16",
      video_length: 8,
      resolution_name: "480p",
      preset: "normal",
      image: "https://cdn.example/still.png",
    });
    // Grok has no 1080p; it is asked for 720p rather than a value the route refuses.
    expect(buildGatewayVideoPayload({ model: "grok-imagine-video", prompt: "x", resolution: "1080p" })).toMatchObject({
      resolution_name: "720p",
    });
  });

  it("applies seconds and resolution knobs only where the wire supports them", () => {
    expect(
      buildGatewayVideoPayload({
        model: "seedance-2.0-fast",
        prompt: "hero",
        aspectRatio: "16:9",
        seconds: 10,
        resolution: "1080p",
      }),
    ).toMatchObject({
      duration: 10,
      resolution: "1080p",
      ratio: "16:9",
    });
    expect(
      buildGatewayVideoPayload({
        model: "seedance-2.0-fast",
        prompt: "hero",
        seconds: 1,
        resolution: "4k",
      }),
    ).toMatchObject({ duration: 2, resolution: "720p" });
    expect(
      buildGatewayVideoPayload({
        model: "omni-fast-v2v",
        prompt: "rain",
        aspectRatio: "9:16",
        seconds: 8,
        resolution: "1080p",
        imageUrl: "https://cdn.example/still.png",
      }),
    ).toEqual({
      model: "omni-fast-v2v",
      prompt: "rain",
      duration: 8,
      seconds: "8",
      image: "https://cdn.example/still.png",
    });
    expect(videoCapabilities("seedance-2.0-fast")).toEqual({
      ratio: true,
      resolution: true,
      seconds: true,
      still: true,
      imageToVideo: true,
    });
    expect(videoCapabilities("grok-imagine-video")).toEqual({
      ratio: false,
      resolution: false,
      seconds: true,
      still: true,
      imageToVideo: true,
    });
  });

  it("does not call a prepaid async-price 403 an invalid API key", () => {
    const message = formatVideoGatewayFailure(403, "代理预付账户的异步任务仅支持发送前可确定上限的固定按次价格");
    expect(message).not.toMatch(/rejected the API key/i);
    // Corrected 2026-11-11: a prepaid key DID run seedance-2.0-fast. The refusal is per model, not "Seedance".
    expect(message).toMatch(/billed by tokens after the job finishes/i);
    expect(message).toMatch(/seedance-2\.0-fast/);
    expect(message).not.toMatch(/Seedance video on this gateway/i);
    expect(studioVideoFailureStatus(message)).toBe(400);
  });
});

describe("generateGatewayImage", () => {
  it("POSTs /images/generations and does not send response_format", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/out.png" }] }),
    });
    const result = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a lantern",
      aspectRatio: "square",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/images/generations");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-image-2",
      prompt: "a lantern",
      size: "1024x1024",
      quality: "medium",
    });
    expect(result).toEqual({ url: "https://cdn.example/out.png", model: "gpt-image-2" });
  });

  it("sends quality medium for gpt-image models and omits it for others", async () => {
    const gptFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/gpt.png" }] }),
    });
    await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a",
      fetchImpl: gptFetch as unknown as typeof fetch,
    });
    expect(JSON.parse(String((gptFetch.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      quality: "medium",
    });

    const otherFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/other.png" }] }),
    });
    await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "flux-schnell",
      prompt: "a",
      fetchImpl: otherFetch as unknown as typeof fetch,
    });
    expect(JSON.parse(String((otherFetch.mock.calls[0]?.[1] as RequestInit).body))).not.toHaveProperty("quality");
  });

  it("succeeds when HTTP is not ok but the body still contains an image URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: { message: "need quota" },
        data: [{ url: "https://cdn.example/a.png" }],
      }),
    });
    const result = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a lantern",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ url: "https://cdn.example/a.png", model: "gpt-image-2" });
  });

  it("polls GET /images/generations/{id} when POST returns a task id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task_id: "img_1", status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { status: "SUCCESS", result_url: "https://cdn.example/done.png" },
        }),
      });
    const result = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a lantern",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/images/generations");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/v1/images/generations/img_1");
    expect(result).toEqual({ url: "https://cdn.example/done.png", model: "gpt-image-2" });
  });

  it("tags a polled job's failure as poll, so it cannot hide the model", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task_id: "img_1", status: "processing" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: "failed", fail_reason: "bad_response_status_code" } }),
      });
    const error = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a lantern",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayRefusalError);
    expect((error as GatewayRefusalError).refusal).toMatchObject({ status: 200, phase: "poll" });
    // The words alone would read as `upstream_rejected`; the phase is what keeps the model offered.
    expect(classifyGatewayRefusal((error as GatewayRefusalError).refusal)).toBeNull();
  });

  it("tells the caller not to retry when the fetch times out", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    await expect(
      generateGatewayImage({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "gpt-image-2",
        prompt: "a lantern",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/billed|do not retry|already/i) });
  });

  it("throws the gateway error body on 503 without an image URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          type: "new_api_error",
          code: "model_not_found",
          message: "No available channel for model gpt-image-2",
        },
      }),
    });
    await expect(
      generateGatewayImage({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "gpt-image-2",
        prompt: "a lantern",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ message: "No available channel for model gpt-image-2" });
  });
});

describe("generateGatewayVideo", () => {
  it("POSTs /video/generations then polls GET /video/generations/{id}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: "video_123", task_id: "abcd", status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: "success",
          data: { task_id: "abcd", status: "SUCCESS", result_url: "https://cdn.example/clip.mp4" },
        }),
      });
    const result = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "omni-fast-v2v",
      prompt: "rain on a window",
      aspectRatio: "16:9",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/video/generations");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "omni-fast-v2v",
      prompt: "rain on a window",
      duration: 5,
      seconds: "5",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/v1/video/generations/abcd");
    expect(result).toEqual({ url: "https://cdn.example/clip.mp4", model: "omni-fast-v2v" });
  });

  it("POSTs /videos for Grok and polls GET /videos/{id}, reading video_url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "video_55c7", status: "queued" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "video_55c7", status: "completed", video_url: "https://cdn.example/grok.mp4" }),
      });
    const result = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "grok-imagine-video",
      prompt: "rain",
      aspectRatio: "16:9",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/videos");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/v1/videos/video_55c7");
    expect(result).toEqual({ url: "https://cdn.example/grok.mp4", model: "grok-imagine-video" });
  });

  it("carries the gateway's status and code on a refusal, so the host can learn from it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: "prepaid accounts only take fixed prices", code: "prepaid_async_requires_fixed_price" },
      }),
    });
    const error = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "grok-imagine-video",
      prompt: "rain",
      fetchImpl: fetchMock as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GatewayRefusalError);
    expect((error as GatewayRefusalError).refusal).toMatchObject({
      status: 403,
      code: "prepaid_async_requires_fixed_price",
    });
  });

  it("returns immediately when submit already has a URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ url: "https://cdn.example/ready.mp4" }),
    });
    const result = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "grok-imagine-video",
      prompt: "rain",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.url).toBe("https://cdn.example/ready.mp4");
  });

  it("throws when the poll reports failure or the job times out", async () => {
    const failed = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task_id: "abcd", status: "processing" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: "failed", fail_reason: "quota" } }),
      });
    const pollFailure = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "grok-imagine-video",
      prompt: "rain",
      fetchImpl: failed as unknown as typeof fetch,
      wait: async () => undefined,
    }).catch((caught: unknown) => caught);
    expect(pollFailure).toBeInstanceOf(GatewayRefusalError);
    expect((pollFailure as GatewayRefusalError).message).toMatch(/quota|failed/i);
    expect((pollFailure as GatewayRefusalError).refusal).toMatchObject({ status: 200, phase: "poll" });
    // A job the gateway accepted and then failed teaches nothing about the model.
    expect(classifyGatewayRefusal((pollFailure as GatewayRefusalError).refusal)).toBeNull();

    const timedOut = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: "abcd", status: "processing" }),
    });
    await expect(
      generateGatewayVideo({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "grok-imagine-video",
        prompt: "rain",
        fetchImpl: timedOut as unknown as typeof fetch,
        wait: async () => undefined,
        maxPolls: 2,
        pollMs: 1,
      }),
    ).rejects.toMatchObject({ message: "Gateway video job timed out" });
  });

  it("does not call /videos/generations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Model name not specified, model name cannot be empty" } }),
    });
    await expect(
      generateGatewayVideo({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "",
        prompt: "x",
        fetchImpl: fetchMock as unknown as typeof fetch,
        wait: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/videos/generations");
  });

  it("maps HTTP 503 to a visible no-channel message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: "No available channel" } }),
    });
    await expect(
      generateGatewayVideo({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "happyhorse",
        prompt: "rain",
        fetchImpl: fetchMock as unknown as typeof fetch,
        wait: async () => undefined,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/HTTP 503.*seedance-2\.0-fast/i),
    });
  });
});

describe("video job failure parsing", () => {
  const upstreamRejected = {
    code: "success",
    message: "",
    data: {
      status: "FAILURE",
      fail_reason: "上游拒绝了该请求，请稍后重试",
      result_url: "上游拒绝了该请求，请稍后重试",
      data: {
        status: "failed",
        error: { code: "service_unavailable", message: "上游拒绝了该请求，请稍后重试" },
      },
    },
  };

  it("prefers the job fail reason over a top-level success code", () => {
    expect(readVideoJobFailure(upstreamRejected, "fallback")).toBe(
      "上游拒绝了该请求，请稍后重试 (service_unavailable)",
    );
    expect(readVideoJobFailure({ data: { status: "failed", fail_reason: "quota" } }, "fallback")).toBe("quota");
    expect(readVideoJobFailure({ data: { status: "failed" } }, "fallback")).toBe("fallback");
  });

  it("never reports a success code as the error text", () => {
    expect(readGatewayError({ code: "success", message: "" }, "fallback")).toBe("fallback");
    expect(readGatewayError({ code: "ok" }, "fallback")).toBe("fallback");
    expect(readGatewayError({ code: "insufficient_quota" }, "fallback")).toBe("insufficient_quota");
  });

  it("does not mistake a failure message in result_url for a video url", () => {
    expect(extractGatewayVideoUrl({ data: { result_url: "上游拒绝了该请求" } })).toBeUndefined();
    expect(extractGatewayVideoUrl({ data: { result_url: "https://cdn.example/a.mp4" } })).toBe(
      "https://cdn.example/a.mp4",
    );
    expect(extractGatewayVideoUrl({ video: "data:video/mp4;base64,AAAA" })).toBe("data:video/mp4;base64,AAAA");
  });

  it("surfaces the upstream rejection from the poll instead of 'success'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task_id: "abcd", status: "queued" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => upstreamRejected });
    let caught: unknown;
    try {
      await generateGatewayVideo({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "grok-imagine-video",
        prompt: "rain",
        fetchImpl: fetchMock as unknown as typeof fetch,
        wait: async () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const message = (caught as ApiError).message;
    expect(message).not.toBe("success");
    expect(message).toContain("上游拒绝了该请求，请稍后重试");
    expect(message).toMatch(/upstream/i);
    expect((caught as ApiError).status).toBe(503);
    expect(studioVideoFailureStatus(message)).toBe(503);
  });
});
