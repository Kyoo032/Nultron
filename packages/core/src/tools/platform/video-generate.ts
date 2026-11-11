import { z } from "zod";
import { resolvedGatewayBaseUrl } from "../../gateway";
import { clampVideoSeconds } from "../../models/video-capabilities";
import { publishedMediaParamsFor } from "../../models/media-params-source";
import { ApiError } from "../../errors";
import { currentOutboundGuard, mediaSendRefusal } from "../../security/outbound-guard";
import { defineTool } from "../define-tool";
import { gatewayGenerateModel } from "../media-model-choice";
import { imageInputSchema, mediaReferenceId, resolveImageInput } from "../media-reference";
import { reportModelOutcome } from "../../models/outcome-sink";
import { missingToolRouteMessage, resolveToolBackend } from "../credentials";
import { getSecret } from "../secret-scope";
import { falVideoUrl, runFalQueue } from "./fal-queue";
import { generateGatewayVideo } from "./gateway-media";

const FAL_VIDEO_TEXT = "fal-ai/pixverse/v6/text-to-video";
const FAL_VIDEO_IMAGE = "fal-ai/pixverse/v6/image-to-video";
const SEEDANCE_MODEL = "doubao-seedance-2-0-fast-260128";

async function generateWithFal(
  prompt: string,
  imageUrl: string | undefined,
  aspectRatio: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ url: string; model: string; modality: "text" | "image" }> {
  const modality = imageUrl ? "image" : "text";
  const endpoint = imageUrl ? FAL_VIDEO_IMAGE : FAL_VIDEO_TEXT;
  const payload: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
  if (imageUrl) {
    payload.image_url = imageUrl;
  }
  const body = await runFalQueue({
    endpoint,
    apiKey,
    payload,
    fetchImpl,
  });
  const url = falVideoUrl(body);
  if (!url) {
    throw new ApiError("tool_failed", "FAL returned no video URL", 502);
  }
  return { url, model: endpoint, modality };
}

async function generateWithSeedance(
  prompt: string,
  imageUrl: string | undefined,
  aspectRatio: string,
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  seconds?: number,
): Promise<{ url: string; model: string; modality: "text" | "image" }> {
  const origin = baseUrl.replace(/\/+$/, "");
  const duration = clampVideoSeconds(seconds);
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `${prompt} --rt ${aspectRatio} --dur ${duration}` },
  ];
  if (imageUrl) {
    content.push({ type: "image_url", image_url: { url: imageUrl } });
  }
  const created = await fetchImpl(`${origin}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: SEEDANCE_MODEL, content }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string } | string;
  };
  if (!created.ok || !createdBody.id) {
    const message =
      typeof createdBody.error === "string"
        ? createdBody.error
        : createdBody.error?.message || `Seedance returned HTTP ${created.status}`;
    throw new ApiError("tool_failed", message, 502);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const statusRes = await fetchImpl(`${origin}/contents/generations/tasks/${createdBody.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const statusBody = (await statusRes.json().catch(() => ({}))) as {
      status?: string;
      content?: { video_url?: string };
      error?: { message?: string } | string;
    };
    if (statusBody.status === "succeeded" && statusBody.content?.video_url) {
      return {
        url: statusBody.content.video_url,
        model: SEEDANCE_MODEL,
        modality: imageUrl ? "image" : "text",
      };
    }
    if (statusBody.status === "failed") {
      const message =
        typeof statusBody.error === "string" ? statusBody.error : statusBody.error?.message || "Seedance job failed";
      throw new ApiError("tool_failed", message, 502);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new ApiError("tool_failed", "Seedance job timed out", 504);
}

export const videoGenerateTool = defineTool({
  key: "video_generate",
  name: "Create video",
  description:
    "Create a video from a text prompt, or animate a still by passing image_url: an https URL, or an image reference (/api/v1/media/<id>/file or the id) for an image in this chat. Uses the gateway by default (the route the model documents, then poll). Pass model to pick a catalog video id. Pass aspect_ratio, seconds, resolution and audio only when the person asked for them: each model accepts its own set (for example seedance-2.0-fast takes 480p or 720p and 4 to 15 s), a value it does not take is moved to the nearest one it does, and the result says what was sent. audio asks for sound inside the clip; it is off by default and a model with no sound switch refuses it.",
  capability: "video_gen",
  schema: z.object({
    prompt: z.string().min(1).describe("Video prompt"),
    aspect_ratio: z
      .string()
      .optional()
      .describe("Output aspect ratio such as 16:9, 9:16, 1:1, 3:4 or 4:3 (the model takes its own set)"),
    image_url: imageInputSchema
      .optional()
      .describe("Optional still image to animate: an https URL or an image reference"),
    model: z.string().min(1).optional().describe("Optional catalog video model id"),
    seconds: z.number().int().min(1).max(60).optional().describe("Clip length in seconds (the model takes its own range)"),
    resolution: z
      .string()
      .optional()
      .describe("Output resolution such as 480p, 720p, 1080p or 4k (the model takes its own set)"),
    audio: z.boolean().optional().describe("Sound inside the clip. Off unless asked; some models cannot make sound"),
  }),
  execute: async ({ prompt, aspect_ratio, image_url, model, seconds, resolution, audio }, tenant) => {
    const route = resolveToolBackend("video_gen");
    if (!route.ready || !route.envVar) {
      return {
        success: false,
        error: missingToolRouteMessage(
          route,
          "Add a gateway key in Settings to generate video, or pick FAL / Volcengine Seedance.",
        ),
      };
    }
    const apiKey = getSecret(route.envVar);
    if (!apiKey) {
      return { success: false, error: `${route.envVar} is not set.` };
    }
    const resolved = await resolveImageInput(image_url, tenant);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }
    const sourceImage = resolved.url;
    const held = mediaSendRefusal({
      imageUrl: image_url && !mediaReferenceId(image_url) ? image_url : undefined,
      prompt,
      thirdParty: route.backend !== "gateway",
    });
    if (held) {
      return held;
    }
    const aspect = aspect_ratio ?? "16:9";
    const fetchImpl = globalThis.fetch;
    const gatewayModel = gatewayGenerateModel("video", model);
    try {
      const generated =
        route.backend === "gateway"
          ? await generateGatewayVideo({
              prompt,
              aspectRatio: aspect_ratio,
              imageUrl: sourceImage,
              seconds,
              resolution,
              audio,
              published: publishedMediaParamsFor(gatewayModel, tenant),
              apiKey,
              model: gatewayModel,
              baseUrl: getSecret("OPENAI_BASE_URL") || resolvedGatewayBaseUrl(),
              fetchImpl,
            })
          : route.backend === "volcengine"
            ? await generateWithSeedance(
                prompt,
                sourceImage,
                aspect,
                apiKey,
                getSecret("ARK_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3",
                fetchImpl,
                seconds,
              )
            : await generateWithFal(prompt, sourceImage, aspect, apiKey, fetchImpl);
      currentOutboundGuard()?.noteHostMedia([generated.url]);
      if (route.backend === "gateway") {
        reportModelOutcome({ tenant, model: gatewayModel, kind: "video", ok: true });
      }
      return {
        success: true,
        backend: route.backend,
        video: generated.url,
        model: generated.model,
        modality: sourceImage ? "image" : "text",
        prompt,
        // What the request actually carried, and what had to be moved to get there (gateway only).
        ...("sent" in generated ? { sent: generated.sent, adjusted: generated.adjusted } : {}),
      };
    } catch (error) {
      if (route.backend === "gateway") {
        reportModelOutcome({ tenant, model: gatewayModel, kind: "video", ok: false, error });
      }
      return { success: false, error: error instanceof Error ? error.message : "Video generation failed" };
    }
  },
});
