import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  applyCuration,
  chooseDefaultModel,
  detectCompatibleApi,
  hasLiveProvider,
  isEmbeddingModelId,
  isServerMode,
  isMusicModelId,
  isSpeechModelId,
  mediaKind,
  mergeChatCatalog,
  probeAnthropicModels,
  probeGoogleModels,
  probeVolcengineModels,
  providerBaseUrl,
  redactSecrets,
  resolveModeDefaults,
  RELAY_ONLY_MUSIC_MODEL_IDS,
  resolveProviderKeys,
  resolvedGatewayBaseUrl,
  routeModelsByKind,
  sortChatModels,
  withContextLengths,
  type ChatModel,
  type CuratedModelMeta,
  type MediaModelCatalog,
  type ModeModelDefaults,
  type ModelProvider,
  type RoutedModels,
  type StoredSecrets,
} from "@agentforge/core";
import {
  loadModelCache,
  modelCacheOwner,
  modelCacheSlot,
  modelCacheStamp,
  saveModelCache,
  type ModelCache,
  type ModelCacheScope,
} from "./model-cache";
import { log } from "./log";
import { loadSettings } from "./settings-store";
import { loadModelsDevRegistry, modelsDevCacheStamp, refreshModelsDevRegistry } from "./models-dev-cache";

/** Catalog model with picker curation fields for API payloads. */
export type SelectableModel = ChatModel & CuratedModelMeta;

function liveModelIds(cache: ModelCache, kind?: "chat"): string[] {
  const ids = [
    ...(cache.openai ?? []),
    ...(cache.anthropic ?? []),
    ...(cache.google ?? []),
    ...(cache.volcengine ?? []),
  ].map((model) => model.id);
  if (kind === "chat") {
    return ids.filter((id) => mediaKind(id) === "chat");
  }
  return ids;
}

/**
 * One entry per slot: a desk has one (`modelCacheSlot` answers a constant, so this is the single memo it
 * always was), and on the hosted server each tenant has its own, so two tenants alternating never
 * rebuild each other's catalogue. Capped, oldest out, so a long-running server holds a bounded number.
 */
export const CATALOG_MEMO_CAP = 64;
const catalogMemo = new Map<string, { key: string; models: ChatModel[] }>();

/**
 * Merged catalog with context lengths. Building it costs ~230 ms of synchronous work (every model ×
 * the models.dev registry) and it was rebuilt on every Chat run and every knowledge lookup, which
 * serialised all requests. Memoized on the two cache files' mtime/size, so a probe or registry refresh
 * (both rewrite their file) invalidates it without any explicit hook.
 *
 * `scope` names the tenant whose cache is read; only the hosted server looks at it (`ModelCacheScope`).
 */
export function listCatalogModels(scope?: ModelCacheScope): ChatModel[] {
  const models = memoizedCatalog(scope);
  // After the read, so a per-tenant file that read adopted is not mistaken for a missing row. On a
  // desk this returns at its first line: the hosted warm-up is not part of Personal.
  warmHostedModelCache(scope);
  return models;
}

function memoizedCatalog(scope?: ModelCacheScope): ChatModel[] {
  const slot = modelCacheSlot(scope);
  const key = `${modelCacheStamp(scope)}|${modelsDevCacheStamp()}`;
  const hit = catalogMemo.get(slot);
  if (hit && hit.key === key) {
    // Read again, so it is the newest: the cap evicts the tenant used least recently, not the first built.
    catalogMemo.delete(slot);
    catalogMemo.set(slot, hit);
    return hit.models;
  }
  const cache = loadModelCache(scope);
  const models = withContextLengths(
    mergeChatCatalog({
      openai: cache.openai,
      anthropic: cache.anthropic,
      google: cache.google,
      volcengine: cache.volcengine,
    }),
    loadModelsDevRegistry(),
  );
  catalogMemo.delete(slot);
  catalogMemo.set(slot, { key, models });
  while (catalogMemo.size > CATALOG_MEMO_CAP) {
    const oldest = catalogMemo.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    catalogMemo.delete(oldest);
  }
  return models;
}

/** Test hook: drop the memoized catalog. */
export function resetCatalogMemo(): void {
  catalogMemo.clear();
}

export function listRoutedModels(models?: ChatModel[], scope?: ModelCacheScope): RoutedModels<ChatModel> {
  return routeModelsByKind(models ?? listCatalogModels(scope));
}

export function listSelectableModels(scope?: ModelCacheScope): SelectableModel[] {
  return applyCuration(listRoutedModels(undefined, scope).chat);
}

export function listImageModels(scope?: ModelCacheScope): ChatModel[] {
  return listRoutedModels(undefined, scope).image;
}

export function listVideoModels(scope?: ModelCacheScope): ChatModel[] {
  return listRoutedModels(undefined, scope).video;
}

/** Models the last refresh actually returned. No static catalog fill-in. */
export function listProbedModels(cache?: ModelCache, scope?: ModelCacheScope): ChatModel[] {
  const current = cache ?? loadModelCache(scope);
  if (!cache) {
    warmHostedModelCache(scope);
  }
  return [
    ...(current.openai ?? []),
    ...(current.anthropic ?? []),
    ...(current.google ?? []),
    ...(current.volcengine ?? []),
  ];
}

export function listProbedVideoModels(cache?: ModelCache, scope?: ModelCacheScope): ChatModel[] {
  return listProbedModels(cache, scope).filter((model) => mediaKind(model.id) === "video");
}

export function toolMediaModels(scope?: ModelCacheScope): MediaModelCatalog {
  return {
    image: listImageModels(scope).flatMap((model) => (mediaKind(model.id) === "image" ? [model.id] : [])),
    video: listProbedVideoModels(undefined, scope).map((model) => model.id),
  };
}

/**
 * The audio catalog, split by what each id can actually do. `routeModelsByKind` lumps music, lyrics,
 * TTS and ASR into one `audio` bucket, which is the right shape for the picker but the wrong shape
 * for a studio: a song request sent to a transcriber bills the desk and returns nothing.
 */
export function listAudioModels(scope?: ModelCacheScope): ChatModel[] {
  return listRoutedModels(undefined, scope).audio;
}

/** A picker row for an id the live catalog does not carry. Minimal on purpose: no price, no hints. */
function relayModelRow(id: string): ChatModel {
  return { id, label: id, provider: "openai", inputModalities: ["text"] };
}

/**
 * The catalog's music models plus the relay-only ones the gateway never lists.
 *
 * `GET /v1/models` on this gateway returns the OpenAI-shaped models only, so `suno_music` — a task
 * model reached at `POST {origin}/suno/submit/music` — is absent from it even on a key that can use
 * it. Filtering the live catalog alone therefore produced an empty Music picker on a working desk.
 *
 * The catalog wins every collision: if the gateway does list the id, its own row (with its price and
 * curation) is kept and nothing is appended, whatever the case of the spelling. The input list is
 * never mutated, and the same list comes back untouched when there is nothing to add.
 */
export function withRelayMusicModels(
  models: readonly ChatModel[],
  extraIds: readonly string[] = RELAY_ONLY_MUSIC_MODEL_IDS,
): ChatModel[] {
  const seen = new Set(models.map((model) => model.id.trim().toLowerCase()));
  const added: ChatModel[] = [];
  for (const raw of extraIds) {
    const id = raw.trim();
    const key = id.toLowerCase();
    if (!id || seen.has(key)) {
      continue;
    }
    seen.add(key);
    added.push(relayModelRow(id));
  }
  return added.length === 0 ? [...models] : [...models, ...added];
}

export function listMusicModels(scope?: ModelCacheScope): ChatModel[] {
  return withRelayMusicModels(listAudioModels(scope).filter((model) => isMusicModelId(model.id)));
}

/** Non-realtime text-to-speech only; empty on this gateway today. */
export function listSpeechModels(scope?: ModelCacheScope): ChatModel[] {
  return listAudioModels(scope).filter((model) => isSpeechModelId(model.id));
}

/** Embedding ids are never curated — PICKER_HIDE strips them from chat. */
export function listEmbeddingModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  const embeddings = (models ?? listCatalogModels(scope)).filter((model) => isEmbeddingModelId(model.id));
  if (embeddings.length > 0) {
    return embeddings;
  }
  return [
    {
      id: DEFAULT_EMBEDDING_MODEL,
      label: DEFAULT_EMBEDDING_MODEL,
      provider: "openai",
      inputModalities: ["text"],
    },
  ];
}

export function defaultSelectableModel(models?: Array<{ id: string }>, scope?: ModelCacheScope): string {
  const chosen = chooseDefaultModel(
    models ?? listSelectableModels(scope),
    liveModelIds(loadModelCache(scope), "chat"),
    DEFAULT_CHAT_MODEL,
  );
  warmHostedModelCache(scope);
  return chosen;
}

function curateRouted(routed: RoutedModels<ChatModel>): RoutedModels<SelectableModel> {
  return {
    chat: applyCuration(sortChatModels(routed.chat)),
    image: applyCuration(routed.image),
    video: applyCuration(routed.video),
    audio: applyCuration(routed.audio),
    other: applyCuration(routed.other),
  };
}

/**
 * The catalogue, once per distinct list. `modes.chat` is the chat catalogue, and every mode in
 * `CHAT_CATALOG_MODES` (documents, research, presentations, finance, data, market, legal, meeting)
 * offers exactly that list, so none of them gets a copy here: the renderer resolves them through
 * `modelsForMode` (`@agentforge/core/mode-catalog`). Eight identical copies of 126 rows were 232 KB
 * of every `GET /api/v1/models` and `GET /api/v1/settings` answer.
 */
export type ModeCatalogModes = RoutedModels<SelectableModel> & {
  music: SelectableModel[];
  embedding: ChatModel[];
};

export function modeCatalogPayload(
  models?: ChatModel[],
  scope?: ModelCacheScope,
): {
  modes: ModeCatalogModes;
  defaults: ModeModelDefaults;
} {
  const all = models ?? listCatalogModels(scope);
  const routed = routeModelsByKind(all);
  const curated = curateRouted(routed);
  const embedding = listEmbeddingModels(all, scope);
  const chatDefault = defaultSelectableModel(curated.chat, scope);
  // The relay music model is merged here too, so `/api/v1/models` cannot report a music mode whose
  // list is missing the very id `defaults.music` names.
  const music = applyCuration(withRelayMusicModels(curated.audio.filter((model) => isMusicModelId(model.id))));
  return {
    modes: {
      ...curated,
      music,
      embedding,
    },
    defaults: resolveModeDefaults({
      chatIds: curated.chat.map((model) => model.id),
      imageIds: curated.image.map((model) => model.id),
      videoIds: curated.video.map((model) => model.id),
      musicIds: music.map((model) => model.id),
      embeddingIds: embedding.map((model) => model.id),
      chatDefault,
    }),
  };
}

/** What `GET` and `POST /api/v1/models` answer with, before `probe` is added on a refresh. */
export type ModelCatalogBody = {
  /** The chat catalogue, once. Chat and every mode in `CHAT_CATALOG_MODES` pick from it. */
  models: SelectableModel[];
  defaultModel: string;
  /** Only the lists that are not the chat catalogue: image, video, audio, other, music, embedding. */
  modes: Omit<ModeCatalogModes, "chat">;
  defaults: ModeModelDefaults;
};

/**
 * The catalogue as it goes on the wire: each list once. `modes.chat` is the same rows as `models`, so
 * it is left off; see `ModeCatalogModes`. A caller that wants a mode's models reads them through
 * `modelsForMode` in `@agentforge/core/mode-catalog`, which knows which modes are the chat catalogue.
 */
export function modelCatalogBody(scope?: ModelCacheScope): ModelCatalogBody {
  const models = listSelectableModels(scope);
  const { modes, defaults } = modeCatalogPayload(undefined, scope);
  const { chat: _chat, ...ownLists } = modes;
  return { models, defaultModel: defaultSelectableModel(models, scope), modes: ownLists, defaults };
}

/**
 * Just the per-mode default model ids, which is all most job runners want from the catalogue. They name
 * the tenant whose cache the ids are chosen from; a desk ignores it.
 */
export function modeDefaultsFor(scope?: ModelCacheScope): ModeModelDefaults {
  return modeCatalogPayload(undefined, scope).defaults;
}

function putModels(next: ModelCache, dialect: ModelProvider, models: ChatModel[], now: string): void {
  next[dialect] = models;
  if (dialect === "openai") {
    next.openaiProbedAt = now;
    delete next.openaiError;
  }
  if (dialect === "anthropic") {
    next.anthropicProbedAt = now;
    delete next.anthropicError;
  }
  if (dialect === "google") {
    next.googleProbedAt = now;
    delete next.googleError;
  }
  if (dialect === "volcengine") {
    next.volcengineProbedAt = now;
    delete next.volcengineError;
  }
}

export type RefreshModelCacheOptions = {
  /** Re-download the models.dev registry even if the weekly cache is fresh (user pressed Refresh). */
  forceRegistry?: boolean;
  /** Whose cache is read and rewritten. Only the hosted server looks at it (`ModelCacheScope`). */
  scope?: ModelCacheScope;
  /**
   * Write the result only if nothing has written this cache since the call started. For a refresh
   * nobody asked for (`warmHostedModelCache`): a Settings save or the Refresh button that lands while
   * its probe is out wrote a newer answer, and an older one must not replace it. The check and the
   * write have no `await` between them, so inside one process nothing can land in the gap.
   */
  onlyIfMissing?: boolean;
};

/**
 * A base URL other than the pinned gateway. Since the endpoint is pinned this is now always false;
 * it stays as the one place that would have to change if a second endpoint were ever allowed.
 */
function hasCustomGateway(settings: StoredSecrets): boolean {
  const base = resolveProviderKeys(settings).openaiBaseUrl?.trim();
  return Boolean(base) && base !== resolvedGatewayBaseUrl();
}

export async function refreshModelCache(
  settings: StoredSecrets,
  options: RefreshModelCacheOptions = {},
): Promise<ModelCache> {
  const scope = options.scope;
  // On the hosted server a provider's host is the registry's, never the stored settings': a key goes to
  // the provider it belongs to, and a stored base URL with no key behind it probes nothing.
  const hosted = isServerMode();
  const current = loadModelCache(scope);
  const next: ModelCache = { ...current };
  const now = new Date().toISOString();
  const registryPromise = refreshModelsDevRegistry(fetch, { force: options.forceRegistry === true });

  // Stub desks (no key, default gateway) never call out: there is nothing to list.
  if (settings.openaiApiKey || hasCustomGateway(settings)) {
    try {
      const detected = await detectCompatibleApi({
        url: resolveProviderKeys(settings).openaiBaseUrl || DEFAULT_OPENAI_BASE_URL,
        apiKey: settings.openaiApiKey,
      });
      putModels(next, detected.dialect, detected.models, now);
      next.detectedDialect = detected.dialect;
    } catch (error) {
      next.openaiError = redactSecrets(
        error instanceof Error ? error.message : "Could not list models from the gateway",
      );
    }
  } else {
    // Key cleared: a stale "unreachable" banner from the last live save must not survive into stub.
    delete next.openaiError;
    delete next.detectedDialect;
  }

  if (settings.anthropicApiKey || (!hosted && settings.anthropicBaseUrl)) {
    try {
      putModels(
        next,
        "anthropic",
        await probeAnthropicModels({
          baseURL: hosted ? providerBaseUrl("anthropic") : settings.anthropicBaseUrl,
          apiKey: settings.anthropicApiKey,
        }),
        now,
      );
    } catch (error) {
      next.anthropicError = redactSecrets(error instanceof Error ? error.message : "Could not list Anthropic models");
    }
  }

  if (settings.googleApiKey) {
    try {
      putModels(
        next,
        "google",
        await probeGoogleModels({
          baseURL: hosted ? providerBaseUrl("google") : settings.googleBaseUrl,
          apiKey: settings.googleApiKey,
        }),
        now,
      );
    } catch (error) {
      next.googleError = redactSecrets(error instanceof Error ? error.message : "Could not list Gemini models");
    }
  }

  if (settings.volcengineApiKey || (!hosted && settings.volcengineBaseUrl)) {
    try {
      putModels(
        next,
        "volcengine",
        await probeVolcengineModels({
          // Not a registry provider: on the hosted server the probe uses its own pinned Ark default.
          baseURL: hosted ? undefined : settings.volcengineBaseUrl,
          apiKey: settings.volcengineApiKey,
        }),
        now,
      );
    } catch (error) {
      next.volcengineError = redactSecrets(error instanceof Error ? error.message : "Could not list Volcengine models");
    }
  }

  const registry = await registryPromise;
  for (const dialect of ["openai", "anthropic", "google", "volcengine"] as const) {
    if (next[dialect]) {
      next[dialect] = withContextLengths(next[dialect], registry);
    }
  }

  if (options.onlyIfMissing && modelCacheStamp(scope) !== "missing") {
    return loadModelCache(scope);
  }
  return saveModelCache(next, scope);
}

// ---------------------------------------------------------------------------- hosted cache warm-up
//
// A hosted tenant's cache is a `tenant_state` row that only a Settings save and the Refresh button
// write. A tenant that already held a key when the server upgraded into per-tenant caches has no row,
// so every catalogue read answered the static ids (Images: none, Meeting: `no_model`) until somebody
// saved Settings again.

/** At most one warm-up per tenant per this window, per process. Same ten minutes as the gateway re-check. */
export const HOSTED_CACHE_WARMUP_THROTTLE_MS = 600_000;

/** When each tenant's last warm-up started, and which are running now. In this process only. */
const warmupStartedAt = new Map<string, number>();
const warmupInFlight = new Set<string>();

/** Test seam: forget every warm-up so the next read may start one. */
export function resetHostedModelCacheWarmups(): void {
  warmupStartedAt.clear();
  warmupInFlight.clear();
}

export type HostedWarmupDeps = {
  /** Injected in tests: the refresh that is started and forgotten. */
  refresh?: (settings: StoredSecrets, options: RefreshModelCacheOptions) => Promise<unknown>;
  nowMs?: () => number;
  throttleMs?: number;
};

/**
 * Hosted only. On a catalogue read for a tenant that has no `model_cache` row and a saved provider
 * key, start ONE background `refreshModelCache` for that tenant and return true. It is never awaited:
 * the read that started it answers with what it has, and the next read after the probe lands is live.
 *
 * - **Per company (SR-163).** The probe is named by partner and company, so its result lands in that
 *   company's row whichever request is in scope when it finishes, and a company with no key starts
 *   nothing. Two companies of one partner each get their own probe, throttle and in-flight slot. A scope
 *   that cannot name its company starts nothing (the refusal is logged, never thrown).
 * - **Throttled and deduplicated.** One at a time per company, and not again inside
 *   `HOSTED_CACHE_WARMUP_THROTTLE_MS` of the last start. A probe that finishes writes a row, which
 *   ends the matter; the throttle is for one that could not write (a locked database, a full disk).
 *   A read that found no key starts nothing and spends nothing, so a key that arrives by a path that
 *   did not refresh the cache is still picked up on the next read.
 * - **Write-if-absent.** A Settings save or the Refresh button that lands while the probe is out
 *   wrote a newer answer (for a newer key, perhaps); this one does not replace it.
 * - **Never the read's problem.** An unreadable settings file, a failed probe or a refresh that throws
 *   is one `model_cache_warmup_failed` line (tenant id and the redacted message; no key) and nothing
 *   else. The desk and webdev return at the first line, so Personal behaves exactly as it did.
 *
 * Which desk's key: the one the caller's tenant context names when it has one (every handler passes
 * its `TenantContext`), else the desk the request selected. The cache itself is per company.
 */
export function warmHostedModelCache(scope?: ModelCacheScope, deps: HostedWarmupDeps = {}): boolean {
  if (!isServerMode()) {
    return false;
  }
  let tenantId = "unknown";
  try {
    // SR-163: the cache, the throttle and the in-flight set are the company's, not the partner's. A scope
    // that cannot name its company throws here and is logged below: the warm-up starts nothing for it.
    const owner = modelCacheOwner(scope);
    tenantId = owner.tenantId;
    const slot = modelCacheSlot(scope);
    if (modelCacheStamp(scope) !== "missing" || warmupInFlight.has(slot)) {
      return false;
    }
    const nowMs = (deps.nowMs ?? Date.now)();
    const last = warmupStartedAt.get(slot);
    if (last !== undefined && nowMs - last < (deps.throttleMs ?? HOSTED_CACHE_WARMUP_THROTTLE_MS)) {
      return false;
    }
    const settings = loadSettings({ tenantId, workspaceId: workspaceIdOf(scope) });
    if (!hasLiveProvider(settings)) {
      return false;
    }
    warmupStartedAt.set(slot, nowMs);
    warmupInFlight.add(slot);
    const refresh = deps.refresh ?? refreshModelCache;
    const named = { tenantId: owner.tenantId, organizationId: owner.companyId };
    void (async () => {
      try {
        const result = await refresh(settings, { scope: named, onlyIfMissing: true });
        const failure = probeFailureOf(result);
        if (failure) {
          logWarmupFailure(named.tenantId, failure);
        }
      } catch (error) {
        logWarmupFailure(named.tenantId, error);
      } finally {
        warmupInFlight.delete(slot);
      }
    })();
    return true;
  } catch (error) {
    logWarmupFailure(tenantId, error);
    return false;
  }
}

/** The desk a tenant context names, or "" for none (`resolveSettingsWorkspaceId` then picks the selected one). */
function workspaceIdOf(scope: ModelCacheScope): string {
  const workspaceId = typeof scope === "object" && scope !== null ? (scope as { workspaceId?: unknown }).workspaceId : "";
  return typeof workspaceId === "string" ? workspaceId : "";
}

/**
 * `refreshModelCache` does not throw for a provider that would not answer: it records the error in the
 * cache it returns. A refresh that came back with an error and not one model is a warm-up that got
 * nothing, and the operator should be able to see that in the server log.
 */
function probeFailureOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const cache = result as ModelCache;
  const listed = [cache.openai, cache.anthropic, cache.google, cache.volcengine].some(
    (models) => Array.isArray(models) && models.length > 0,
  );
  if (listed) {
    return null;
  }
  return cache.openaiError ?? cache.anthropicError ?? cache.googleError ?? cache.volcengineError ?? null;
}

function logWarmupFailure(tenantId: string, error: unknown): void {
  // `detail` only: the logger drops any field whose name holds a credential word, and the message is
  // redacted twice (here and in the logger) because a probe error can quote the key it was sent.
  log.warn("model_cache_warmup_failed", {
    tenantId,
    detail: redactSecrets(error instanceof Error ? error.message : String(error)),
  });
}
