import {
  snapVideoLength,
  videoLengthOptions,
  videoSpecFor,
  type PublishedMediaParams,
  type VideoParamSpec,
} from "./media-params";

/**
 * What a video model has, as flags. The values behind each flag (which ratios, which lengths, which
 * resolutions) are the model's media parameter spec (`media-params.ts`); these flags are the short
 * answer for code that only needs to know whether a control exists.
 */
export type VideoCapabilities = {
  ratio: boolean;
  resolution: boolean;
  seconds: boolean;
  still: boolean;
  imageToVideo: boolean;
  /** The model has a switch for sound inside the clip. */
  audio: boolean;
};

export const GATEWAY_VIDEO_DURATION_SECONDS = 5;
export const GATEWAY_VIDEO_RESOLUTION = "720p";
/** The range the Ark-direct Seedance path (no gateway, no spec) clamps to. */
export const GATEWAY_VIDEO_SECONDS_MIN = 2;
export const GATEWAY_VIDEO_SECONDS_MAX = 12;

/** Seedance-class models bill by duration × resolution tier (`720p`), not OpenAI pixel `1280x720`. */
export function usesSeedanceVideoWire(model: string, published?: PublishedMediaParams): boolean {
  return videoSpecFor(model, published).bodyStyle === "seedance-content";
}

/**
 * Honest image-to-video gate (G-20). Unknown ids are false: a model whose spec does not say it takes a
 * still is refused one before any money is spent.
 */
export function imageToVideoForModel(model: string, published?: PublishedMediaParams): boolean {
  return videoSpecFor(model, published).imageInput.firstFrame;
}

export function videoCapabilitiesOf(spec: VideoParamSpec): VideoCapabilities {
  return {
    ratio: Boolean(spec.aspect),
    resolution: Boolean(spec.resolution),
    seconds: true,
    still: true,
    imageToVideo: spec.imageInput.firstFrame,
    audio: spec.audio.supported,
  };
}

export function videoCapabilities(model: string, published?: PublishedMediaParams): VideoCapabilities {
  return videoCapabilitiesOf(videoSpecFor(model, published));
}

/** Clip lengths a model offers in a picker. */
export function allowedVideoSeconds(model: string, published?: PublishedMediaParams): readonly number[] {
  return videoLengthOptions(videoSpecFor(model, published));
}

/** Nearest length the model accepts (ties go to the shorter clip). Undefined means the model's default. */
export function snapVideoSeconds(model: string, seconds?: number, published?: PublishedMediaParams): number {
  return snapVideoLength(videoSpecFor(model, published).length, seconds);
}

/** A model-less clamp for the direct-Ark path, which has no spec. The gateway path uses `snapVideoSeconds`. */
export function clampVideoSeconds(seconds?: number): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return GATEWAY_VIDEO_DURATION_SECONDS;
  }
  return Math.min(GATEWAY_VIDEO_SECONDS_MAX, Math.max(GATEWAY_VIDEO_SECONDS_MIN, Math.round(seconds)));
}
