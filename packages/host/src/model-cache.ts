import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { localDataDir } from "@agentforge/db/vault-key";
import {
  ApiError,
  isServerMode,
  mediaKind,
  parseAvailabilityStore,
  sanitizePublishedMediaParams,
  type AvailabilityStore,
  type ChatModel,
  type ModelProvider,
  type PricingHints,
  type PublishedMediaMap,
} from "@agentforge/core";
import { assertTenantId } from "./tenant-paths";
import { currentRequestSession } from "./tenant-scope";
import { companyStateKey, dbTenantStateBackend, type TenantStateSlot } from "./tenant-state-store";

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
  /**
   * What real calls taught about each key's models (`@agentforge/core` `availability.ts`). Filed under
   * the key's salted id, never the key. Kept with the model list because both describe the same key and
   * both are cleared by the same "Start over".
   */
  availability?: AvailabilityStore;
  /** The id (under `availability.salt`) of the key whose model list this cache holds. */
  keyId?: string;
  /** The gateway's public price list, reduced to `model id -> endpoint types`, so a new id is placed by what the gateway says it is. */
  endpointHints?: PricingHints;
  endpointHintsAt?: string;
  /**
   * What the same price list publishes for each media model (`config.parameters`: resolution enums,
   * defaults). Laid over the built-in media parameter table, so a model the table has never heard of, or a
   * changed enum, works with no code change (`@agentforge/core` `media-params.ts`).
   */
  mediaParams?: PublishedMediaMap;
};

/**
 * Whose cache a call is about. Only the hosted server reads it: there each COMPANY has its own cache,
 * a `tenant_state` row (key `model_cache:<organisation id>`), because a catalogue probed with one
 * company's provider key must never reach another (Enterprise BYOK, Phase A; narrowed from the tenant to
 * the company in SR-163). `tenantId` is the white-label partner every company of a deployment sits
 * under, so a cache keyed by it alone showed company B's probe error and model list in company A's
 * Settings. A desktop or webdev desk has one cache, one file, and ignores the scope entirely, so every
 * Personal call behaves as it always did.
 *
 * A caller that has the tenant context passes it (`handlers`, the job runners): it carries the company.
 * A scope that names only the partner, or nothing, is read from the request in scope (`tenant-scope.ts`)
 * when that request is the same partner's, which is weaker than the settings store's rule
 * (`resolveSettingsScope` has no such fallback): work detached from a request inherits the company that
 * started it. Anything else on the hosted server is refused (`modelCacheOwner`), never answered from the
 * partner's row.
 */
export type ModelCacheScope = Readonly<{ tenantId: string; organizationId?: string }> | null | undefined;

/**
 * A settings scope as a cache scope. A tenant object names itself; a bare desk id or nothing names no
 * tenant, which is right on a desk (one cache) and is refused on the hosted server.
 */
export function modelCacheScopeOf(
  scope: Readonly<{ tenantId: string; organizationId?: string }> | string | null | undefined,
): ModelCacheScope {
  return typeof scope === "object" && scope !== null ? scope : undefined;
}

/** Which `tenant_state` payload holds a company's cache. See `tenant-state-store.ts`. */
const MODEL_CACHE_KEY = "model_cache" as const;

/** Whose cache, on the hosted server: the partner (the table's owner) and the company inside it. */
export type ModelCacheOwner = { readonly tenantId: string; readonly companyId: string };

/**
 * The partner and company a hosted call is about. Throws `tenant_required` when no partner can be
 * named and `company_required` when the partner is known and the company is not. Hosted only.
 *
 * The company is the scope's own; failing that, the request in scope's, provided that request is the
 * same partner's (a scope that names another partner never borrows this session's company).
 */
export function modelCacheOwner(scope: ModelCacheScope): ModelCacheOwner {
  const session = currentRequestSession();
  const tenantId = scope?.tenantId ?? session?.tenantId;
  if (!tenantId) {
    throw new ApiError(
      "tenant_required",
      "This request reached the model cache without a tenant. Hosted requests must name the tenant, never share one cache.",
      500,
    );
  }
  const named = typeof scope?.organizationId === "string" ? scope.organizationId : "";
  const companyId = named.trim() !== "" ? named : session && session.tenantId === tenantId ? session.orgId : "";
  if (companyId.trim() === "") {
    throw new ApiError(
      "company_required",
      "This request reached the model cache without a company. Hosted requests must name the organisation, never share the partner's cache.",
      500,
    );
  }
  return { tenantId: assertTenantId(tenantId), companyId };
}

/** The stored slot for one company's cache. */
function companySlot(owner: ModelCacheOwner): TenantStateSlot {
  return companyStateKey(MODEL_CACHE_KEY, owner.companyId);
}

/**
 * What a derived value built from the cache (the memoized catalogue, a warm-up in flight) is keyed by:
 * the partner and company on the hosted server, one constant on a desk. Throws on the hosted server when
 * no company can be named.
 */
export function modelCacheSlot(scope?: ModelCacheScope): string {
  if (!isServerMode()) {
    return "desk";
  }
  const owner = modelCacheOwner(scope);
  // JSON, not a joined string: two (partner, company) pairs never spell the same key.
  return JSON.stringify([owner.tenantId, owner.companyId]);
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
    availability: parseAvailabilityStore(parsed.availability),
    keyId: typeof parsed.keyId === "string" && parsed.keyId ? parsed.keyId : undefined,
    endpointHints: parseEndpointHints(parsed.endpointHints),
    endpointHintsAt: typeof parsed.endpointHintsAt === "string" ? parsed.endpointHintsAt : undefined,
    mediaParams: sanitizePublishedMediaParams(parsed.mediaParams),
  };
}

/** The stored price-list hints, dropping anything that is not `id -> string[]`. Capped, so a bad file cannot grow the cache. */
function parseEndpointHints(value: unknown): PricingHints | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const hints: Record<string, readonly string[]> = {};
  let count = 0;
  for (const [id, types] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 2_000) {
      break;
    }
    if (Array.isArray(types) && types.every((type) => typeof type === "string")) {
      hints[id] = types as string[];
      count += 1;
    }
  }
  return count > 0 ? hints : undefined;
}

/** Cheap change key for memoizing derived catalogs: the cache's mtime + size (a desk) or row stamp (a tenant), or "missing". */
export function modelCacheStamp(scope?: ModelCacheScope): string {
  if (isServerMode()) {
    const owner = modelCacheOwner(scope);
    return dbTenantStateBackend.stamp(owner.tenantId, companySlot(owner)) ?? "missing";
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
    const owner = modelCacheOwner(scope);
    const entry = dbTenantStateBackend.read(owner.tenantId, companySlot(owner));
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
    const owner = modelCacheOwner(scope);
    dbTenantStateBackend.write(owner.tenantId, companySlot(owner), JSON.stringify(cache));
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
