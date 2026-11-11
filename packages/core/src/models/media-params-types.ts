/**
 * The shape of what one image or video model accepts: its media parameter spec.
 *
 * A spec answers four questions the code used to guess with regexes: which fields does this model
 * read, which values does each field take, what is the default, and how is the body shaped. It is
 * plain data (no functions, no regexes), so the host can send it to the page and the page shows only
 * the controls the model has, with only its values.
 *
 * A spec comes from, in order:
 *
 * 1. what the gateway publishes for the model (`config.parameters` of its price list entry),
 * 2. the built-in table (`media-params-table.ts`), which keeps the evidence for every entry,
 * 3. a conservative default for the model's family, marked unverified.
 *
 * No Node imports: the studios in the renderer read these types.
 */

/** Where a spec came from. `published` beats `built-in` beats `family-default`. */
export type ParamSource = "published" | "built-in" | "family-default";

/** A field with a fixed set of values and the value the gateway uses when the field is left out. */
export type ChoiceSpec = {
  /** The JSON key the model reads. A dotted path (`settings.duration`) is a nested key. */
  field: string;
  values: readonly string[];
  default: string;
};

/**
 * The ways this repo knows to shape a video request. One builder per style
 * (`media-request.ts`); two styles can share a route.
 */
export const VIDEO_BODY_STYLES = [
  "seedance-content",
  "openai-video",
  "veo-generic",
  "grok-videos",
  "omni-fast",
  "kling-native",
  "kling-omni",
  "kling-turbo",
] as const;
export type VideoBodyStyle = (typeof VIDEO_BODY_STYLES)[number];

export const IMAGE_BODY_STYLES = [
  "openai-image",
  "nano-banana",
  "gemini-image",
  "seedream",
  "grok-image",
  "generic-image",
] as const;
export type ImageBodyStyle = (typeof IMAGE_BODY_STYLES)[number];

/** A clip length: a fixed set, or a range. `wireType` says whether the gateway reads `5` or `"5"`. */
export type VideoLengthSpec = {
  field: string;
  /** A fixed set of seconds. Takes precedence over a range. */
  values?: readonly number[];
  min?: number;
  max?: number;
  step?: number;
  default: number;
  wireType: "int" | "string";
};

/** Sound inside the clip. `default` is what the gateway does when the field is left out. */
export type VideoAudioSpec = {
  supported: boolean;
  field?: string;
  default: boolean;
};

/** How a still goes into the request. `role` is the `content[]` role a Seedance image item carries. */
export type VideoImageInputSpec = {
  firstFrame: boolean;
  lastFrame: boolean;
  references: boolean;
  field?: string;
  role?: string;
};

export type VideoParamSpec = {
  kind: "video";
  family: string;
  bodyStyle: VideoBodyStyle;
  /** Create route, from the gateway origin (not from `/v1`). */
  route: string;
  /** Create route used when a still is sent, when it differs (Kling has one route per input). */
  stillRoute?: string;
  /** Absent when the model has no aspect control. */
  aspect?: ChoiceSpec;
  length: VideoLengthSpec;
  /** Absent when the model has no resolution control. */
  resolution?: ChoiceSpec;
  audio: VideoAudioSpec;
  imageInput: VideoImageInputSpec;
  source: ParamSource;
  /** Fields (`aspect`, `length`, `resolution`, `audio`, `route`) nobody published and a vendor API only suggests. */
  unverified: readonly string[];
  /** Per field: where the value came from (a doc line, a price list path). */
  evidence: Readonly<Record<string, string>>;
};

/** One size a model takes, with the aspect ratio it draws. `value` is exactly what is sent. */
export type ImageSizeOption = { value: string; aspect: string };

/** How an image model expresses its shape: an exact `size`, or an `aspect_ratio`. */
export type ImageShapeSpec =
  | { mode: "size"; field: string; options: readonly ImageSizeOption[]; default: string }
  | { mode: "aspect"; field: string; options: readonly string[]; default: string };

export type ImageParamSpec = {
  kind: "image";
  family: string;
  bodyStyle: ImageBodyStyle;
  route: string;
  /** Where a reference image goes when the model has an edit route. */
  editRoute?: string;
  shape: ImageShapeSpec;
  /** A resolution tier next to the aspect (nano-banana `1k`, `2k`). */
  tier?: ChoiceSpec;
  quality?: ChoiceSpec;
  /** Absent when only one image per call is verified. */
  count?: { field: string; max: number; default: number };
  outputFormat?: ChoiceSpec;
  /** A `response_format` the model needs on every request (Gemini: `b64_json`). */
  responseFormat?: string;
  /** The field a reference image goes in. `null` when the model takes none. */
  referenceField: string | null;
  source: ParamSource;
  unverified: readonly string[];
  evidence: Readonly<Record<string, string>>;
};

export type MediaParamSpec = VideoParamSpec | ImageParamSpec;

/** A spec as it sits in the built-in table: everything but where it was resolved from. */
export type VideoSpecBody = Omit<VideoParamSpec, "kind" | "source">;
export type ImageSpecBody = Omit<ImageParamSpec, "kind" | "source">;

/**
 * What the app picks when the person has not chosen. These are product choices, not facts about a
 * model; change them here and the studios, the chat tools and the docs follow.
 *
 * - Audio inside a video is off: it may cost more, and it is a toggle.
 * - Video resolution is 720p where the model offers it, else the model's own default.
 * - Image quality is `medium` where the model has a quality field (the gateway's own default for
 *   `gpt-image-2` is `low`).
 */
export const MEDIA_DEFAULTS = Object.freeze({
  videoAudio: false,
  videoResolution: "720p",
  imageQuality: "medium",
});

/** Something a request asked for that the spec changed or left out, so the caller can say what was sent. */
export type MediaAdjustment = {
  field: "aspect" | "seconds" | "resolution" | "audio" | "size" | "quality" | "tier" | "count" | "format";
  asked: string | number | boolean;
  /** `undefined` means the field was left out of the request. */
  used: string | number | boolean | undefined;
  reason: "not_offered" | "out_of_range" | "not_supported";
};
