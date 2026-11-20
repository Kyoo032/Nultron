/**
 * What the gateway itself says a media model accepts, read from its public price list
 * (`GET <origin>/api/pricing`, `supported_endpoints[*].config.parameters`).
 *
 * Only the Seedance rows publish parameters today (enums for `resolution`, defaults for `duration` and
 * `generate_audio`). Reading them generically means a model the table has never heard of, or a changed
 * enum, works with no code change: `applyPublishedVideo` lays what was published over the spec.
 *
 * No Node imports.
 */

import type { ImageParamSpec, VideoParamSpec } from "./media-params-types";

/** The slice of a price-list entry's published parameters that a spec can use. */
export type PublishedMediaParams = {
  /** The `content` array is published: this is the Seedance native body. */
  hasContent?: boolean;
  resolutionEnum?: readonly string[];
  ratioEnum?: readonly string[];
  duration?: { default?: number; min?: number; max?: number; enum?: readonly number[] };
  /** `generate_audio` is published, with the gateway's default. */
  audio?: { default: boolean };
  qualityEnum?: readonly string[];
  sizeEnum?: readonly string[];
  countMax?: number;
  outputFormatEnum?: readonly string[];
};

export type PublishedMediaMap = Readonly<Record<string, PublishedMediaParams>>;

type ParamDef = { type?: unknown; enum?: unknown; default?: unknown; minimum?: unknown; maximum?: unknown };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function numbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return out.length > 0 ? out : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TIER_ENUM = /^(?:\d+p|\d+(?:\.\d+)?k)$/i;
const RATIO_ENUM = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;

/** One entry's parameters, merged across its endpoints. A later endpoint never overwrites an earlier value. */
function readEntry(row: Record<string, unknown>): PublishedMediaParams | undefined {
  const endpoints = record(row.supported_endpoints);
  const out: {
    -readonly [K in keyof PublishedMediaParams]: PublishedMediaParams[K];
  } = {};
  let any = false;
  for (const endpoint of Object.values(endpoints)) {
    const parameters = record(record(record(endpoint).config).parameters);
    for (const [name, raw] of Object.entries(parameters)) {
      const def = record(raw) as ParamDef;
      switch (name) {
        case "content":
          out.hasContent = true;
          any = true;
          break;
        case "resolution":
        case "size": {
          const list = strings(def.enum)?.filter((item) => TIER_ENUM.test(item));
          if (list && list.length > 0 && !out.resolutionEnum) {
            out.resolutionEnum = list.map((item) => item.toLowerCase());
            any = true;
          }
          const sizes = name === "size" ? strings(def.enum)?.filter((item) => /^\d+x\d+$/i.test(item)) : undefined;
          if (sizes && sizes.length > 0 && !out.sizeEnum) {
            out.sizeEnum = sizes;
            any = true;
          }
          break;
        }
        case "ratio":
        case "aspect_ratio": {
          const list = strings(def.enum)?.filter((item) => RATIO_ENUM.test(item));
          if (list && list.length > 0 && !out.ratioEnum) {
            out.ratioEnum = list;
            any = true;
          }
          break;
        }
        case "duration":
        case "seconds":
        case "video_length": {
          if (out.duration) {
            break;
          }
          const duration = {
            default: finite(def.default),
            min: finite(def.minimum),
            max: finite(def.maximum),
            enum: numbers(def.enum),
          };
          if (duration.default !== undefined || duration.min !== undefined || duration.max !== undefined || duration.enum) {
            out.duration = duration;
            any = true;
          }
          break;
        }
        case "generate_audio":
          if (!out.audio) {
            out.audio = { default: def.default === true };
            any = true;
          }
          break;
        case "quality": {
          const list = strings(def.enum);
          if (list && !out.qualityEnum) {
            out.qualityEnum = list.map((item) => item.toLowerCase());
            any = true;
          }
          break;
        }
        case "n": {
          const max = finite(def.maximum);
          if (max !== undefined && out.countMax === undefined) {
            out.countMax = Math.max(1, Math.floor(max));
            any = true;
          }
          break;
        }
        case "output_format": {
          const list = strings(def.enum);
          if (list && !out.outputFormatEnum) {
            out.outputFormatEnum = list.map((item) => item.toLowerCase());
            any = true;
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return any ? out : undefined;
}

/** `model id (lower case) -> published parameters`, for every price-list entry that publishes any. */
export function parsePublishedMediaParams(body: unknown): PublishedMediaMap {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  const out: Record<string, PublishedMediaParams> = {};
  if (!Array.isArray(data)) {
    return out;
  }
  let count = 0;
  for (const item of data) {
    const row = record(item);
    const name = typeof row.model_name === "string" ? row.model_name.trim() : "";
    if (!name || count >= 2_000) {
      continue;
    }
    const read = readEntry(row);
    if (read) {
      out[name.toLowerCase()] = read;
      count += 1;
    }
  }
  return out;
}

/** The stored map as a map, dropping anything that is not the right shape. Capped. */
export function sanitizePublishedMediaParams(value: unknown): PublishedMediaMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, PublishedMediaParams> = {};
  let count = 0;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 2_000) {
      break;
    }
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      out[id.toLowerCase()] = raw as PublishedMediaParams;
      count += 1;
    }
  }
  return count > 0 ? out : undefined;
}

/** A price-list entry that publishes the Seedance native body is a Seedance model, whatever its id says. */
export function publishedLooksLikeSeedance(published: PublishedMediaParams): boolean {
  return published.hasContent === true;
}

// ------------------------------------------------------------------------------------------ apply

function without(list: readonly string[], drop: readonly string[]): string[] {
  return list.filter((item) => !drop.includes(item));
}

function tierDefault(values: readonly string[], preferred: string, fallback: string): string {
  if (values.includes(preferred)) {
    return preferred;
  }
  return values.includes(fallback) ? fallback : values[0];
}

/**
 * Lay what the gateway published over a spec. Published beats the table, because it is the gateway's
 * own schema: a changed resolution enum or a new default takes effect with no code change.
 */
export function applyPublishedVideo(spec: VideoParamSpec, published: PublishedMediaParams): VideoParamSpec {
  let next: VideoParamSpec = spec;
  const evidence: Record<string, string> = { ...spec.evidence };
  let unverified: readonly string[] = spec.unverified;
  let touched = false;
  const mark = (field: string, note: string, stillUnverified = false) => {
    evidence[field] = note;
    if (!stillUnverified) {
      unverified = without(unverified, [field]);
    }
    touched = true;
  };

  if (published.resolutionEnum && published.resolutionEnum.length > 0 && spec.bodyStyle === "seedance-content") {
    const values = published.resolutionEnum;
    next = {
      ...next,
      resolution: {
        field: spec.resolution?.field ?? "size",
        values,
        default: tierDefault(values, "720p", spec.resolution?.default ?? values[0]),
      },
    };
    mark("resolution", "published: price list config.parameters.resolution.enum");
  }

  if (published.ratioEnum && published.ratioEnum.length > 0 && next.aspect) {
    const values = published.ratioEnum;
    next = {
      ...next,
      aspect: {
        ...next.aspect,
        values,
        default: values.includes(next.aspect.default) ? next.aspect.default : values[0],
      },
    };
    mark("aspect", "published: price list config.parameters.ratio.enum");
  }

  if (published.duration) {
    const published_ = published.duration;
    const length = { ...next.length };
    if (published_.enum && published_.enum.length > 0) {
      length.values = published_.enum;
      delete length.min;
      delete length.max;
    } else if (published_.min !== undefined || published_.max !== undefined) {
      delete length.values;
      length.min = published_.min ?? length.min ?? length.default;
      length.max = published_.max ?? length.max ?? length.default;
      length.step = length.step ?? 1;
    }
    if (published_.default !== undefined) {
      length.default = published_.default;
      // A default the gateway publishes is a length it accepts, so it joins what the spec offers: the
      // conservative family default (one length) widens to it, a range stretches to cover it.
      if (length.values && !length.values.includes(length.default)) {
        length.values = [...length.values, length.default].sort((a, b) => a - b);
      } else if (!length.values) {
        length.min = Math.min(length.min ?? length.default, length.default);
        length.max = Math.max(length.max ?? length.default, length.default);
      }
    }
    next = { ...next, length };
    // For a Seedance model on the generic route the published `duration` belongs to the native endpoint,
    // and the generic route ignored `duration` in live calls (2026-11-11), so the length stays unverified.
    const genericSeedance = spec.bodyStyle === "seedance-content";
    mark(
      "length",
      genericSeedance
        ? `${spec.evidence.length ?? ""} Published: price list config.parameters.duration (the native endpoint's).`
        : "published: price list config.parameters.duration",
      genericSeedance,
    );
  }

  if (spec.bodyStyle === "seedance-content" && published.hasContent) {
    next = {
      ...next,
      audio: published.audio
        ? { supported: true, field: "metadata.generate_audio", default: published.audio.default }
        : { supported: false, default: false },
    };
    mark("audio", "published: price list config.parameters.generate_audio");
  }

  return touched ? { ...next, source: "published", unverified, evidence } : spec;
}

export function applyPublishedImage(spec: ImageParamSpec, published: PublishedMediaParams): ImageParamSpec {
  let next: ImageParamSpec = spec;
  const evidence: Record<string, string> = { ...spec.evidence };
  let unverified: readonly string[] = spec.unverified;
  let touched = false;
  const mark = (field: string, note: string, stillUnverified = false) => {
    evidence[field] = note;
    if (!stillUnverified) {
      unverified = without(unverified, [field]);
    }
    touched = true;
  };

  if (published.qualityEnum && published.qualityEnum.length > 0) {
    const values = published.qualityEnum;
    next = {
      ...next,
      quality: {
        field: spec.quality?.field ?? "quality",
        values,
        default: spec.quality && values.includes(spec.quality.default) ? spec.quality.default : values[0],
      },
    };
    mark("quality", "published: price list config.parameters.quality.enum");
  }

  if (published.countMax !== undefined && published.countMax > 1) {
    next = { ...next, count: { field: spec.count?.field ?? "n", max: published.countMax, default: 1 } };
    mark("count", "published: price list config.parameters.n.maximum");
  }

  if (published.outputFormatEnum && published.outputFormatEnum.length > 0) {
    const values = published.outputFormatEnum;
    next = {
      ...next,
      outputFormat: {
        field: spec.outputFormat?.field ?? "output_format",
        values,
        default: spec.outputFormat && values.includes(spec.outputFormat.default) ? spec.outputFormat.default : values[0],
      },
    };
    mark("format", "published: price list config.parameters.output_format.enum");
  }

  if (published.sizeEnum && published.sizeEnum.length > 0 && spec.shape.mode === "size") {
    const options = published.sizeEnum.map((value) => {
      const match = /^(\d+)x(\d+)$/i.exec(value);
      const known = spec.shape.mode === "size" ? spec.shape.options.find((option) => option.value === value) : undefined;
      if (known) {
        return known;
      }
      const w = Number(match?.[1] ?? 1);
      const h = Number(match?.[2] ?? 1);
      return { value, aspect: reduceRatio(w, h) };
    });
    next = {
      ...next,
      shape: {
        mode: "size",
        field: spec.shape.field,
        options,
        default: options.some((option) => option.value === spec.shape.default) ? spec.shape.default : options[0].value,
      },
    };
    mark("size", "published: price list config.parameters.size.enum");
  }

  return touched ? { ...next, source: "published", unverified, evidence } : spec;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function reduceRatio(w: number, h: number): string {
  const divisor = gcd(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}
