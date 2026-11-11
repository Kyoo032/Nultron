/**
 * What a key can actually use: reads the lessons and applies them to the pickers, and learns new
 * ones from the real calls the generation tools report.
 *
 * The data and the pure rules are in `@agentforge/core` (`models/availability.ts`,
 * `models/gateway-catalog.ts`); the lessons live inside the model cache (`model-cache.ts`), filed
 * under the key's salted id, so a desk that held two keys keeps their refusals apart and the key
 * itself is never written.
 *
 * Three rules this file holds:
 *
 * - **Nothing here starts a call.** A lesson comes from a refusal or a success of a call the person
 *   asked for. The free reads (the key's `GET /v1/models`, the gateway's public price list) are made
 *   by `refreshModelCache`. A paid generation is never run to find out.
 * - **A lesson is short-lived and per key** (`STATUS_TTL_MS`); a new key starts with none, and the
 *   Refresh button forgets the current key's.
 * - **It never breaks a call.** Learning is a by-product; every failure here is logged and dropped.
 */

import {
  availabilityKeyId,
  buildCatalog,
  classifyGatewayRefusal,
  computeAvailability,
  effectiveRecordStatus,
  emptyAvailabilityStore,
  isOfferedStatus,
  modelKey,
  newAvailabilitySalt,
  refusalOfError,
  resolveProviderKeys,
  setModelOutcomeSink,
  unavailableModels,
  withAvailabilityOutcome,
  withoutAvailabilityLessons,
  availabilityRecordsFor,
  type AvailabilityRecord,
  type CatalogEntry,
  type ChatModel,
  type ModelAvailability,
  type ModelKind,
  type ModelOutcomeReport,
} from "@agentforge/core";
import { log } from "./log";
import {
  loadModelCache,
  modelCacheScopeOf,
  modelCacheStamp,
  saveModelCache,
  type ModelCache,
  type ModelCacheScope,
} from "./model-cache";
import { loadSettings } from "./settings-store";
// Side effect: installs the source the generation tools read for what the gateway published per model.
import "./media-spec";

function listedIds(cache: ModelCache): string[] {
  return [
    ...(cache.openai ?? []),
    ...(cache.anthropic ?? []),
    ...(cache.google ?? []),
    ...(cache.volcengine ?? []),
  ].map((model) => model.id);
}

/** Every model the gateway offers, as this cache knows it: the key's list, the price list, the seed. */
export function catalogOfCache(cache: ModelCache): CatalogEntry[] {
  return buildCatalog({ listedIds: listedIds(cache), hints: cache.endpointHints });
}

/** Each model's standing on the key this cache was read with. Pure over the cache and the clock. */
export function standingsOfCache(cache: ModelCache, nowMs: number = Date.now()): ModelAvailability[] {
  const records = availabilityRecordsFor(cache.availability, cache.keyId ?? null);
  return computeAvailability({ catalog: catalogOfCache(cache), records, nowMs });
}

// ------------------------------------------------------------------------------------------ reads

/**
 * The ids a picker must not offer: listed by the key, and a call said they do not work. Memoized on
 * the cache's stamp and the minute, because a lesson expires on the clock without anything being
 * written, and every picker list asks.
 */
const refusedMemo = new Map<string, { key: string; ids: ReadonlySet<string> }>();

export function refusedModelIds(scope?: ModelCacheScope): ReadonlySet<string> {
  const slot = scopeKey(scope);
  const key = `${modelCacheStamp(scope)}|${Math.floor(Date.now() / 60_000)}`;
  const held = refusedMemo.get(slot);
  if (held && held.key === key) {
    return held.ids;
  }
  const cache = loadModelCache(scope);
  const nowMs = Date.now();
  const ids = new Set<string>();
  for (const [id, record] of Object.entries(availabilityRecordsFor(cache.availability, cache.keyId ?? null))) {
    const status = effectiveRecordStatus(record, nowMs);
    if (!isOfferedStatus(status)) {
      ids.add(id);
    }
  }
  refusedMemo.delete(slot);
  refusedMemo.set(slot, { key, ids });
  while (refusedMemo.size > 64) {
    const oldest = refusedMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    refusedMemo.delete(oldest);
  }
  return ids;
}

function scopeKey(scope?: ModelCacheScope): string {
  return scope ? `${scope.tenantId}|${scope.organizationId ?? ""}` : "desk";
}

/** Drop the models a call has said do not work on this key. Everything else, including `unknown`, stays. */
export function dropRefusedModels<T extends { id: string }>(models: T[], scope?: ModelCacheScope): T[] {
  const refused = refusedModelIds(scope);
  if (refused.size === 0) {
    return models;
  }
  return models.filter((model) => !refused.has(modelKey(model.id)));
}

/** The ids of `ids` that are still offered. For callers that hold ids and not models (transcription). */
export function dropRefusedIds(ids: string[], scope?: ModelCacheScope): string[] {
  const refused = refusedModelIds(scope);
  return refused.size === 0 ? ids : ids.filter((id) => !refused.has(modelKey(id)));
}

// ----------------------------------------------------------------------------------- the payload

export type KindSummary = { offered: number };

/** What Settings and the studios read: the models this key cannot use, and how many each kind has left. */
export type ModelAvailabilityPayload = {
  /** Models the key cannot use, with why. Chat models appear only once a call said so. */
  unavailable: Array<{
    id: string;
    kind: ModelKind;
    status: ModelAvailability["status"];
    reason: string;
    checkedAt: string | null;
  }>;
  /** How many models of each kind a picker offers now; filled by `modelAvailabilityBody`. */
  kinds: Record<string, KindSummary>;
};

export function availabilityPayload(scope?: ModelCacheScope): ModelAvailabilityPayload {
  const cache = loadModelCache(scope);
  const standings = standingsOfCache(cache);
  const unavailable = unavailableModels(standings).map((standing) => ({
    id: standing.id,
    kind: standing.kind,
    status: standing.status,
    reason: standing.reason,
    checkedAt: standing.checkedAt,
  }));
  return { unavailable, kinds: {} };
}

// ---------------------------------------------------------------------------------------- writes

const MIN_SUCCESS_REWRITE_MS = 60 * 60_000;

function keyOfScope(scope: ModelCacheScope, settingsScope: Parameters<typeof loadSettings>[0]): string | undefined {
  void scope;
  return resolveProviderKeys(loadSettings(settingsScope)).openai;
}

/**
 * Remember what one real call came to. A refusal the classifier reads becomes a lesson; a success
 * clears an earlier lesson. Anything else (a bad key, a rate limit, a timeout) teaches nothing.
 */
export function learnFromOutcome(report: ModelOutcomeReport, nowMs: number = Date.now()): boolean {
  const settingsScope = report.tenant;
  if (!settingsScope) {
    return false;
  }
  const scope = modelCacheScopeOf(settingsScope);
  const apiKey = keyOfScope(scope, settingsScope);
  if (!apiKey) {
    return false;
  }
  let outcome: { status: AvailabilityRecord["status"]; reason: string } | null;
  if (report.ok) {
    outcome = { status: "available", reason: "" };
  } else {
    const refusal = refusalOfError(report.error);
    const learned = refusal ? classifyGatewayRefusal(refusal) : null;
    outcome = learned ? { status: learned.status, reason: learned.reason } : null;
  }
  if (!outcome) {
    return false;
  }
  const cache = loadModelCache(scope);
  const store = cache.availability ?? emptyAvailabilityStore(newAvailabilitySalt());
  const keyId = availabilityKeyId(apiKey, store.salt);
  if (!keyId) {
    return false;
  }
  const held = availabilityRecordsFor(store, keyId)[modelKey(report.model)];
  if (
    held &&
    held.status === outcome.status &&
    held.reason === outcome.reason &&
    nowMs - Date.parse(held.checkedAt) < (outcome.status === "available" ? MIN_SUCCESS_REWRITE_MS : 60_000)
  ) {
    // Nothing new: a success every few seconds must not rewrite the cache and rebuild the catalogue.
    return false;
  }
  saveModelCache(
    {
      ...cache,
      availability: withAvailabilityOutcome(store, keyId, report.model, outcome, nowMs),
      keyId: cache.keyId ?? keyId,
    },
    scope,
  );
  return true;
}

/** The Refresh button: forget what was learned for the key now in use. The list itself is re-read by the caller. */
export function forgetLessons(cache: ModelCache): ModelCache {
  if (!cache.availability || !cache.keyId) {
    return cache;
  }
  return { ...cache, availability: withoutAvailabilityLessons(cache.availability, cache.keyId) };
}

/**
 * The cache with the key id and salt of the key that is in use now, so lessons are filed under it.
 * A different key gets a different id, so what was learned for the old key is simply not read.
 */
export function withKeyId(cache: ModelCache, apiKey: string | undefined): ModelCache {
  const store = cache.availability ?? emptyAvailabilityStore(newAvailabilitySalt());
  const keyId = availabilityKeyId(apiKey, store.salt);
  if (!keyId) {
    const { keyId: _dropped, ...rest } = cache;
    return { ...rest, availability: store };
  }
  return { ...cache, availability: store, keyId };
}

/** Installed once at boot (`router.ts`): the generation tools report here. */
export function installModelOutcomeSink(): void {
  setModelOutcomeSink((report) => {
    try {
      learnFromOutcome(report);
    } catch (error) {
      log.warn("model_availability_learn_failed", {
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  });
}

installModelOutcomeSink();

/** Test hook. */
export function resetAvailabilityMemo(): void {
  refusedMemo.clear();
}

export type { ChatModel };
