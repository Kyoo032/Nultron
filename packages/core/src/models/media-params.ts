/**
 * Resolve one model's media parameter spec, and settle a request against it.
 *
 * `videoSpecFor` / `imageSpecFor` answer "what does this model accept" (`media-params-types.ts`).
 * `settleVideo` / `settleImage` take what a person or a tool asked for and answer "what will be sent":
 * a value the spec rejects is moved to the nearest valid one (and said so in `adjustments`), a control
 * the model does not have is left out, and the one request that cannot be met (sound on a model that
 * makes silent clips) is refused. Nothing the spec rejects is ever sent.
 *
 * No Node imports: the studios in the renderer read the option lists.
 */

import { ApiError } from "../errors";
import { modeMessage } from "../mode-messages";
import type { AppLocale } from "../locale";
import {
  applyPublishedImage,
  applyPublishedVideo,
  publishedLooksLikeSeedance,
  type PublishedMediaParams,
} from "./media-params-published";
import {
  BUILTIN_IMAGE,
  BUILTIN_VIDEO,
  GENERIC_IMAGE,
  GENERIC_VIDEO,
  IMAGE_FAMILY_DEFAULTS,
  VIDEO_FAMILY_DEFAULTS,
} from "./media-params-table";
import {
  MEDIA_DEFAULTS,
  type ImageParamSpec,
  type ImageSizeOption,
  type MediaAdjustment,
  type VideoLengthSpec,
  type VideoParamSpec,
} from "./media-params-types";

export * from "./media-params-types";
export type { PublishedMediaParams } from "./media-params-published";

// ------------------------------------------------------------------------------------- resolution

const videoById = new Map<string, (typeof BUILTIN_VIDEO)[number]>();
for (const entry of BUILTIN_VIDEO) {
  for (const id of entry.ids) {
    videoById.set(id.toLowerCase(), entry);
  }
}
const imageById = new Map<string, (typeof BUILTIN_IMAGE)[number]>();
for (const entry of BUILTIN_IMAGE) {
  for (const id of entry.ids) {
    imageById.set(id.toLowerCase(), entry);
  }
}

/**
 * The spec for one video model: what the gateway published for it, else the built-in table, else its
 * family's default (unverified). Always answers: an id nothing knows gets the generic route with a
 * prompt and a length.
 */
export function videoSpecFor(model: string, published?: PublishedMediaParams): VideoParamSpec {
  const id = model.trim();
  const exact = videoById.get(id.toLowerCase());
  const family = exact ? undefined : VIDEO_FAMILY_DEFAULTS.find((item) => item.match.test(id));
  let body = exact?.spec ?? family?.spec;
  if (!body && published && publishedLooksLikeSeedance(published)) {
    body = VIDEO_FAMILY_DEFAULTS.find((item) => item.family === "seedance")?.spec;
  }
  const spec: VideoParamSpec = {
    kind: "video",
    ...(body ?? GENERIC_VIDEO),
    source: exact ? "built-in" : "family-default",
  };
  return published ? applyPublishedVideo(spec, published) : spec;
}

/** The spec for one image model. Same order as `videoSpecFor`. */
export function imageSpecFor(model: string, published?: PublishedMediaParams): ImageParamSpec {
  const id = model.trim();
  const exact = imageById.get(id.toLowerCase());
  const family = exact ? undefined : IMAGE_FAMILY_DEFAULTS.find((item) => item.match.test(id));
  const spec: ImageParamSpec = {
    kind: "image",
    ...(exact?.spec ?? family?.spec ?? GENERIC_IMAGE),
    source: exact ? "built-in" : "family-default",
  };
  return published ? applyPublishedImage(spec, published) : spec;
}

// ------------------------------------------------------------------------------------- number work

/** `720p` -> 720, `4k` -> 4000, `1K` -> 1000, `512` -> 512. Orders resolution tiers; undefined when not one. */
export function tierRank(token: string): number | undefined {
  const value = token.trim().toLowerCase();
  const pixels = /^(\d+)p$/.exec(value);
  if (pixels) {
    return Number(pixels[1]);
  }
  const kilo = /^(\d+(?:\.\d+)?)k$/.exec(value);
  if (kilo) {
    return Number(kilo[1]) * 1000;
  }
  const plain = /^\d+$/.exec(value);
  return plain ? Number(value) : undefined;
}

/** `16:9` -> 1.777, `1536x1024` -> 1.5; undefined when it is neither. */
export function ratioOf(token: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i.exec(token.trim());
  if (!match) {
    return undefined;
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w > 0 && h > 0 ? w / h : undefined;
}

/** The legacy three-way shape the chat tool and the cost estimate speak. */
export function shapeOfRatio(ratio: number): "square" | "landscape" | "portrait" {
  if (ratio > 1.05) {
    return "landscape";
  }
  if (ratio < 0.95) {
    return "portrait";
  }
  return "square";
}

const SHAPE_RATIO = { square: 1, landscape: 3 / 2, portrait: 2 / 3 } as const;

function nearestNumber(values: readonly number[], asked: number): number {
  return values.reduce((best, value) => (Math.abs(value - asked) < Math.abs(best - asked) ? value : best), values[0]);
}

// ---------------------------------------------------------------------------------- video options

/** Every length a model takes, for validation. A range is every whole step in it. */
function allLengths(length: VideoLengthSpec): number[] {
  if (length.values && length.values.length > 0) {
    return [...length.values];
  }
  const min = length.min ?? length.default;
  const max = length.max ?? length.default;
  const step = Math.max(1, length.step ?? 1);
  const all: number[] = [];
  for (let value = min; value <= max; value += step) {
    all.push(value);
  }
  return all.length > 0 ? all : [length.default];
}

const NICE_LENGTHS = [5, 6, 8, 10, 12, 15, 20, 25, 30];

/**
 * The clip lengths a picker offers: the whole set when the model has a fixed one, and for a range the
 * ends, the default and the round numbers between (4 to 30 is ten choices, not twenty-seven). The
 * server takes any whole second in the range; the picker just does not list them all.
 */
export function videoLengthOptions(spec: VideoParamSpec): number[] {
  const all = allLengths(spec.length);
  if (spec.length.values || all.length <= 12) {
    return all;
  }
  const keep = new Set<number>([all[0], all[all.length - 1], spec.length.default]);
  for (const value of NICE_LENGTHS) {
    if (all.includes(value)) {
      keep.add(value);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/** A length past the ends of a range (or of a fixed set) is out of range; one inside it that is not offered is just not offered. */
function lengthIsOutOfRange(length: VideoLengthSpec, asked: number): boolean {
  const all = allLengths(length);
  return asked < Math.min(...all) || asked > Math.max(...all);
}

export function snapVideoLength(length: VideoLengthSpec, asked?: number): number {
  if (typeof asked !== "number" || !Number.isFinite(asked)) {
    return length.default;
  }
  return nearestNumber(allLengths(length), Math.round(asked));
}

export function videoAspectOptions(spec: VideoParamSpec): readonly string[] {
  return spec.aspect?.values ?? [];
}

export function videoResolutionOptions(spec: VideoParamSpec): readonly string[] {
  return spec.resolution?.values ?? [];
}

// ----------------------------------------------------------------------------------- video settle

export type VideoChoice = {
  /** A ratio such as `16:9`. */
  aspect?: string;
  seconds?: number;
  resolution?: string;
  /** Sound inside the clip. Left out means the app's default (off). */
  audio?: boolean;
};

/** What is actually sent. A field the model does not have is absent. */
export type VideoSent = {
  aspect?: string;
  seconds: number;
  resolution?: string;
  audio?: boolean;
};

export type VideoSettled = VideoSent & { adjustments: MediaAdjustment[] };

function nearestRatio(options: readonly string[], asked: string, fallback: string): string {
  if (options.includes(asked)) {
    return asked;
  }
  const target = ratioOf(asked);
  if (target === undefined) {
    return fallback;
  }
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const ratio = ratioOf(option);
    if (ratio === undefined) {
      continue;
    }
    const distance = Math.abs(Math.log(target / ratio));
    // Ties keep the default, then the first listed.
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && option === fallback)) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestTier(options: readonly string[], asked: string, fallback: string): string {
  if (options.includes(asked)) {
    return asked;
  }
  const rank = tierRank(asked);
  if (rank === undefined) {
    return fallback;
  }
  const ranked = options
    .map((option) => ({ option, rank: tierRank(option) }))
    .filter((item): item is { option: string; rank: number } => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank);
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of ranked) {
    const distance = Math.abs(item.rank - rank);
    // Ascending order and a strict `<`: a tie goes to the lower tier, the cheaper one.
    if (distance < bestDistance) {
      best = item.option;
      bestDistance = distance;
    }
  }
  return best ?? fallback;
}

/** 720p where the model offers it, else the model's own default. */
function defaultResolution(values: readonly string[], fallback: string): string {
  return values.includes(MEDIA_DEFAULTS.videoResolution) ? MEDIA_DEFAULTS.videoResolution : fallback;
}

/**
 * Settle a video request against a spec. Never throws for a value that is merely wrong: it moves to the
 * nearest valid one and records the move. Throws `video_audio_unsupported` when sound was asked for on a
 * model that has no switch for it, because a silent clip is not what was asked for.
 */
export function settleVideo(
  spec: VideoParamSpec,
  choice: VideoChoice,
  context: { model?: string; locale?: AppLocale } = {},
): VideoSettled {
  const adjustments: MediaAdjustment[] = [];

  let aspect: string | undefined;
  if (spec.aspect) {
    const asked = choice.aspect?.trim();
    aspect = asked ? nearestRatio(spec.aspect.values, asked, spec.aspect.default) : spec.aspect.default;
    if (asked && aspect !== asked) {
      adjustments.push({ field: "aspect", asked, used: aspect, reason: "not_offered" });
    }
  } else if (choice.aspect) {
    adjustments.push({ field: "aspect", asked: choice.aspect, used: undefined, reason: "not_supported" });
  }

  const asked = choice.seconds;
  const seconds = snapVideoLength(spec.length, asked);
  if (typeof asked === "number" && Number.isFinite(asked) && seconds !== asked) {
    adjustments.push({
      field: "seconds",
      asked,
      used: seconds,
      reason: lengthIsOutOfRange(spec.length, asked) ? "out_of_range" : "not_offered",
    });
  }

  let resolution: string | undefined;
  if (spec.resolution) {
    const wanted = choice.resolution?.trim().toLowerCase();
    resolution = wanted
      ? nearestTier(spec.resolution.values, wanted, defaultResolution(spec.resolution.values, spec.resolution.default))
      : defaultResolution(spec.resolution.values, spec.resolution.default);
    if (wanted && resolution !== wanted) {
      adjustments.push({ field: "resolution", asked: wanted, used: resolution, reason: "not_offered" });
    }
  } else if (choice.resolution) {
    adjustments.push({ field: "resolution", asked: choice.resolution, used: undefined, reason: "not_supported" });
  }

  let audio: boolean | undefined;
  if (spec.audio.supported && spec.audio.field) {
    audio = choice.audio ?? MEDIA_DEFAULTS.videoAudio;
  } else if (choice.audio === true) {
    const base = modeMessage("videoAudioUnsupported", context.locale ?? "en");
    throw new ApiError("video_audio_unsupported", context.model ? `${base} (${context.model})` : base, 400);
  }

  return { aspect, seconds, resolution, audio, adjustments };
}

// ---------------------------------------------------------------------------------- image options

export type ImageShapeOption = { value: string; aspect: string; label: string };

/** Every shape or size a model takes, with a label for a picker. */
export function imageShapeOptions(spec: ImageParamSpec): ImageShapeOption[] {
  if (spec.shape.mode === "aspect") {
    return spec.shape.options.map((aspect) => ({ value: aspect, aspect, label: aspect }));
  }
  return spec.shape.options.map((option) => ({
    value: option.value,
    aspect: option.aspect,
    label: `${option.value.replace("x", " × ")} · ${option.aspect}`,
  }));
}

export function imageCountMax(spec: ImageParamSpec): number {
  return spec.count?.max ?? 1;
}

// ----------------------------------------------------------------------------------- image settle

export type ImageChoice = {
  /** The legacy three-way shape (the chat tool, a stored edit job). Used when no exact value is given. */
  shape?: "square" | "landscape" | "portrait";
  /** A ratio such as `3:2`. */
  aspectRatio?: string;
  /** An exact size such as `1536x1024`. */
  size?: string;
  quality?: string;
  /** A resolution tier such as `2k`. */
  tier?: string;
  count?: number;
  outputFormat?: string;
};

export type ImageSent = {
  /** The value of the shape field: a size (`1536x1024`) or a ratio (`3:2`). */
  shapeValue: string;
  /** The ratio it draws. */
  aspect: string;
  quality?: string;
  tier?: string;
  count: number;
  outputFormat?: string;
};

export type ImageSettled = ImageSent & { adjustments: MediaAdjustment[] };

function pickShape(spec: ImageParamSpec, choice: ImageChoice): { option: ImageShapeOption; asked?: string } {
  const options = imageShapeOptions(spec);
  const fallback = options.find((option) => option.value === spec.shape.default) ?? options[0];
  const exact = choice.size ? options.find((option) => option.value === choice.size) : undefined;
  if (exact) {
    return { option: exact };
  }
  const askedLabel = choice.size ?? choice.aspectRatio ?? choice.shape;
  let target: number | undefined;
  if (choice.size) {
    target = ratioOf(choice.size);
  }
  if (target === undefined && choice.aspectRatio) {
    target = ratioOf(choice.aspectRatio);
  }
  if (target === undefined && choice.shape) {
    target = SHAPE_RATIO[choice.shape];
  }
  if (target === undefined) {
    return { option: fallback };
  }
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const ratio = ratioOf(option.aspect);
    if (ratio === undefined) {
      continue;
    }
    const distance = Math.abs(Math.log(target / ratio));
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && option === fallback)) {
      best = option;
      bestDistance = distance;
    }
  }
  return { option: best, asked: askedLabel };
}

/**
 * Settle an image request against a spec. A size, quality, tier, count or format the model does not
 * take is moved to the nearest valid value or left out, and every move is recorded.
 */
export function settleImage(spec: ImageParamSpec, choice: ImageChoice): ImageSettled {
  const adjustments: MediaAdjustment[] = [];

  const { option, asked } = pickShape(spec, choice);
  // The legacy shape is a loose ask ("landscape"), so landing on 3:2 is not a correction. An exact
  // size or ratio that was not offered is.
  const looseShape = !choice.size && !choice.aspectRatio;
  if (asked !== undefined && !looseShape && asked !== option.value && asked !== option.aspect) {
    adjustments.push({ field: "size", asked, used: option.value, reason: "not_offered" });
  }

  let quality: string | undefined;
  if (spec.quality) {
    const wanted = choice.quality?.trim().toLowerCase();
    const preferred = spec.quality.values.includes(MEDIA_DEFAULTS.imageQuality)
      ? MEDIA_DEFAULTS.imageQuality
      : spec.quality.default;
    quality = wanted && spec.quality.values.includes(wanted) ? wanted : preferred;
    if (wanted && quality !== wanted) {
      adjustments.push({ field: "quality", asked: wanted, used: quality, reason: "not_offered" });
    }
  } else if (choice.quality) {
    adjustments.push({ field: "quality", asked: choice.quality, used: undefined, reason: "not_supported" });
  }

  let tier: string | undefined;
  if (spec.tier) {
    const wanted = choice.tier?.trim().toLowerCase();
    tier = wanted ? nearestTier(spec.tier.values, wanted, spec.tier.default) : spec.tier.default;
    if (wanted && tier !== wanted) {
      adjustments.push({ field: "tier", asked: wanted, used: tier, reason: "not_offered" });
    }
  } else if (choice.tier) {
    adjustments.push({ field: "tier", asked: choice.tier, used: undefined, reason: "not_supported" });
  }

  const max = imageCountMax(spec);
  const askedCount = typeof choice.count === "number" && Number.isFinite(choice.count) ? Math.round(choice.count) : undefined;
  const count = Math.min(max, Math.max(1, askedCount ?? spec.count?.default ?? 1));
  if (askedCount !== undefined && askedCount !== count) {
    adjustments.push({
      field: "count",
      asked: askedCount,
      used: count,
      reason: spec.count ? "out_of_range" : "not_supported",
    });
  }

  let outputFormat: string | undefined;
  if (spec.outputFormat) {
    const wanted = choice.outputFormat?.trim().toLowerCase();
    outputFormat = wanted && spec.outputFormat.values.includes(wanted) ? wanted : spec.outputFormat.default;
    if (wanted && outputFormat !== wanted) {
      adjustments.push({ field: "format", asked: wanted, used: outputFormat, reason: "not_offered" });
    }
  } else if (choice.outputFormat) {
    adjustments.push({ field: "format", asked: choice.outputFormat, used: undefined, reason: "not_supported" });
  }

  return { shapeValue: option.value, aspect: option.aspect, quality, tier, count, outputFormat, adjustments };
}

/** A size option as the renderer needs it. Re-exported so the page need not import the types file twice. */
export type { ImageSizeOption };
