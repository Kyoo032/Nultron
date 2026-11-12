import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../errors";
import { classifyGatewayRefusal, GatewayRefusalError } from "../../models/availability";
import { buildVideoRequest } from "../../models/media-request";
import {
  extractGatewayVideoUrl,
  formatVideoGatewayFailure,
  generateGatewayImage,
  generateGatewayVideo,
  parseGatewayImage,
  parseGatewayImages,
  readGatewayError,
  readVideoJobFailure,
  studioVideoFailureStatus,
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

  it("builds each request from the model's spec, not from the id", () => {
    // The exhaustive body-by-body checks against the documented examples are in
    // `models/media-request.test.ts`; these pin what the gateway wire now relies on.
    expect(buildVideoRequest({ model: "seedance-2.0-fast", prompt: "hero", choice: { aspect: "16:9" } }).body).toEqual({
      model: "seedance-2.0-fast",
      prompt: "hero",
      // The length is the string `seconds` (live 2026-11-12); a number is a 400 and `duration` is ignored.
      seconds: "5",
      size: "720p",
      metadata: { ratio: "16:9", generate_audio: false, watermark: false },
    });
    expect(buildVideoRequest({ model: "omni-fast-v2v", prompt: "rain", choice: { aspect: "16:9" } }).route).toBe("/v1/videos");
    expect(buildVideoRequest({ model: "grok-imagine-video", prompt: "rain", choice: {} }).body).toEqual({
      model: "grok-imagine-video",
      prompt: "rain",
      aspect_ratio: "16:9",
      video_length: 6,
      resolution_name: "720p",
      preset: "normal",
    });
  });

  it("reads a Kling reply: task_status, task_result and the Kling failure message", () => {
    // Kling's public API shape. Not driven live: this key has no Kling channel (HTTP 503).
    expect(
      extractGatewayVideoUrl({ data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example/k.mp4" }] } } }),
    ).toBe("https://cdn.example/k.mp4");
    expect(readVideoJobFailure({ data: { task_status: "failed", task_status_msg: "content policy" } }, "x")).toBe(
      "content policy",
    );
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
    expect(result).toMatchObject({ url: "https://cdn.example/out.png", urls: ["https://cdn.example/out.png"], model: "gpt-image-2" });
    // What was actually sent comes back with the result, so the caller can say so.
    expect(result.sent).toMatchObject({ shapeValue: "1024x1024", quality: "medium", count: 1 });
    expect(result.adjusted).toEqual([]);
  });

  it("sends the size, quality and format the person chose, in the fields the model reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: "AAAA" }] }),
    });
    const result = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-2",
      prompt: "a lantern",
      imageChoice: { size: "1536x1024", quality: "low", outputFormat: "jpeg" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "gpt-image-2",
      prompt: "a lantern",
      size: "1536x1024",
      quality: "low",
      output_format: "jpeg",
    });
    // A base64 reply is labelled with the format that was asked for.
    expect(result.url).toBe("data:image/jpeg;base64,AAAA");
  });

  it("never sends a size or quality the model does not take", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ url: "https://cdn.example/n.png" }] }),
    });
    const result = await generateGatewayImage({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "nano-banana-2",
      prompt: "a lantern",
      aspectRatio: "landscape",
      imageChoice: { quality: "high", tier: "8k" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "nano-banana-2",
      prompt: "a lantern",
      aspect_ratio: "3:2",
      resolution: "4k",
    });
    expect(result.adjusted.map((item) => item.field).sort()).toEqual(["quality", "tier"]);
  });

  it("reads every picture a reply carries", () => {
    expect(parseGatewayImages({ data: [{ url: "https://a" }, { b64_json: "BB" }] }, "image/jpeg")).toEqual([
      "https://a",
      "data:image/jpeg;base64,BB",
    ]);
    expect(parseGatewayImages({})).toEqual([]);
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
    expect(result).toMatchObject({ url: "https://cdn.example/a.png", model: "gpt-image-2" });
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
    expect(result).toMatchObject({ url: "https://cdn.example/done.png", model: "gpt-image-2" });
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
      model: "unlisted-clip-1",
      prompt: "rain on a window",
      aspectRatio: "16:9",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/video/generations");
    // An id nobody knows gets the generic body: a prompt and a length. Never both `seconds` and `duration`.
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "unlisted-clip-1",
      prompt: "rain on a window",
      duration: 5,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/v1/video/generations/abcd");
    expect(result).toMatchObject({ url: "https://cdn.example/clip.mp4", model: "unlisted-clip-1", sent: { seconds: 5 } });
  });

  it("sends Seedance sound, ratio, length and resolution as asked, and reports them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ task_id: "t1", status: "queued" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "SUCCESS", result_url: "https://cdn.example/s.mp4" } }),
      });
    const result = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "seedance-2.0-fast",
      prompt: "ocean waves on a beach",
      aspectRatio: "3:4",
      seconds: 4,
      resolution: "1080p",
      audio: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    const sentBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sentBody).toMatchObject({
      seconds: "4",
      // 1080p is not a Seedance Fast resolution: it is moved to 720p, never sent.
      size: "720p",
      metadata: { ratio: "3:4", generate_audio: true },
    });
    expect(sentBody).not.toHaveProperty("duration");
    expect(result.sent).toEqual({ aspect: "3:4", seconds: 4, resolution: "720p", audio: true });
    expect(result.adjusted).toEqual([{ field: "resolution", asked: "1080p", used: "720p", reason: "not_offered" }]);
  });

  it("posts omni-fast to /v1/videos with seconds as a string, and polls there", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "video_1", status: "queued" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "completed", video_url: "https://cdn.example/o.mp4" }),
      });
    await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "omni-fast",
      prompt: "waves",
      seconds: 8,
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/v1/videos");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      model: "omni-fast",
      seconds: "8",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/v1/videos/video_1");
  });

  it("posts Kling to its own mount, beside /v1, and polls the same task path (not driven live)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { task_id: "k1", task_status: "submitted" } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.example/k.mp4" }] } },
        }),
      });
    const result = await generateGatewayVideo({
      baseUrl: "https://api.tokotokenai.com/v1",
      apiKey: "sk-test",
      model: "kling-v3",
      prompt: "a cat",
      imageUrl: "https://cdn.example/still.png",
      fetchImpl: fetchMock as unknown as typeof fetch,
      wait: async () => undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tokotokenai.com/kling/v1/videos/image2video");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      model_name: "kling-v3",
      image: "https://cdn.example/still.png",
      duration: "5",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.tokotokenai.com/kling/v1/videos/image2video/k1");
    expect(result.url).toBe("https://cdn.example/k.mp4");
  });

  it("refuses sound on a silent model before any call", async () => {
    const fetchMock = vi.fn();
    await expect(
      generateGatewayVideo({
        baseUrl: "https://api.tokotokenai.com/v1",
        apiKey: "sk-test",
        model: "grok-imagine-video",
        prompt: "x",
        audio: true,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "video_audio_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({ url: "https://cdn.example/grok.mp4", model: "grok-imagine-video" });
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
