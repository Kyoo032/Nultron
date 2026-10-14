import { z } from "zod";
import { resolvedGatewayBaseUrl } from "../../gateway";
import { DEFAULT_GATEWAY_IMAGE_MODEL } from "../../models/media-kind";
import { ApiError } from "../../errors";
import { defineTool } from "../define-tool";
import { imageInputSchema, resolveImageInput } from "../media-reference";
import { missingToolRouteMessage, resolveToolBackend } from "../credentials";
import { getSecret } from "../secret-scope";
import { falImageUrl, runFalQueue } from "./fal-queue";
import { generateGatewayImage } from "./gateway-media";

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

function usesGatewayImages(backend: string): boolean {
  return backend === "gateway" || backend === "openai";
}

export const imageGenerateTool = defineTool({
  key: "image_generate",
  name: "Create image",
  description:
    "Create an image from a text prompt. Pass style (photo, illustration, 3d, flat, sketch, watercolor) and size (square, portrait, landscape, wide) to shape it. To edit or fix an image, pass image_url as the earlier image's reference (an uploaded image or an image made in this chat: /api/v1/media/<id>/file or its id) and describe the change in the prompt; say what must stay the same. Uses the gateway by default (POST /v1/images/generations). Pass model to pick a catalog image id. If this tool errors after a long wait, do not call it again in the same turn — the image may already have been generated and billed on the gateway.",
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
  }),
  execute: async ({ prompt, aspect_ratio, size, style, image_url, model }, tenant) => {
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
    const fetchImpl = globalThis.fetch;
    try {
      const generated = usesGatewayImages(route.backend)
        ? await generateGatewayImage({
            prompt: finalPrompt,
            aspectRatio: aspect,
            imageUrl: resolved.url,
            apiKey,
            model: model || getSecret("IMAGE_GEN_MODEL") || DEFAULT_GATEWAY_IMAGE_MODEL,
            baseUrl: getSecret("OPENAI_BASE_URL") || resolvedGatewayBaseUrl(),
            fetchImpl,
          })
        : await generateWithFal(finalPrompt, aspect, resolved.url, apiKey, fetchImpl);
      return {
        success: true,
        backend: route.backend,
        image: generated.url,
        model: generated.model,
        prompt: finalPrompt,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Image generation failed" };
    }
  },
});
