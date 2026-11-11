/**
 * One builder per body style: turn a person's choices and a model's spec into the exact request the
 * gateway documents for that model.
 *
 * Every builder settles the choices against the spec first (`settleVideo` / `settleImage`), so a value
 * the spec rejects is never sent, and it reports what it sent (`sent`) and what it moved
 * (`adjustments`). The field names come from the spec, so a spec laid over by what the gateway
 * published sends the fields that model reads.
 *
 * No Node imports.
 */

import { ApiError } from "../errors";
import { modeMessage } from "../mode-messages";
import type { AppLocale } from "../locale";
import {
  imageSpecFor,
  settleImage,
  settleVideo,
  videoSpecFor,
  type ImageChoice,
  type ImageSent,
  type ImageParamSpec,
  type MediaAdjustment,
  type VideoChoice,
  type VideoParamSpec,
  type VideoSent,
} from "./media-params";
import type { PublishedMediaParams } from "./media-params-published";
import type { VideoBodyStyle } from "./media-params-types";

type Body = Record<string, unknown>;

/** Set a field by name; a dotted name (`settings.duration`) is a nested key. */
function put(target: Body, field: string, value: unknown): void {
  const parts = field.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const held = cursor[part];
    const next: Body = typeof held === "object" && held !== null ? (held as Body) : {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------------------- video

export type VideoRequest = {
  style: VideoBodyStyle;
  /** The create route, from the gateway origin. */
  route: string;
  /** The status route, from the gateway origin. `{id}` stands for the task id. */
  pollRoute: string;
  body: Body;
  /** What the request carries. A field the model does not have is absent. */
  sent: VideoSent;
  /** What was asked for and moved or left out. */
  adjustments: MediaAdjustment[];
};

export type VideoRequestInput = {
  model: string;
  prompt: string;
  imageUrl?: string;
  choice: VideoChoice;
  /** Defaults to the spec for `model`. */
  spec?: VideoParamSpec;
  published?: PublishedMediaParams;
  locale?: AppLocale;
};

const GENERIC_POLL = "/v1/video/generations/{id}";
const VIDEOS_POLL = "/v1/videos/{id}";

type VideoBuilder = (input: {
  model: string;
  prompt: string;
  imageUrl?: string;
  spec: VideoParamSpec;
  sent: VideoSent;
}) => { route?: string; pollRoute: string; body: Body };

function lengthValue(spec: VideoParamSpec, seconds: number): number | string {
  return spec.length.wireType === "string" ? String(seconds) : seconds;
}

/** The fields every video body shares, by the names the spec reads. */
function putShared(body: Body, spec: VideoParamSpec, sent: VideoSent): void {
  put(body, spec.length.field, lengthValue(spec, sent.seconds));
  if (spec.resolution && sent.resolution) {
    put(body, spec.resolution.field, sent.resolution);
  }
  if (spec.aspect && sent.aspect) {
    put(body, spec.aspect.field, sent.aspect);
  }
}

export const VIDEO_BUILDERS: Readonly<Record<VideoBodyStyle, VideoBuilder>> = {
  /**
   * Seedance, on the generic route with the generic body (docs llms-full.txt:5985-5996 and the field mapping
   * at :5975-5984): `prompt`, `duration`, `size` (the resolution), and `ratio`, `generate_audio` and
   * `watermark` under `metadata`. The gateway converts it to the official `content[]` body. The official body's
   * top-level `ratio` and `duration` are NOT read on this route: a live call on 2026-11-11 sent ratio 3:4 and
   * duration 4 that way and the upstream task recorded 16:9 and 5.
   */
  "seedance-content": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model, prompt };
    putShared(body, spec, sent);
    // `duration` alone was ignored in two live calls (asked 4 s, got 5 s); the price list names this route's
    // length `seconds`. Both are sent. That `seconds` is read is not yet confirmed live.
    body.seconds = sent.seconds;
    if (spec.audio.supported && spec.audio.field && sent.audio !== undefined) {
      put(body, spec.audio.field, sent.audio);
    }
    put(body, "metadata.watermark", false);
    if (imageUrl) {
      put(body, spec.imageInput.field ?? "image", imageUrl);
    }
    return { pollRoute: GENERIC_POLL, body };
  },

  /** The generic `/v1/video/generations` body (p_video_create-video-generation): prompt, a length, an optional still. */
  "openai-video": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model, prompt };
    putShared(body, spec, sent);
    if (imageUrl) {
      body.image = imageUrl;
    }
    return { pollRoute: GENERIC_POLL, body };
  },

  /** Veo on the generic route: the documented example sends `duration` and `size: "16:9"`. */
  "veo-generic": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model, prompt };
    putShared(body, spec, sent);
    if (imageUrl) {
      body.image = imageUrl;
    }
    return { pollRoute: GENERIC_POLL, body };
  },

  /** Grok, `POST /v1/videos` (docs llms-full.txt:3668-3677). `seconds` is not sent: a number there is a 400. */
  "grok-videos": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model, prompt };
    putShared(body, spec, sent);
    body.preset = "normal";
    if (imageUrl) {
      body.image = imageUrl;
    }
    return { pollRoute: VIDEOS_POLL, body };
  },

  /** omni-fast, `POST /v1/videos` with `seconds` as a string (docs llms-full.txt:5707-5717, :5659). */
  "omni-fast": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model, prompt };
    putShared(body, spec, sent);
    if (imageUrl) {
      put(body, spec.imageInput.field ?? "first_image_url", imageUrl);
    }
    return { pollRoute: VIDEOS_POLL, body };
  },

  /** Kling text2video / image2video (docs llms-full.txt:4977-4987, :4677-4687). */
  "kling-native": ({ model, prompt, imageUrl, spec, sent }) => {
    const body: Body = { model_name: model };
    if (imageUrl) {
      body.image = imageUrl;
    }
    body.prompt = prompt;
    putShared(body, spec, sent);
    const route = imageUrl && spec.stillRoute ? spec.stillRoute : spec.route;
    return { route, pollRoute: `${route}/{id}`, body };
  },

  /** Kling omni, `contents[]` plus `settings` (docs llms-full.txt:4913-4923). */
  "kling-omni": ({ model, prompt, spec, sent }) => {
    const body: Body = { model_name: model, contents: [{ type: "prompt", text: prompt }] };
    putShared(body, spec, sent);
    return { pollRoute: `${spec.route}/{id}`, body };
  },

  /** Kling 3.0 Turbo, its own task API (docs llms-full.txt:5040-5055); queried at `GET /kling/tasks` (:5062). */
  "kling-turbo": ({ prompt, imageUrl, spec, sent }) => {
    const contents: Body[] = [{ type: "prompt", text: prompt }];
    if (imageUrl) {
      contents.push({ type: "first_frame", url: imageUrl });
    }
    const body: Body = { contents };
    putShared(body, spec, sent);
    body.options = { watermark_info: { enabled: false } };
    const route = imageUrl && spec.stillRoute ? spec.stillRoute : spec.route;
    return { route, pollRoute: "/kling/tasks?task_ids={id}", body };
  },
};

/**
 * The exact video request for one model: the route, the body and the status route, plus what was sent
 * and what had to be moved. Throws `video_audio_unsupported` when sound is asked of a silent model, and
 * `video_still_unsupported` when a still is sent to a model that takes none.
 */
export function buildVideoRequest(input: VideoRequestInput): VideoRequest {
  const spec = input.spec ?? videoSpecFor(input.model, input.published);
  if (input.imageUrl && !spec.imageInput.firstFrame) {
    throw new ApiError("video_still_unsupported", modeMessage("videoStillUnsupported", input.locale ?? "en"), 400);
  }
  const settled = settleVideo(spec, input.choice, { model: input.model, locale: input.locale });
  const { adjustments, ...sent } = settled;
  const built = VIDEO_BUILDERS[spec.bodyStyle]({
    model: input.model,
    prompt: input.prompt,
    imageUrl: input.imageUrl,
    spec,
    sent,
  });
  return {
    style: spec.bodyStyle,
    route: built.route ?? spec.route,
    pollRoute: built.pollRoute,
    body: built.body,
    sent,
    adjustments,
  };
}

// ---------------------------------------------------------------------------------------- image

export type ImageRequest = {
  style: ImageParamSpec["bodyStyle"];
  route: string;
  /** The JSON body, or the text fields of a multipart request when `file` is set. */
  body: Body;
  /** A local picture that goes as a multipart file (field `image`), because it is not a URL the gateway can fetch. */
  file?: { field: string; dataUrl: string };
  sent: ImageSent;
  adjustments: MediaAdjustment[];
};

export type ImageRequestInput = {
  model: string;
  prompt: string;
  imageUrl?: string;
  choice: ImageChoice;
  spec?: ImageParamSpec;
  published?: PublishedMediaParams;
  locale?: AppLocale;
};

const DATA_URL = /^data:/i;

function buildImageBody(input: { model: string; prompt: string; spec: ImageParamSpec; sent: ImageSent; explicit: ImageChoice }): Body {
  const { model, prompt, spec, sent, explicit } = input;
  const body: Body = { model, prompt };
  put(body, spec.shape.field, sent.shapeValue);
  if (spec.tier && sent.tier) {
    put(body, spec.tier.field, sent.tier);
  }
  if (spec.quality && sent.quality) {
    put(body, spec.quality.field, sent.quality);
  }
  if (spec.count && sent.count > 1) {
    put(body, spec.count.field, sent.count);
  }
  // A format is sent when it was chosen, or when it is not the model's own default.
  if (spec.outputFormat && sent.outputFormat && (explicit.outputFormat || sent.outputFormat !== spec.outputFormat.default)) {
    put(body, spec.outputFormat.field, sent.outputFormat);
  }
  if (spec.responseFormat) {
    body.response_format = spec.responseFormat;
  }
  return body;
}

/** Style by style, the body differs only in which spec fields exist, so the builders share one body. */
export const IMAGE_BUILDERS: Readonly<Record<ImageParamSpec["bodyStyle"], typeof buildImageBody>> = {
  /** gpt-image-2: `size` and `quality` (docs llms-full.txt:4321-4326). */
  "openai-image": buildImageBody,
  /** nano-banana: `aspect_ratio` and a resolution tier (docs llms-full.txt:3963-3975). */
  "nano-banana": buildImageBody,
  /** Gemini on the OpenAI-compatible route, with `response_format: "b64_json"` (docs llms-full.txt:4393-4399). */
  "gemini-image": buildImageBody,
  seedream: buildImageBody,
  "grok-image": buildImageBody,
  "generic-image": buildImageBody,
};

/**
 * The exact image request for one model. A reference picture goes to the model's edit route when it has
 * one (a URL as JSON, a local data URL as a multipart file), else into the generations body under the
 * field the spec names. Throws `image_input_unsupported` when a picture is sent to a model that takes none.
 */
export function buildImageRequest(input: ImageRequestInput): ImageRequest {
  const spec = input.spec ?? imageSpecFor(input.model, input.published);
  const settled = settleImage(spec, input.choice);
  const { adjustments, ...sent } = settled;
  const body = IMAGE_BUILDERS[spec.bodyStyle]({
    model: input.model,
    prompt: input.prompt,
    spec,
    sent,
    explicit: input.choice,
  });
  let route = spec.route;
  let file: ImageRequest["file"];
  if (input.imageUrl) {
    if (spec.referenceField === null) {
      throw new ApiError("image_input_unsupported", modeMessage("imageStillUnsupported", input.locale ?? "en"), 400);
    }
    const field = spec.referenceField;
    if (spec.editRoute) {
      route = spec.editRoute;
    }
    if (spec.editRoute && DATA_URL.test(input.imageUrl)) {
      file = { field: "image", dataUrl: input.imageUrl };
    } else {
      body[field] = field === "images" ? [input.imageUrl] : input.imageUrl;
    }
  }
  return { style: spec.bodyStyle, route, body, ...(file ? { file } : {}), sent, adjustments };
}
