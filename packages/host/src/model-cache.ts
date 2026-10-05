import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { localDataDir } from "@agentforge/db/vault-key";
import { ApiError, isServerMode, mediaKind, type ChatModel, type ModelProvider } from "@agentforge/core";
import { assertTenantId } from "./tenant-paths";
import { currentRequestSession } from "./tenant-scope";
import { dbTenantStateBackend } from "./tenant-state-store";

export type ModelCache = {
  openai?: ChatModel[];
  anthropic?: ChatModel[];
  google?: ChatModel[];
  volcengine?: ChatModel[];
  openaiProbedAt?: string;
  anthropicProbedAt?: string;
  googleProbedAt?: string;
  volcengineProbedAt?: string;
  openaiError?: string;
  anthropicError?: string;
  googleError?: string;
  volcengineError?: string;
  detectedDialect?: ModelProvider;
};

/**
 * Whose cache a call is about. Only the hosted server reads it: there each tenant has its own cache,
 * a `tenant_state` row (key `model_cache`), because a catalogue probed with one tenant's provider key
 * must never reach another tenant (Enterprise BYOK, Phase A). A desktop or webdev desk has one cache,
 * one file, and ignores the scope entirely, so every Personal call behaves as it always did.
 *
 * A caller that has the tenant passes it (`handlers`, the job runners). A caller that does not is
 * read from the request in scope (`tenant-scope.ts`), which is weaker than the settings store's rule
 * (`resolveSettingsScope` has no such fallback): work detached from a request inherits the tenant that
 * started it. One with neither is refused rather than guessed.
 */
export type ModelCacheScope = Readonly<{ tenantId: string }> | null | undefined;

/**
 * A settings scope as a cache scope. A tenant object names itself; a bare desk id or nothing names no
 * tenant, which is right on a desk (one cache) and is refused on the hosted server.
 */
export function modelCacheScopeOf(scope: Readonly<{ tenantId: string }> | string | null | undefined): ModelCacheScope {
  return typeof scope === "object" && scope !== null ? scope : undefined;
}

/** Which `tenant_state` payload holds a tenant's cache. See `tenant-state-store.ts`. */
const MODEL_CACHE_KEY = "model_cache" as const;

function hostedTenantId(scope: ModelCacheScope): string {
  const tenantId = scope?.tenantId ?? currentRequestSession()?.tenantId;
  if (!tenantId) {
    throw new ApiError(
      "tenant_required",
      "This request reached the model cache without a tenant. Hosted requests must name the tenant, never share one cache.",
      500,
    );
  }
  return assertTenantId(tenantId);
}

/**
 * What a derived value built from the cache (the memoized catalogue) is keyed by: the tenant on the
 * hosted server, one constant on a desk. Throws on the hosted server when no tenant is named.
 */
export function modelCacheSlot(scope?: ModelCacheScope): string {
  return isServerMode() ? hostedTenantId(scope) : "desk";
}

function cachePath(): string {
  if (process.env.AGENTFORGE_MODELS_CACHE_PATH) {
    return process.env.AGENTFORGE_MODELS_CACHE_PATH;
  }
  // One source of truth for where this desk keeps its files: `localDataDir()` also honours
  // AGENTFORGE_SETTINGS_PATH, which reading AGENTFORGE_DATA_DIR by hand did not — so a desk with a
  // custom settings path wrote its caches somewhere the "Start over" wipe list never looked.
  return resolve(localDataDir(), "models-cache.json");
}

function asModels(value: unknown): ChatModel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const models = value.filter((item): item is ChatModel => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const model = item as ChatModel;
    if (typeof model.id !== "string" || typeof model.label !== "string" || !Array.isArray(model.inputModalities)) {
      return false;
    }
    if (model.contextLength !== undefined && (typeof model.contextLength !== "number" || model.contextLength < 1024)) {
      delete (model as { contextLength?: number }).contextLength;
      delete (model as { contextSource?: string }).contextSource;
    }
    return true;
  });
  return models.length > 0 ? models : undefined;
}

/** The stored text as a cache. Throws on text that is not JSON; callers answer an empty cache for that. */
function parseModelCache(text: string): ModelCache {
  const parsed = JSON.parse(text) as ModelCache;
  return {
    openai: asModels(parsed.openai),
    anthropic: asModels(parsed.anthropic),
    google: asModels(parsed.google),
    volcengine: asModels(parsed.volcengine),
    openaiProbedAt: typeof parsed.openaiProbedAt === "string" ? parsed.openaiProbedAt : undefined,
    anthropicProbedAt: typeof parsed.anthropicProbedAt === "string" ? parsed.anthropicProbedAt : undefined,
    googleProbedAt: typeof parsed.googleProbedAt === "string" ? parsed.googleProbedAt : undefined,
    volcengineProbedAt: typeof parsed.volcengineProbedAt === "string" ? parsed.volcengineProbedAt : undefined,
    openaiError: typeof parsed.openaiError === "string" ? parsed.openaiError : undefined,
    anthropicError: typeof parsed.anthropicError === "string" ? parsed.anthropicError : undefined,
    googleError: typeof parsed.googleError === "string" ? parsed.googleError : undefined,
    volcengineError: typeof parsed.volcengineError === "string" ? parsed.volcengineError : undefined,
    detectedDialect: parsed.detectedDialect,
  };
}

/** Cheap change key for memoizing derived catalogs: the cache's mtime + size (a desk) or row stamp (a tenant), or "missing". */
export function modelCacheStamp(scope?: ModelCacheScope): string {
  if (isServerMode()) {
    return dbTenantStateBackend.stamp(hostedTenantId(scope), MODEL_CACHE_KEY) ?? "missing";
  }
  try {
    const stat = statSync(cachePath());
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function loadModelCache(scope?: ModelCacheScope): ModelCache {
  if (isServerMode()) {
    const entry = dbTenantStateBackend.read(hostedTenantId(scope), MODEL_CACHE_KEY);
    if (!entry) {
      return {};
    }
    try {
      return parseModelCache(entry.value);
    } catch {
      return {};
    }
  }
  try {
    return parseModelCache(readFileSync(cachePath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveModelCache(cache: ModelCache, scope?: ModelCacheScope): ModelCache {
  if (isServerMode()) {
    dbTenantStateBackend.write(hostedTenantId(scope), MODEL_CACHE_KEY, JSON.stringify(cache));
    return cache;
  }
  const file = cachePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache;
}

export function probeSummary(cache?: ModelCache, scope?: ModelCacheScope) {
  const current = cache ?? loadModelCache(scope);
  const models = [
    ...(current.openai ?? []),
    ...(current.anthropic ?? []),
    ...(current.google ?? []),
    ...(current.volcengine ?? []),
  ];
  const routed = { chat: 0, image: 0, video: 0, audio: 0, other: 0 };
  for (const model of models) {
    routed[mediaKind(model.id)] += 1;
  }
  return {
    openaiCount: current.openai?.length ?? 0,
    anthropicCount: current.anthropic?.length ?? 0,
    googleCount: current.google?.length ?? 0,
    volcengineCount: current.volcengine?.length ?? 0,
    totalCount: models.length,
    chatCount: routed.chat,
    imageCount: routed.image,
    videoCount: routed.video,
    audioCount: routed.audio,
    openaiError: current.openaiError,
    anthropicError: current.anthropicError,
    googleError: current.googleError,
    volcengineError: current.volcengineError,
    detectedDialect: current.detectedDialect,
  };
}
