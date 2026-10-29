/**
 * The paid media permission card, as data (SR-167). A model that starts a picture or a clip is answered with a
 * `permission` refusal instead (`@agentforge/core/media-permission`); the tool call keeps that refusal as its
 * output, so a reopened thread draws the same card. Pressing Run sends the request back in the next turn's
 * body, and the host lets one call with the same arguments through.
 */
import { formatUsd } from "@agentforge/core/gateway";
import {
  isMediaPermissionRefusal,
  isPaidMediaTool,
  mediaRequestKey,
  type MediaRequest,
} from "@agentforge/core/media-permission";
import { estimateImageCost, estimateVideoCost, findMediaListPrice } from "@agentforge/core/media-pricing";
import { t } from "./i18n";

type ToolLike = { readonly key: string; readonly status: string; readonly output?: unknown };

/** A request as the card shows it: what was asked, plus the model the tool falls back to when none is named. */
export type ShownMediaRequest = MediaRequest & { readonly defaultModel?: string };

const RESOLUTIONS = ["480p", "720p", "1080p"] as const;

/** The request a finished paid media call was refused on, or null for any other call. */
export function permissionRequestOf(tool: ToolLike): ShownMediaRequest | null {
  if (tool.status !== "completed" || !isPaidMediaTool(tool.key) || !isMediaPermissionRefusal(tool.output)) {
    return null;
  }
  const { request, defaultModel } = tool.output;
  return defaultModel ? { ...request, defaultModel } : request;
}

/** What a Run press sends back as a grant: the request alone, never the default the card priced it by. */
export function grantOf(request: ShownMediaRequest): MediaRequest {
  return { tool: request.tool, args: request.args };
}

/** Every request a turn is waiting on, in the order the model made them; the same request twice is one card. */
export function permissionRequestsOf(tools: readonly ToolLike[]): ShownMediaRequest[] {
  const seen = new Set<string>();
  const found: ShownMediaRequest[] = [];
  for (const tool of tools) {
    const request = permissionRequestOf(tool);
    if (!request) {
      continue;
    }
    const key = mediaRequestKey(request.tool, request.args);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(request);
    }
  }
  return found;
}

/** The prompt the model wrote, as the card quotes it. */
export function requestPrompt(request: MediaRequest): string {
  const prompt = request.args.prompt;
  return typeof prompt === "string" ? prompt : "";
}

/** What else the request fixes, one short phrase each: the model (or the default it falls back to), the shape, the length. */
export function requestDetails(request: ShownMediaRequest): string[] {
  const { args } = request;
  const details: string[] = [];
  if (typeof args.model === "string") {
    details.push(t("chat.media.model", { model: args.model }));
  } else if (request.defaultModel) {
    details.push(t("chat.media.defaultModel", { model: request.defaultModel }));
  }
  const shape = typeof args.size === "string" ? args.size : args.aspect_ratio;
  if (typeof shape === "string") {
    details.push(shape);
  }
  if (typeof args.seconds === "number") {
    details.push(`${args.seconds} s`);
  }
  if (typeof args.resolution === "string") {
    details.push(args.resolution);
  }
  return details;
}

/**
 * The list price of the request in one sentence, or the plain admission that none is known. A price needs a
 * model the table lists, the one named or else the one the tool falls back to: the table is curated and
 * nothing is guessed (`media-cost-estimate.md`).
 */
export function requestPriceLine(request: ShownMediaRequest): string {
  const model = typeof request.args.model === "string" ? request.args.model : (request.defaultModel ?? null);
  const price = model ? findMediaListPrice(model) : null;
  if (!price) {
    return t("chat.media.priceUnknown");
  }
  if (request.tool === "image_generate" && price.unit === "image") {
    return t("chat.media.priceImage", { usd: formatUsd(estimateImageCost(price).usd) });
  }
  const seconds = request.args.seconds;
  if (request.tool === "video_generate" && price.unit === "second" && typeof seconds === "number") {
    const resolution = RESOLUTIONS.find((item) => item === request.args.resolution);
    const estimate = estimateVideoCost(price, { seconds, ...(resolution ? { resolution } : {}) });
    return t("chat.media.priceClip", { usd: formatUsd(estimate.usd), seconds, resolution: estimate.tier });
  }
  return t("chat.media.priceUnknown");
}
