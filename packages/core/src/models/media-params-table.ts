/**
 * The built-in media parameter table: what each image and video model accepts, as data.
 *
 * Built from the 2026-11-11 research table (61 gateway ids in 26 schema families) and kept as data so
 * a mismatch is a one-line edit here, not a conditional somewhere else. Every entry keeps its evidence
 * string: a gateway docs line (`docs llms-full.txt:<line>`, the English section of the gateway's
 * `llms-full.txt`), a price list path (`pricing.json …`), or `assumed` where a vendor API is known but
 * the gateway publishes nothing. An `assumed` field is also named in `unverified`, so the UI and the
 * docs can say so.
 *
 * Where the gateway publishes `config.parameters` for a model, that wins over this table
 * (`media-params.ts`, `applyPublished`). A model that is in neither falls to its family default at the
 * bottom, which offers as little as is safe.
 *
 * No Node imports: the studios in the renderer read the specs built from this table.
 */

import type { ImageSpecBody, VideoLengthSpec, VideoSpecBody } from "./media-params-types";

type BuiltinVideo = { ids: readonly string[]; spec: VideoSpecBody };
type BuiltinImage = { ids: readonly string[]; spec: ImageSpecBody };

// ---------------------------------------------------------------------------------------- video

const GENERIC_VIDEO_ROUTE = "/v1/video/generations";
const SEEDANCE_RATIOS = ["16:9", "9:16", "3:4", "1:1", "4:3"] as const;
const SEEDANCE_RATIO_EVIDENCE =
  "docs llms-full.txt:6459 (parameter cheat sheet); the price list types ratio as a string with no enum";
const SEEDANCE_ROUTE_EVIDENCE =
  "docs llms-full.txt:6411 (generic video route) and :5966; body fields per the generic field mapping, docs llms-full.txt:5975-5984. " +
  "Live 2026-11-11: the official body's top-level ratio and duration were dropped on this route (upstream task recorded ratio 16:9, " +
  "duration 5 for a 3:4, 4 s request), so ratio, sound and watermark go under metadata and the resolution as size";

/**
 * What the two live calls of 2026-11-11 showed about the length on the generic route: `duration` was sent
 * and ignored both times (asked 4 s, the upstream task recorded 5 and the clips run 5.09 s), while the
 * ratio, the resolution (as `size`) and sound (under `metadata`) were read. The price list names the
 * route's length `seconds` (data[seedance-2.0-fast] …openai-video.config.parameters.seconds), so both
 * names are sent; that `seconds` is read is not yet confirmed live.
 */
const SEEDANCE_LENGTH_LIVE_NOTE =
  " Live 2026-11-11, two calls: a 4 s request sent as `duration` came back as 5 s (task data.duration 5, clip 5.09 s). " +
  "`seconds` (the price list's name on this route) is sent too and not yet confirmed live.";

function seedance(input: {
  family: string;
  length: VideoLengthSpec;
  lengthEvidence: string;
  resolutions: readonly string[];
  resolutionEvidence: string;
  audio: boolean;
  audioEvidence: string;
  role: string;
  unverified?: readonly string[];
}): VideoSpecBody {
  return {
    family: input.family,
    bodyStyle: "seedance-content",
    route: GENERIC_VIDEO_ROUTE,
    aspect: { field: "metadata.ratio", values: SEEDANCE_RATIOS, default: "16:9" },
    length: input.length,
    resolution: { field: "size", values: input.resolutions, default: "720p" },
    audio: input.audio
      ? { supported: true, field: "metadata.generate_audio", default: true }
      : { supported: false, default: false },
    imageInput: { firstFrame: true, lastFrame: false, references: true, field: "image", role: input.role },
    // The length is always unverified on this route: see SEEDANCE_LENGTH_LIVE_NOTE.
    unverified: [...new Set(["length", ...(input.unverified ?? [])])],
    evidence: {
      route: SEEDANCE_ROUTE_EVIDENCE,
      aspect: SEEDANCE_RATIO_EVIDENCE,
      length: input.lengthEvidence + SEEDANCE_LENGTH_LIVE_NOTE,
      resolution: input.resolutionEvidence,
      audio: input.audioEvidence,
      image:
        "docs llms-full.txt:5975-5984 (generic `image` becomes a content item with role reference_image on Seedance 2); " +
        "docs llms-full.txt:6183 (Seedance 2 image items carry role reference_image)",
    },
  };
}

const SEEDANCE_2_LENGTH: VideoLengthSpec = { field: "duration", min: 4, max: 15, step: 1, default: 5, wireType: "int" };
const SEEDANCE_2_LENGTH_EVIDENCE =
  "docs llms-full.txt:6460 (4 to 15 seconds, default 5); default also pricing.json data[seedance-2.0-fast] …seedance2-native-video.config.parameters.duration.default";
const SEEDANCE_AUDIO_EVIDENCE =
  "docs llms-full.txt:6461 (generate_audio default true); pricing.json data[seedance-2.0-fast] …config.parameters.generate_audio.default";

export const BUILTIN_VIDEO: readonly BuiltinVideo[] = [
  {
    ids: ["seedance-1.0-pro", "seedance-1.0-pro-fast"],
    spec: seedance({
      family: "seedance-1.0",
      length: { field: "duration", values: [5, 10], default: 5, wireType: "int" },
      lengthEvidence:
        "assumed (Seedance 1.x renders 5 s or 10 s clips); the price list publishes only the default 5, no min or max",
      resolutions: ["480p", "720p", "1080p"],
      resolutionEvidence: "pricing.json data[seedance-1.0-pro] …seedance2-native-video.config.parameters.resolution.enum",
      audio: false,
      audioEvidence:
        "no generate_audio key in the published schema (pricing.json data[seedance-1.0-pro]); docs llms-full.txt:6393-6401 place audio on 2.0 and 2.5",
      role: "first_frame",
      unverified: ["length", "image"],
    }),
  },
  {
    ids: ["seedance-1.5-pro"],
    spec: seedance({
      family: "seedance-1.5-pro",
      length: { field: "duration", values: [5, 10], default: 5, wireType: "int" },
      lengthEvidence: "assumed (Seedance 1.5 promises 5 s and 10 s); the price list publishes only the default 5",
      resolutions: ["480p", "720p", "1080p"],
      resolutionEvidence: "pricing.json data[seedance-1.5-pro] …config.parameters.resolution.enum",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "first_frame",
      unverified: ["length", "image"],
    }),
  },
  {
    ids: [
      "seedance-2.0",
      "doubao-seedance-2-0-260128",
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-ep",
    ],
    spec: seedance({
      family: "seedance-2.0",
      length: SEEDANCE_2_LENGTH,
      lengthEvidence: SEEDANCE_2_LENGTH_EVIDENCE,
      resolutions: ["480p", "720p", "1080p", "4k"],
      resolutionEvidence:
        "pricing.json data[seedance-2.0] …config.parameters.resolution.enum; docs llms-full.txt:6458 (full versions also support 4k)",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "reference_image",
    }),
  },
  {
    ids: [
      "seedance-2.0-fast",
      "doubao-seedance-2-0-fast-260128",
      "dreamina-seedance-2-0-fast-260128",
      "dreamina-seedance-2-0-fast-ep",
    ],
    spec: seedance({
      family: "seedance-2.0-fast",
      length: SEEDANCE_2_LENGTH,
      lengthEvidence: SEEDANCE_2_LENGTH_EVIDENCE,
      resolutions: ["480p", "720p"],
      resolutionEvidence: "pricing.json data[seedance-2.0-fast] …config.parameters.resolution.enum (480p, 720p only)",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "reference_image",
    }),
  },
  {
    ids: ["seedance-2.0-mini", "doubao-seedance-2-0-mini-260615", "dreamina-seedance-2-0-mini-260615"],
    spec: seedance({
      family: "seedance-2.0-mini",
      length: SEEDANCE_2_LENGTH,
      lengthEvidence: SEEDANCE_2_LENGTH_EVIDENCE,
      resolutions: ["480p", "720p"],
      resolutionEvidence: "pricing.json data[seedance-2.0-mini] …config.parameters.resolution.enum (480p, 720p only)",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "reference_image",
    }),
  },
  {
    ids: ["seedance-2.5", "doubao-seedance-2-5-260628", "dreamina-seedance-2-5-260628"],
    spec: seedance({
      family: "seedance-2.5",
      length: { field: "duration", min: 4, max: 30, step: 1, default: 5, wireType: "int" },
      lengthEvidence: "docs llms-full.txt:6399 and :6460 (up to 30 seconds, default 5)",
      resolutions: ["480p", "720p"],
      resolutionEvidence:
        "pricing.json data[seedance-2.5] …config.parameters.resolution.enum; docs llms-full.txt:6400 (480p / 720p)",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "reference_image",
    }),
  },
  {
    ids: ["grok-imagine-video", "grok-imagine-video-1.5-preview"],
    spec: {
      family: "grok-imagine-video",
      bodyStyle: "grok-videos",
      route: "/v1/videos",
      aspect: { field: "aspect_ratio", values: ["16:9", "9:16"], default: "16:9" },
      length: { field: "video_length", values: [6, 10], default: 6, wireType: "int" },
      resolution: { field: "resolution_name", values: ["480p", "720p"], default: "720p" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: false, references: false, field: "image" },
      unverified: ["aspect", "length", "resolution"],
      evidence: {
        route: "docs llms-full.txt:3658 (Grok video generation uses /v1/videos)",
        aspect: "docs llms-full.txt:3673 (16:9) and :3703 (9:16); no enum published",
        length: "docs llms-full.txt:3674 (video_length=6) and :3704 (video_length=10); no enum published",
        resolution: "docs llms-full.txt:3675 (480p) and :3705 (720p); no 1080p example, no enum published",
        audio: "no audio field in the Grok video section, docs llms-full.txt:3652",
        image: "docs llms-full.txt:3710 (image, one Base64 or URL image)",
      },
    },
  },
  {
    ids: ["kling-v3"],
    spec: {
      family: "kling-v3",
      bodyStyle: "kling-native",
      route: "/kling/v1/videos/text2video",
      stillRoute: "/kling/v1/videos/image2video",
      aspect: { field: "aspect_ratio", values: ["16:9", "9:16", "1:1"], default: "16:9" },
      length: { field: "duration", values: [5, 10], default: 5, wireType: "string" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: true, references: false, field: "image" },
      unverified: ["aspect", "length"],
      evidence: {
        route: "docs llms-full.txt:4953 (text2video) and :4653 (image2video)",
        aspect: "assumed (Kling official: 16:9, 9:16, 1:1); the gateway docs name the field only, docs llms-full.txt:4972",
        length: "assumed (Kling official: duration is the string '5' or '10'); docs example '5' at docs llms-full.txt:4985",
        resolution: "no resolution field in the /kling/v1/videos/* body, docs llms-full.txt:4964-4973",
        audio: "no audio field; Kling has a separate /kling/v1/audio/* service, docs llms-full.txt:4439",
        image: "docs llms-full.txt:4667-4668 (image first frame, image_tail tail frame)",
      },
    },
  },
  {
    ids: ["kling-v3-omni"],
    spec: {
      family: "kling-v3-omni",
      bodyStyle: "kling-omni",
      route: "/kling/v1/videos/omni-video",
      aspect: { field: "settings.aspect_ratio", values: ["16:9", "9:16"], default: "16:9" },
      length: { field: "settings.duration", values: [5, 10], default: 5, wireType: "int" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: false, lastFrame: false, references: false },
      unverified: ["aspect", "length"],
      evidence: {
        route: "docs llms-full.txt:4911",
        aspect: "docs llms-full.txt:4922 (16:9); no enum published",
        length: "docs llms-full.txt:4922 (duration 5); enum not published",
        resolution: "no resolution field in the omni-video body, docs llms-full.txt:4905",
        audio: "voices are an input in contents, not generated audio, docs llms-full.txt:4905",
        image: "the shape of an image item in contents[] is not documented; stills are refused",
      },
    },
  },
  {
    ids: ["kling-3.0-turbo"],
    spec: {
      family: "kling-3.0-turbo",
      bodyStyle: "kling-turbo",
      route: "/kling/text-to-video/kling-3.0-turbo",
      stillRoute: "/kling/image-to-video/kling-3.0-turbo",
      length: { field: "settings.duration", min: 3, max: 15, step: 1, default: 5, wireType: "int" },
      resolution: { field: "settings.resolution", values: ["720p", "1080p"], default: "720p" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: false, references: false, field: "contents" },
      unverified: [],
      evidence: {
        route: "docs llms-full.txt:5015-5018",
        aspect: "the turbo body has no aspect_ratio field, docs llms-full.txt:5029-5036",
        length: "docs llms-full.txt:5033 (3 to 15 seconds)",
        resolution: "docs llms-full.txt:5032 (720p or 1080p, default 720p)",
        audio: "no audio field in the turbo body, docs llms-full.txt:5027",
        image: "docs llms-full.txt:5047 (contents item type first_frame)",
      },
    },
  },
  {
    ids: ["omni-fast"],
    spec: {
      family: "omni-fast",
      bodyStyle: "omni-fast",
      route: "/v1/videos",
      aspect: { field: "aspect_ratio", values: ["16:9", "9:16"], default: "16:9" },
      length: { field: "seconds", min: 4, max: 30, step: 1, default: 5, wireType: "string" },
      resolution: { field: "resolution", values: ["720p", "1080p", "2k", "4k"], default: "720p" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: true, references: true, field: "first_image_url" },
      unverified: [],
      evidence: {
        route: "docs llms-full.txt:5684 (POST /v1/videos, JSON, no multipart: :5669)",
        aspect: "docs llms-full.txt:5660 (e.g. 16:9, 9:16); no enum published",
        length: "docs llms-full.txt:5659 (seconds as a string, 4 to 30 recommended)",
        resolution: "docs llms-full.txt:5661 (720p, 1080p, 2k, 4k)",
        audio: "no audio field in the omni-fast field reference, docs llms-full.txt:5655",
        image: "docs llms-full.txt:5662-5664 (first_image_url, last_image_url, images up to 5)",
      },
    },
  },
  {
    ids: ["omni-fast-v2v"],
    spec: {
      family: "omni-fast-v2v",
      bodyStyle: "omni-fast",
      route: "/v1/videos",
      aspect: { field: "aspect_ratio", values: ["16:9", "9:16"], default: "16:9" },
      length: { field: "seconds", min: 4, max: 30, step: 1, default: 5, wireType: "string" },
      resolution: { field: "resolution", values: ["720p", "1080p", "2k", "4k"], default: "720p" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: false, lastFrame: false, references: false },
      unverified: ["aspect", "length", "resolution"],
      evidence: {
        route: "docs llms-full.txt:5693 (omni-fast-v2v edits a reference video; same /v1/videos route)",
        aspect: "docs llms-full.txt:5704 (common request fields); the v2v id is not documented separately",
        length: "docs llms-full.txt:5703 (seconds as a string)",
        resolution: "docs llms-full.txt:5705",
        audio: "no audio field",
        image: "docs llms-full.txt:5692-5693 (v2v takes a reference video, not a still)",
      },
    },
  },
  {
    ids: ["veo_3_1", "veo_3_1-fast"],
    spec: {
      family: "veo-3.1",
      bodyStyle: "veo-generic",
      route: GENERIC_VIDEO_ROUTE,
      aspect: { field: "size", values: ["16:9", "9:16"], default: "16:9" },
      length: { field: "duration", values: [4, 6, 8], default: 4, wireType: "int" },
      resolution: { field: "resolution", values: ["720p", "1080p"], default: "720p" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: false, references: false, field: "image" },
      unverified: ["aspect", "length", "resolution", "audio"],
      evidence: {
        route: "docs name Veo as a provider of /v1/video/generations, docs llms-full.txt:6968; no Veo page, no price list row",
        aspect:
          "the generic video reference example sends size: '16:9' for veo-3.1-generate-preview (p_video_create-video-generation); values assumed (Veo 3.1: 16:9, 9:16)",
        length: "assumed (Google Veo 3.1 accepts 4, 6 or 8 s); the same example sends duration 8",
        resolution: "assumed (Google Veo 3.1: 720p, 1080p); `resolution` is a field of the generic body",
        audio: "assumed (Veo 3.x makes audio natively); the gateway publishes no field to switch it, so no control is offered",
        image: "the generic body's `image` field (p_video_create-video-generation); unverified for Veo",
      },
    },
  },
  {
    ids: ["happyhorse-1.1-i2v"],
    spec: {
      family: "happyhorse",
      bodyStyle: "openai-video",
      route: GENERIC_VIDEO_ROUTE,
      length: { field: "duration", values: [5], default: 5, wireType: "int" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: true, lastFrame: false, references: false, field: "image" },
      unverified: ["aspect", "length", "resolution", "audio"],
      evidence: {
        route: "named as a /v1/video/generations provider, docs llms-full.txt:6968",
        length: "unknown: nothing published; 5 s is the app's long-standing default",
        image: "the -i2v suffix implies a still; the generic body's `image` field",
      },
    },
  },
  {
    ids: ["happyhorse-1.0-video-edit"],
    spec: {
      family: "happyhorse",
      bodyStyle: "openai-video",
      route: GENERIC_VIDEO_ROUTE,
      length: { field: "duration", values: [5], default: 5, wireType: "int" },
      audio: { supported: false, default: false },
      imageInput: { firstFrame: false, lastFrame: false, references: false },
      unverified: ["aspect", "length", "resolution", "audio"],
      evidence: {
        route: "named as a /v1/video/generations provider, docs llms-full.txt:6968",
        length: "unknown: nothing published; 5 s is the app's long-standing default",
        image: "a video-edit id implies a reference video, not a still",
      },
    },
  },
];

/** A family default for an id the table has never heard of: offers as little as is safe, and says so. */
type FamilyVideo = { family: string; match: RegExp; spec: VideoSpecBody };

export const VIDEO_FAMILY_DEFAULTS: readonly FamilyVideo[] = [
  {
    family: "seedance",
    match: /seedance/i,
    spec: seedance({
      family: "seedance",
      length: { field: "duration", values: [5], default: 5, wireType: "int" },
      lengthEvidence: "family default: only the published default (5 s) is offered for an unlisted Seedance id",
      resolutions: ["480p", "720p"],
      resolutionEvidence: "family default: 480p and 720p are accepted by every Seedance id in the price list",
      audio: true,
      audioEvidence: SEEDANCE_AUDIO_EVIDENCE,
      role: "reference_image",
      unverified: ["length", "resolution"],
    }),
  },
  {
    family: "kling-turbo",
    match: /kling.*turbo/i,
    spec: structuredCloneSpec("kling-3.0-turbo", "kling-turbo-family"),
  },
  {
    family: "kling-omni",
    match: /kling.*omni/i,
    spec: structuredCloneSpec("kling-v3-omni", "kling-omni-family"),
  },
  {
    family: "kling",
    match: /kling/i,
    spec: structuredCloneSpec("kling-v3", "kling-family"),
  },
  {
    family: "veo",
    match: /veo[_-]/i,
    spec: structuredCloneSpec("veo_3_1", "veo-family"),
  },
  {
    family: "grok-imagine-video",
    match: /grok-imagine-video/i,
    spec: structuredCloneSpec("grok-imagine-video", "grok-imagine-video-family"),
  },
  {
    family: "omni-fast",
    match: /^omni-/i,
    spec: structuredCloneSpec("omni-fast-v2v", "omni-family"),
  },
];

/** The last resort for a video id nothing knows: the generic route, a prompt and a length. */
export const GENERIC_VIDEO: VideoSpecBody = {
  family: "generic-video",
  bodyStyle: "openai-video",
  route: GENERIC_VIDEO_ROUTE,
  length: { field: "duration", values: [5], default: 5, wireType: "int" },
  audio: { supported: false, default: false },
  imageInput: { firstFrame: false, lastFrame: false, references: false },
  unverified: ["aspect", "length", "resolution", "audio", "image"],
  evidence: {
    route: "docs llms-full.txt:6411 and p_video_create-video-generation (the generic video route)",
    length: "family default: the body is {model, prompt, duration}; nothing else is known to be accepted",
  },
};

/** Copy one built-in video entry as a family default, so the family and its first member never drift. */
function structuredCloneSpec(id: string, family: string): VideoSpecBody {
  const entry = BUILTIN_VIDEO.find((item) => item.ids.includes(id));
  if (!entry) {
    throw new Error(`media-params-table: no built-in video entry for ${id}`);
  }
  const { unverified, evidence, ...rest } = entry.spec;
  return {
    ...rest,
    family,
    unverified: [...new Set([...unverified, "aspect", "length", "resolution", "audio"])],
    evidence: { ...evidence, family: `family default copied from ${id}; an unlisted id may differ` },
  };
}

// ---------------------------------------------------------------------------------------- image

const GPT_IMAGE_2_SIZES = [
  { value: "1024x1024", aspect: "1:1" },
  { value: "2048x2048", aspect: "1:1" },
  { value: "1536x1024", aspect: "3:2" },
  { value: "1024x1536", aspect: "2:3" },
  { value: "1024x768", aspect: "4:3" },
  { value: "2048x1536", aspect: "4:3" },
  { value: "768x1024", aspect: "3:4" },
  { value: "1536x2048", aspect: "3:4" },
  { value: "1280x1024", aspect: "5:4" },
  { value: "1024x1280", aspect: "4:5" },
  { value: "2048x1152", aspect: "16:9" },
  { value: "3840x2160", aspect: "16:9" },
  { value: "1152x2048", aspect: "9:16" },
  { value: "2160x3840", aspect: "9:16" },
  { value: "2688x1152", aspect: "21:9" },
] as const;

const SQUARE_ONLY = [{ value: "1024x1024", aspect: "1:1" }] as const;
const GENERATIONS_ROUTE = "/v1/images/generations";
const EDITS_ROUTE = "/v1/images/edits";

export const BUILTIN_IMAGE: readonly BuiltinImage[] = [
  {
    ids: ["gpt-image-2"],
    spec: {
      family: "gpt-image-2",
      bodyStyle: "openai-image",
      route: GENERATIONS_ROUTE,
      editRoute: EDITS_ROUTE,
      shape: { mode: "size", field: "size", options: GPT_IMAGE_2_SIZES, default: "1024x1024" },
      quality: { field: "quality", values: ["low", "medium", "high", "auto"], default: "low" },
      outputFormat: { field: "output_format", values: ["png", "jpeg"], default: "png" },
      referenceField: "image",
      unverified: [],
      evidence: {
        route: "docs llms-full.txt:3914 (generations) and :3916 (edits); proven live 2026-11-11",
        size: "docs llms-full.txt:4282 (size rules: multiples of 16, 655,360 to 8,294,400 px, edge up to 3840) and :4290 (common sizes)",
        quality: "docs llms-full.txt:3987 (low, medium, high, auto) and :4307 (defaults to low)",
        count: "docs llms-full.txt:3944 (n depends on the model and channel); every gpt-image example sends n:1, so no count control",
        format: "docs llms-full.txt:3988 (png, jpeg); response_format is rejected, :3989",
        image: "docs llms-full.txt:4331 (image, up to 16, on /v1/images/edits)",
      },
    },
  },
  {
    ids: ["gpt-image-2-count"],
    spec: {
      family: "gpt-image-2-count",
      bodyStyle: "openai-image",
      route: GENERATIONS_ROUTE,
      editRoute: EDITS_ROUTE,
      shape: {
        mode: "size",
        field: "size",
        options: [
          { value: "1024x1024", aspect: "1:1" },
          { value: "1536x1024", aspect: "3:2" },
          { value: "1024x1536", aspect: "2:3" },
        ],
        default: "1024x1024",
      },
      referenceField: "image",
      unverified: ["quality", "format"],
      evidence: {
        route: "docs llms-full.txt:4269-4271",
        size: "docs llms-full.txt:4273 (pixel count ignored, only the aspect ratio of size is kept, output about 1.5 MP)",
        quality: "not documented for this id; none is sent",
        count: "billed per call, one image per request, docs llms-full.txt:4276",
      },
    },
  },
  {
    ids: ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
    spec: {
      family: "gpt-image-2.5-sunburst-flare",
      bodyStyle: "openai-image",
      route: GENERATIONS_ROUTE,
      shape: { mode: "size", field: "size", options: SQUARE_ONLY, default: "1024x1024" },
      referenceField: null,
      unverified: ["quality", "format", "image"],
      evidence: {
        route: "docs llms-full.txt:4252",
        size: "docs llms-full.txt:4265 (only 1024x1024 is verified for these ids)",
        quality: "the guide says not to infer quality from gpt-image-2, docs llms-full.txt:4266; none is sent",
        count: "docs llms-full.txt:4258 (n: 1)",
      },
    },
  },
  {
    ids: ["nano-banana", "nano-banana-2", "nano-banana-2-lite", "nano-banana-pro"],
    spec: {
      family: "nano-banana",
      bodyStyle: "nano-banana",
      route: GENERATIONS_ROUTE,
      editRoute: EDITS_ROUTE,
      shape: {
        mode: "aspect",
        field: "aspect_ratio",
        options: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
        default: "1:1",
      },
      tier: { field: "resolution", values: ["0.5k", "1k", "2k", "4k"], default: "1k" },
      outputFormat: { field: "output_format", values: ["png", "jpeg"], default: "png" },
      referenceField: "images",
      unverified: [],
      evidence: {
        route: "docs llms-full.txt:3914 and :3923 (the nano-banana family)",
        aspect: "docs llms-full.txt:3957",
        tier: "docs llms-full.txt:3958 (0.5k, 1k, 2k, 4k)",
        format: "docs llms-full.txt:3959 (png, jpeg)",
        count: "docs llms-full.txt:3944 (n depends on the channel); no count control",
        image: "docs llms-full.txt:3956 (images array, recommended)",
      },
    },
  },
  {
    ids: ["gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-lite-image"],
    spec: {
      family: "gemini-image",
      bodyStyle: "gemini-image",
      route: GENERATIONS_ROUTE,
      shape: { mode: "size", field: "size", options: SQUARE_ONLY, default: "1024x1024" },
      responseFormat: "b64_json",
      referenceField: "image",
      unverified: ["size", "image"],
      evidence: {
        route: "docs llms-full.txt:4390 (OpenAI-compatible endpoint)",
        size: "docs llms-full.txt:4397 (size 1024x1024 example). Aspect and tier live in the native generateContent shape (docs llms-full.txt:3795-3796), which this app does not call yet",
        count: "docs llms-full.txt:4396 (n: 1)",
        format: "docs llms-full.txt:4402 (prefer response_format b64_json; the default url is a temporary link)",
      },
    },
  },
  {
    ids: [
      "seedream-4.0",
      "seedream-4.5",
      "seedream-5.0-pro",
      "doubao-seedream-4-0-250828",
      "doubao-seedream-4-5-251128",
      "doubao-seedream-5-0-260128",
      "doubao-seedream-5-0-pro-260628",
      "dola-seedream-5-0-pro-260628",
      "dola-seedream-5-0-pro-260628-ep",
    ],
    spec: {
      family: "seedream",
      bodyStyle: "seedream",
      route: GENERATIONS_ROUTE,
      editRoute: EDITS_ROUTE,
      shape: {
        mode: "size",
        field: "size",
        options: [
          { value: "2048x2048", aspect: "1:1" },
          { value: "2304x1728", aspect: "4:3" },
          { value: "1728x2304", aspect: "3:4" },
        ],
        default: "2048x2048",
      },
      referenceField: "image",
      unverified: ["size", "image"],
      evidence: {
        route: "pricing.json supported_endpoint_types: image-generation; no config.parameters published",
        size: "assumed (Volcengine Seedream 4.x/5.x: 2K-class pixel sizes); the gateway publishes no enum",
        quality: "no quality tier in the Seedream API; the size is the quality",
        count: "unverified, so no count control",
      },
    },
  },
  {
    ids: ["grok-imagine-image", "grok-imagine-image-2.0"],
    spec: {
      family: "grok-imagine-image",
      bodyStyle: "grok-image",
      route: GENERATIONS_ROUTE,
      editRoute: EDITS_ROUTE,
      shape: { mode: "aspect", field: "aspect_ratio", options: ["1:1", "16:9", "9:16", "3:2", "2:3"], default: "1:1" },
      referenceField: "image",
      unverified: ["aspect", "image"],
      evidence: {
        route: "pricing.json supported_endpoint_types: image-generation + openai-image-edit",
        aspect: "assumed (xAI grok-imagine-image); the gateway publishes nothing",
        count: "unverified, so no count control",
      },
    },
  },
];

type FamilyImage = { family: string; match: RegExp; spec: ImageSpecBody };

function imageFamily(id: string, family: string, match: RegExp): FamilyImage {
  const entry = BUILTIN_IMAGE.find((item) => item.ids.includes(id));
  if (!entry) {
    throw new Error(`media-params-table: no built-in image entry for ${id}`);
  }
  const { unverified, evidence, ...rest } = entry.spec;
  return {
    family,
    match,
    spec: {
      ...rest,
      family,
      unverified: [...new Set([...unverified, "size", "aspect"])],
      evidence: { ...evidence, family: `family default copied from ${id}; an unlisted id may differ` },
    },
  };
}

export const IMAGE_FAMILY_DEFAULTS: readonly FamilyImage[] = [
  imageFamily("gpt-image-2.5-sunburst", "gpt-image-2.5", /gpt-image-2\.5/i),
  imageFamily("gpt-image-2", "gpt-image", /gpt-image/i),
  imageFamily("nano-banana", "nano-banana", /^nano-banana/i),
  imageFamily("gemini-3.1-flash-image-preview", "gemini-image", /gemini-[\w.-]*image/i),
  imageFamily("seedream-4.5", "seedream", /seedream/i),
  imageFamily("grok-imagine-image", "grok-imagine-image", /grok-imagine-image/i),
];

/** The last resort for an image id nothing knows: a square, because every image model draws one. */
export const GENERIC_IMAGE: ImageSpecBody = {
  family: "generic-image",
  bodyStyle: "generic-image",
  route: GENERATIONS_ROUTE,
  shape: { mode: "size", field: "size", options: SQUARE_ONLY, default: "1024x1024" },
  referenceField: "image",
  unverified: ["size", "quality", "count", "format", "image"],
  evidence: {
    route: "docs llms-full.txt:3914 (the generic image route)",
    size: "family default: a square is the one shape every image model draws; nothing else is known to be accepted",
  },
};
