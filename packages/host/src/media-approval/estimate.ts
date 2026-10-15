import { clampVideoSeconds, estimateImageCost, estimateVideoCost, findMediaListPrice } from "@agentforge/core";
import { MEDIA_CURRENCY, MICROS_PER_USD } from "./constants";
import type { StoredImageRequest, StoredMediaRequest, StoredVideoRequest } from "./request";

export type MediaEstimate = {
  readonly amountMicros: number | null;
  readonly currency: typeof MEDIA_CURRENCY;
};

const UNPRICED: MediaEstimate = Object.freeze({ amountMicros: null, currency: MEDIA_CURRENCY });

function micros(usd: number): MediaEstimate {
  return { amountMicros: Math.round(usd * MICROS_PER_USD), currency: MEDIA_CURRENCY };
}

function estimateImage(request: StoredImageRequest): MediaEstimate {
  const price = findMediaListPrice(request.model);
  if (!price) {
    return UNPRICED;
  }
  return micros(estimateImageCost(price, { count: 1, aspect: request.aspect }).usd);
}

function estimateVideo(request: StoredVideoRequest): MediaEstimate {
  const price = findMediaListPrice(request.model);
  if (!price) {
    return UNPRICED;
  }
  const seconds = clampVideoSeconds(request.seconds);
  return micros(
    estimateVideoCost(price, { seconds, ...(request.resolution ? { resolution: request.resolution } : {}) }).usd,
  );
}

export function estimateStoredMedia(request: StoredMediaRequest): MediaEstimate {
  return request.kind === "image" ? estimateImage(request) : estimateVideo(request);
}
