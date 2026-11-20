/**
 * The media parameter spec of each image and video model, for the studios and the generation tools.
 *
 * The built-in table and the rules are in `@agentforge/core` (`models/media-params*.ts`). This file adds
 * the one thing core cannot hold: what the gateway published for a model in its price list
 * (`config.parameters`), which `refreshModelCache` keeps in the model cache beside the model list. A
 * published enum or default is laid over the table, so a model the table has never heard of works with
 * no code change.
 *
 * Nothing here starts a call. A cache with no published parameters (a stub desk, an unreachable
 * gateway) answers with the table alone.
 */

import {
  imageSpecFor,
  setPublishedMediaParamsSource,
  videoSpecFor,
  type ImageParamSpec,
  type MediaParamSpec,
  type PublishedMediaParams,
  type VideoParamSpec,
} from "@agentforge/core";
import { loadModelCache, type ModelCacheScope } from "./model-cache";

/** What the gateway published for `model` in this desk's (or company's) cached price list. */
export function publishedMediaParams(model: string, scope?: ModelCacheScope): PublishedMediaParams | undefined {
  try {
    return loadModelCache(scope).mediaParams?.[model.trim().toLowerCase()];
  } catch {
    return undefined;
  }
}

export function videoSpecForScope(model: string, scope?: ModelCacheScope): VideoParamSpec {
  return videoSpecFor(model, publishedMediaParams(model, scope));
}

export function imageSpecForScope(model: string, scope?: ModelCacheScope): ImageParamSpec {
  return imageSpecFor(model, publishedMediaParams(model, scope));
}

/**
 * Every model of a studio list with its spec attached as `media`, reading the cache once. The page shows
 * only the controls a model has, with only the values it takes.
 */
export function attachMediaSpecs<T extends { id: string }>(
  models: readonly T[],
  kind: "image" | "video",
  scope?: ModelCacheScope,
): Array<T & { media: MediaParamSpec }> {
  let published: Readonly<Record<string, PublishedMediaParams>> | undefined;
  try {
    published = loadModelCache(scope).mediaParams;
  } catch {
    published = undefined;
  }
  return models.map((model) => {
    const params = published?.[model.id.trim().toLowerCase()];
    return { ...model, media: kind === "video" ? videoSpecFor(model.id, params) : imageSpecFor(model.id, params) };
  });
}

/** Installed once at boot: the generation tools ask here what the gateway published for a model. */
export function installPublishedMediaParamsSource(): void {
  setPublishedMediaParamsSource((model, tenant) => publishedMediaParams(model, tenant ?? undefined));
}

installPublishedMediaParamsSource();
