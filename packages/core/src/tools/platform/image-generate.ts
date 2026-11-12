import { z } from "zod";
import { resolvedGatewayBaseUrl } from "../../gateway";
import { ApiError } from "../../errors";
import { currentOutboundGuard, mediaSendRefusal } from "../../security/outbound-guard";
import { defineTool } from "../define-tool";
import { gatewayGenerateModel } from "../media-model-choice";
import { imageInputSchema, mediaReferenceId, resolveImageInput } from "../media-reference";
import { reportModelOutcome } from "../../models/outcome-sink";
import { publishedMediaParamsFor } from "../../models/media-params-source";
import type { ImageChoice } from "../../models/media-params";
import { missingToolRouteMessage, resolveToolBackend } from "../credentials";
import { getSecret } from "../secret-scope";
import { falImageUrl, runFalQueue } from "./fal-queue";
import { generateGatewayImage, type GatewayImageResult } from "./gateway-media";

const FAL_IMAGE_MODEL = "fal-ai/flux-2/klein/9b";

const FAL_SIZES: Record<string, string> = {
  landscape: "landscape_16_9",
  square: "square_hd",
  portrait: "portrait_16_9",
};

const IMAGE_STYLES = ["photo", "illustration", "3d", "flat", "sketch", "watercolor", "none"] as const;
type ImageStyle = (typeof IMAGE_STYLES)[number];

const IMAGE_SIZES = ["square", "portrait", "landscape", "wide"] as const;
type ImageSize = (typeof IMAGE_SIZES)[number];

type ImageShape = "square" | "landscape" | "portrait";

/** Short phrases appended to the prompt. `none` and an absent style add nothing. */
const STYLE_PHRASES: Record<Exclude<ImageStyle, "none">, string> = {
  photo: "photorealistic photograph",
  illustration: "digital illustration",
  "3d": "3D render, soft lighting",
  flat: "flat vector graphic, clean shapes",
  sketch: "pencil sketch, hand-drawn lines",
  watercolor: "watercolor painting",
};

/** `wide` is the widest shape both backends already draw (landscape); no wider size is verified live. */
const SIZE_SHAPE: Record<ImageSize, ImageShape> = {
  square: "square",
  portrait: "portrait",
  landscape: "landscape",
  wide: "landscape",
};

export function imagePrompt(prompt: string, style?: ImageStyle): string {
  if (!style || style === "none") {
    return prompt;
  }
  return `${prompt}, ${STYLE_PHRASES[style]}`;
}

/** `size` wins over `aspect_ratio` when both are given; neither means square, as before. */
export function imageShape(size?: ImageSize, aspectRatio?: ImageShape): ImageShape {
  if (size) {
    return SIZE_SHAPE[size];
  }
  return aspectRatio ?? "square";
}

async function generateWithFal(
  prompt: string,
  aspectRatio: string,
  imageUrl: string | undefined,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ url: string; model: string }> {
  const payload: Record<string, unknown> = {
    prompt,
    image_size: FAL_SIZES[aspectRatio] ?? FAL_SIZES.square,
  };
  if (imageUrl) {
    payload.image_url = imageUrl;
  }
  const body = await runFalQueue({
    endpoint: FAL_IMAGE_MODEL,
    apiKey,
    payload,
    fetchImpl,
  });
  const url = falImageUrl(body);
  if (!url) {
    throw new ApiError("tool_failed", "FAL returned no image URL", 502);
  }
  return { url, model: FAL_IMAGE_MODEL };
}

/** The gateway's answer carries what was sent; a FAL answer does not. */
function isGatewayImage(result: { url: string; model: string }): result is GatewayImageResult {
  return "sent" in result;
}

function usesGatewayImages(backend: string): boolean {
  return backend === "gateway" || backend === "openai";
}

export const imageGenerateTool = defineTool({
  key: "image_generate",
  name: "Create image",
  description:
    "Create an image from a text prompt. Pass style (photo, illustration, 3d, flat, sketch, watercolor) and size (square, portrait, landscape, wide) to shape it. To edit or fix an image, pass image_url as the earlier image's reference (an uploaded image or an image made in this chat: /api/v1/media/<id>/file or its id) and describe the change in the prompt; say what must stay the same. Uses the gateway by default (POST /v1/images/generations, or /v1/images/edits when image_url is a picture to edit). Pass model to pick a catalog image id. Pass pixels, ratio, quality, resolution, count and output_format only when the person asked for them: each model accepts its own set (gpt-image-2 takes low, medium, high or auto quality and exact sizes such as 1536x1024), a value it does not take is moved to the nearest one it does, and the result says what was sent. If this tool errors after a long wait, do not call it again in the same turn — the image may already have been generated and billed on the gateway.",
  capability: "image_gen",
  schema: z.object({
    prompt: z.string().min(1).describe("Image prompt"),
    aspect_ratio: z.enum(["square", "landscape", "portrait"]).optional().describe("Output shape"),
    size: z.enum(IMAGE_SIZES).optional().describe("Output size; overrides aspect_ratio when both are given"),
    style: z.enum(IMAGE_STYLES).optional().describe("Visual style added to the prompt; none or omit for no style"),
    image_url: imageInputSchema
      .optional()
      .describe("Source image to edit: an https URL, or an image reference (/api/v1/media/<id>/file or the id)"),
    model: z.string().min(1).optional().describe("Optional catalog image model id"),
    pixels: z.string().optional().describe("Exact size such as 1536x1024, for a model that takes sizes"),
    ratio: z.string().optional().describe("Aspect ratio such as 3:2 or 16:9, for a model that takes ratios"),
    quality: z.string().optional().describe("Quality tier such as low, medium or high, for a model that has one"),
    resolution: z.string().optional().describe("Resolution tier such as 1k, 2k or 4k, for a model that has one"),
    count: z.number().int().min(1).max(4).optional().describe("How many images, for a model that makes more than one"),
    output_format: z.string().optional().describe("png or jpeg, for a model that takes a format"),
  }),
  execute: async (
    { prompt, aspect_ratio, size, style, image_url, model, pixels, ratio, quality, resolution, count, output_format },
    tenant,
  ) => {
    const route = resolveToolBackend("image_gen");
    if (!route.ready || !route.envVar) {
      return {
        success: false,
        error: missingToolRouteMessage(
          route,
          "Add a gateway key in Settings to generate images, or pick FAL / OpenAI Images.",
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
    const aspect = imageShape(size, aspect_ratio);
    const finalPrompt = imagePrompt(prompt, style);
    const held = mediaSendRefusal({
      imageUrl: image_url && !mediaReferenceId(image_url) ? image_url : undefined,
      prompt: finalPrompt,
      thirdParty: route.backend !== "gateway",
    });
    if (held) {
      return held;
    }
    const fetchImpl = globalThis.fetch;
    const gatewayModel = gatewayGenerateModel("image", model, { withReference: Boolean(resolved.url) });
    const imageChoice: ImageChoice = {
      ...(pixels ? { size: pixels } : {}),
      ...(ratio ? { aspectRatio: ratio } : {}),
      ...(quality ? { quality } : {}),
      ...(resolution ? { tier: resolution } : {}),
      ...(count ? { count } : {}),
      ...(output_format ? { outputFormat: output_format } : {}),
    };
    try {
      const generated = usesGatewayImages(route.backend)
        ? await generateGatewayImage({
            prompt: finalPrompt,
            aspectRatio: aspect,
            imageChoice,
            published: publishedMediaParamsFor(gatewayModel, tenant),
            imageUrl: resolved.url,
            apiKey,
            model: gatewayModel,
            baseUrl: getSecret("OPENAI_BASE_URL") || resolvedGatewayBaseUrl(),
            fetchImpl,
          })
        : await generateWithFal(finalPrompt, aspect, resolved.url, apiKey, fetchImpl);
      currentOutboundGuard()?.noteHostMedia([generated.url]);
      if (route.backend === "gateway") {
        reportModelOutcome({ tenant, model: gatewayModel, kind: "image", ok: true });
      }
      return {
        success: true,
        backend: route.backend,
        image: generated.url,
        model: generated.model,
        prompt: finalPrompt,
        // What the request actually carried, and what had to be moved to get there (gateway only).
        ...(isGatewayImage(generated)
          ? {
              sent: generated.sent,
              adjusted: generated.adjusted,
              ...(generated.urls.length > 1 ? { images: generated.urls } : {}),
            }
          : {}),
      };
    } catch (error) {
      if (route.backend === "gateway") {
        reportModelOutcome({ tenant, model: gatewayModel, kind: "image", ok: false, error });
      }
      return { success: false, error: error instanceof Error ? error.message : "Image generation failed" };
    }
  },
});
