/**
 * The studios' media options, as pure functions over a model's media parameter spec.
 *
 * The host sends each model with its spec (`media`, `packages/host/src/media-spec.ts`); the page shows
 * only the controls the spec has, with only the values it lists. These helpers hold the rest: the pick a
 * model starts with, the nearest valid pick when the model changes, the request fields a pick becomes,
 * and the one-line notes ("Changed for this model: resolution 1080p → 720p").
 *
 * The rules (nearest value, 720p where offered, sound off, quality medium) are core's
 * (`@agentforge/core/media-params`); nothing here re-derives them.
 */

import {
  imageShapeOptions,
  imageSpecFor,
  ratioOf,
  settleImage,
  settleVideo,
  shapeOfRatio,
  videoSpecFor,
  type ImageParamSpec,
  type ImageSent,
  type MediaAdjustment,
  type MediaParamSpec,
  type VideoParamSpec,
  type VideoSent,
} from "@agentforge/core/media-params";
import { t } from "@/lib/i18n";

type ModelWithSpec = { id: string; media?: MediaParamSpec };

// ------------------------------------------------------------------------------------------ video

/** What the video controls hold. `aspect` and `resolution` are empty for a model that has no such control. */
export type VideoPick = { aspect: string; seconds: number; resolution: string; audio: boolean };

/** A model's spec: the one the host sent with the list, else the built-in table's. */
export function videoSpecOf(model: string, models: readonly ModelWithSpec[]): VideoParamSpec {
  const media = models.find((item) => item.id === model)?.media;
  return media?.kind === "video" ? media : videoSpecFor(model);
}

function moved(adjustments: readonly MediaAdjustment[]): MediaAdjustment[] {
  return adjustments.filter((item) => item.used !== undefined);
}

/**
 * The pick for a model. With no `previous` it is the model's own defaults (720p where offered, its
 * default length, sound off). With one, each value stays when the model takes it and moves to the
 * nearest value it does take when not; `moved` lists what moved so the page can say so.
 */
export function fitVideoPick(
  spec: VideoParamSpec,
  previous?: Partial<VideoPick>,
): { pick: VideoPick; moved: MediaAdjustment[] } {
  const settled = settleVideo(spec, {
    aspect: previous?.aspect || undefined,
    seconds: previous?.seconds,
    resolution: previous?.resolution || undefined,
    // A model with no sound switch refuses `true`; the toggle is hidden for it, so it just stays off.
    audio: spec.audio.supported ? previous?.audio : undefined,
  });
  return {
    pick: {
      aspect: settled.aspect ?? "",
      seconds: settled.seconds,
      resolution: settled.resolution ?? "",
      audio: settled.audio ?? false,
    },
    moved: moved(settled.adjustments),
  };
}

/** The request fields a pick becomes: only the ones the model has. */
export function videoRequestFields(
  spec: VideoParamSpec,
  pick: VideoPick,
): { aspect?: string; seconds: number; resolution?: string; audio?: boolean } {
  return {
    ...(spec.aspect && pick.aspect ? { aspect: pick.aspect } : {}),
    seconds: pick.seconds,
    ...(spec.resolution && pick.resolution ? { resolution: pick.resolution } : {}),
    ...(spec.audio.supported ? { audio: pick.audio } : {}),
  };
}

// ------------------------------------------------------------------------------------------ image

/**
 * What the image controls hold. `shape` is the value of the model's shape field (a size such as
 * `1536x1024`, or a ratio such as `3:2`); until the person touches the menu the sentence picks it.
 */
export type ImagePick = {
  shape: string;
  shapeTouched: boolean;
  quality: string;
  tier: string;
  count: number;
  format: string;
};

export function imageSpecOf(model: string, models: readonly ModelWithSpec[]): ImageParamSpec {
  const media = models.find((item) => item.id === model)?.media;
  return media?.kind === "image" ? media : imageSpecFor(model);
}

type LooseShape = "square" | "landscape" | "portrait";

/**
 * The pick for an image model. Until the person touches the shape menu, `promptShape` (the shape the
 * sentence asks for) picks the size or ratio nearest to it.
 */
export function fitImagePick(
  spec: ImageParamSpec,
  previous: ImagePick | undefined,
  promptShape: LooseShape,
): { pick: ImagePick; moved: MediaAdjustment[] } {
  const keepShape = previous?.shapeTouched === true && previous.shape;
  const settled = settleImage(spec, {
    ...(keepShape ? (previous.shape.includes("x") ? { size: previous.shape } : { aspectRatio: previous.shape }) : { shape: promptShape }),
    quality: previous?.quality || undefined,
    tier: previous?.tier || undefined,
    count: previous?.count,
    outputFormat: previous?.format || undefined,
  });
  return {
    pick: {
      shape: settled.shapeValue,
      shapeTouched: previous?.shapeTouched === true,
      quality: settled.quality ?? "",
      tier: settled.tier ?? "",
      count: settled.count,
      format: settled.outputFormat ?? "",
    },
    moved: moved(settled.adjustments),
  };
}

/** The shape value to show and send: the person's pick once they made one, else what the sentence asks for. */
export function effectiveShape(spec: ImageParamSpec, pick: ImagePick, promptShape: LooseShape): string {
  if (pick.shapeTouched && imageShapeOptions(spec).some((option) => option.value === pick.shape)) {
    return pick.shape;
  }
  return settleImage(spec, { shape: promptShape }).shapeValue;
}

/** The loose shape of a shape value, for the cost estimate (which prices a square, a landscape or a portrait). */
export function shapeOfValue(spec: ImageParamSpec, value: string): LooseShape {
  const option = imageShapeOptions(spec).find((item) => item.value === value);
  return shapeOfRatio(ratioOf(option?.aspect ?? "1:1") ?? 1);
}

/** The request fields a pick becomes: only the ones the model has. */
export function imageRequestFields(
  spec: ImageParamSpec,
  pick: ImagePick,
  promptShape: LooseShape,
): {
  aspect: LooseShape;
  size?: string;
  aspectRatio?: string;
  quality?: string;
  tier?: string;
  count?: number;
  outputFormat?: string;
} {
  const value = effectiveShape(spec, pick, promptShape);
  return {
    aspect: shapeOfValue(spec, value),
    ...(spec.shape.mode === "size" ? { size: value } : { aspectRatio: value }),
    ...(spec.quality && pick.quality ? { quality: pick.quality } : {}),
    ...(spec.tier && pick.tier ? { tier: pick.tier } : {}),
    ...(spec.count && pick.count > 1 ? { count: pick.count } : {}),
    ...(spec.outputFormat && pick.format ? { outputFormat: pick.format } : {}),
  };
}

// ------------------------------------------------------------------------------------------ notes

type NoteKind = "videos" | "images";

function changeText(kind: NoteKind, item: MediaAdjustment): string {
  const unit = item.field === "seconds" ? " s" : "";
  return t(`${kind}.change.${item.field}`, { asked: `${item.asked}${unit}`, used: `${item.used}${unit}` });
}

/**
 * "Changed for <model>: resolution 1080p → 720p." for what moved when a model was picked, or when a
 * request was settled. `null` when nothing moved.
 */
export function adjustedNote(kind: NoteKind, model: string, adjustments: readonly MediaAdjustment[]): string | null {
  const items = moved(adjustments);
  if (items.length === 0) {
    return null;
  }
  return t(`${kind}.adjusted`, { model, changes: items.map((item) => changeText(kind, item)).join(", ") });
}

/** What a video was made with, from the host's `sent`. */
export function videoSentNote(sent: VideoSent): string {
  const parts = [
    sent.resolution,
    t("videos.seconds", { n: sent.seconds }),
    sent.aspect,
    sent.audio === undefined ? undefined : sent.audio ? t("videos.withSound") : t("videos.silent"),
  ].filter((part): part is string => Boolean(part));
  return t("videos.sent", { summary: parts.join(" · ") });
}

/** What an image was made with, from the host's `sent`. */
export function imageSentNote(sent: ImageSent): string {
  const parts = [
    sent.shapeValue.replace("x", " × "),
    sent.tier,
    sent.quality ? t(`images.quality.option.${sent.quality}`) : undefined,
    sent.outputFormat?.toUpperCase(),
  ].filter((part): part is string => Boolean(part));
  return t("images.sent", { summary: parts.join(" · ") });
}

/** True when part of a spec is a vendor's API the gateway does not publish, so the page can say so. */
export function hasUnverified(spec: MediaParamSpec): boolean {
  return spec.unverified.length > 0;
}

/** The resolution tiers the cost estimate prices. A tier it does not know (`2k`) gets no resolution, so no guess. */
export function estimateResolution(value: string): "480p" | "720p" | "1080p" | "4k" | undefined {
  return value === "480p" || value === "720p" || value === "1080p" || value === "4k" ? value : undefined;
}
