import {
  ApiError,
  INPUT_MODALITIES,
  availableProviders,
  GATEWAY_PROVIDER_ID,
  readOptionalModel,
  type InputModality,
  type ReasoningEffortChoice,
  type TenantContext,
} from "@agentforge/core";
import {
  DEFAULT_MODEL_TIER,
  MODEL_TIERS,
  readRequestedTier,
  resolveTier,
  type ModelTierId,
  type TierLiveness,
  type TierResolution,
  type TierThinking,
} from "@agentforge/core/tiers";
import { isJobModelDown } from "./job-model-fallback";
import type { ModelCacheScope } from "./model-cache";
import { listSelectableModels, type SelectableModel } from "./selectable-models";

/**
 * The host half of the model tiers (tester code, chat-first plan, track M1).
 *
 * `@agentforge/core/tiers` holds the lists and the pure walk. This file hands it what only the host
 * knows, the catalog and the breaker, and turns its answer into the three things the rest of the host
 * wants: the model and Thinking choice of one run (`chooseTierRun`), and the two catalog fields that tell
 * the screen which tiers can answer (`tierCatalogFields`). Nothing in either carries a model id out of
 * the host's own run path: the catalog fields name tiers, never models or providers.
 */

/** The only provider with candidate lists at M1. Enterprise key providers get theirs in M4. */
const SUPPORTED_PROVIDER = GATEWAY_PROVIDER_ID;

/**
 * What a tier asks of the model's Thinking control, as the choice `readReasoningEffortChoice` would have
 * made had the person picked it. `default` is not a choice, so `explicit` stays false and a model the
 * policy table does not know is sent no effort at all, as it is today.
 */
const REASONING_BY_THINKING: Readonly<Record<TierThinking, Readonly<ReasoningEffortChoice>>> = Object.freeze({
  off: Object.freeze({ effort: "none", explicit: true }),
  deep: Object.freeze({ effort: "high", explicit: true }),
  default: Object.freeze({ effort: "medium", explicit: false }),
});

/**
 * The catalog and the breaker as the `TierLiveness` the resolver asks for. `modality` is what the run
 * will carry in: for image and video a candidate must be listed with that input modality, so a tier never
 * resolves to a model that would refuse the attachment. Text asks nothing more than being listed.
 *
 * `scope` is whose breaker to read. Chat marks a model down for its own tenant (`runs.ts`), so a walk
 * that read the unscoped entry would never see that mark and would send the next turn to the same dead
 * model. Pass the run's tenant; leaving it out reads only the unscoped entry.
 */
export function tierLiveness(
  catalog: readonly SelectableModel[],
  modality: InputModality = "text",
  scope?: ModelCacheScope,
): TierLiveness {
  const rows = new Map<string, SelectableModel>();
  for (const model of catalog) {
    const key = model.id.toLowerCase();
    if (!rows.has(key)) {
      rows.set(key, model);
    }
  }
  return {
    providers: availableProviders(),
    listedAs: (provider, candidate) => {
      if (provider !== SUPPORTED_PROVIDER) {
        return undefined;
      }
      const row = rows.get(candidate.toLowerCase());
      if (!row || (modality !== "text" && !row.inputModalities.includes(modality))) {
        return undefined;
      }
      // The catalog's own spelling: it goes on the wire, and the list's spelling may differ in case.
      return row.id;
    },
    // The breaker keys by tenant and lower-case model id, not by provider, until it learns providers (M4).
    isDown: (_provider, model) => isJobModelDown(model, Date.now(), scope),
  };
}

export function resolveTierForCatalog(
  tier: ModelTierId,
  catalog: readonly SelectableModel[],
  modality: InputModality = "text",
  scope?: ModelCacheScope,
): TierResolution {
  return resolveTier(tier, tierLiveness(catalog, modality, scope));
}

/**
 * The model a tier run moves to when `failed` could not be reached and had said nothing (model tiers spec,
 * section 3, "Chat gains fallback"): the same tier's walk with `failed` skipped as if the breaker held it.
 * Never another tier, and undefined when the tier has nothing else live, so the person gets the failure
 * rather than a model of a kind they did not choose. The caller puts `failed` on the breaker.
 */
export function nextTierModel(
  tier: ModelTierId,
  failed: string,
  catalog: readonly SelectableModel[],
  modality: InputModality = "text",
  scope?: ModelCacheScope,
): string | undefined {
  const base = tierLiveness(catalog, modality, scope);
  const gone = failed.trim().toLowerCase();
  const resolved = resolveTier(tier, {
    ...base,
    isDown: (provider, model) => model.toLowerCase() === gone || base.isDown(provider, model),
  });
  return resolved.ok ? resolved.model : undefined;
}

/** One tier as the catalog payload shows it. No model id, label or provider name. */
export type TierCatalogEntry = {
  id: ModelTierId;
  available: boolean;
  /** Text, plus every modality some live candidate of this tier takes, in the registry's order. */
  inputModalities: InputModality[];
  /** The context window of the model a text send resolves to, or null when there is none or it is unknown. */
  contextLength: number | null;
};

export type TierCatalogFields = {
  tiers: TierCatalogEntry[];
  defaultTier: ModelTierId;
};

function knownContextLength(row: SelectableModel | undefined): number | null {
  const length = row?.contextLength;
  return typeof length === "number" && Number.isFinite(length) ? length : null;
}

/**
 * One entry per tier in `MODEL_TIERS` order. An unavailable tier is text only, so the screen has one rule.
 * `scope` is the tenant whose breaker decides availability, as it does for that tenant's runs.
 */
export function tierCatalog(catalog: readonly SelectableModel[], scope?: ModelCacheScope): TierCatalogEntry[] {
  const liveness = INPUT_MODALITIES.map((modality) => ({ modality, liveness: tierLiveness(catalog, modality, scope) }));
  return MODEL_TIERS.map((id) => {
    const text = resolveTier(id, tierLiveness(catalog, "text", scope));
    const inputModalities = liveness
      .filter((entry) => entry.modality === "text" || resolveTier(id, entry.liveness).ok)
      .map((entry) => entry.modality);
    return {
      id,
      available: text.ok,
      inputModalities,
      contextLength: text.ok ? knownContextLength(catalog.find((row) => row.id === text.model)) : null,
    };
  });
}

/** The two fields `GET /api/v1/models` and `GET /api/v1/chat` add to their payloads. */
export function tierCatalogFields(catalog: readonly SelectableModel[], scope?: ModelCacheScope): TierCatalogFields {
  return { tiers: tierCatalog(catalog, scope), defaultTier: DEFAULT_MODEL_TIER };
}

/**
 * A catalog payload with the tier fields added and nothing replaced or dropped. It is applied in the
 * handlers, not inside `modelCatalogBody`: this file reads the breaker in `job-model-fallback.ts`, which
 * reads the catalog from `selectable-models.ts`, so `selectable-models.ts` importing this file would make
 * an import cycle. A cycle changes what `job-model-fallback.ts` sees whenever a test mocks
 * `./selectable-models` with `importOriginal` and loads it first (the real `listSelectableModels`, not the
 * mock), which is how nine existing suites mock it.
 */
export function withTierFields<T extends { models: readonly SelectableModel[] }>(
  body: T,
  scope?: ModelCacheScope,
): T & TierCatalogFields {
  return { ...body, ...tierCatalogFields(body.models, scope) };
}

/** What a run that named a tier uses in place of the model and the Thinking level its body would carry. */
export type TierRun = Readonly<{
  tier: ModelTierId;
  /** The catalog's spelling of the model the tier resolved to. */
  model: string;
  reasoning: ReasoningEffortChoice;
}>;

function namedTier(body: unknown): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { tier?: unknown }).tier
    : undefined;
}

/**
 * The one door for a request's `tier`. A body that names none (absent or `null`) gets `null` and is
 * handled exactly as before. A body that names one is checked in this order: a model beside it is a
 * 400 `tier_and_model`; a value that is not a tier is a 400 `unknown_tier`; a tier with no live
 * candidate is a 503 `tier_unavailable`. It never falls to another tier or to a default model, and the
 * body's `thinking` and `reasoningEffort` are not read at all, so a malformed one cannot fail the run.
 */
export function chooseTierRun(
  body: unknown,
  modality: InputModality,
  catalog: readonly SelectableModel[],
  scope?: ModelCacheScope,
): TierRun | null {
  const named = namedTier(body);
  if (named === undefined || named === null) {
    return null;
  }
  if (readOptionalModel(body) !== undefined) {
    throw new ApiError("tier_and_model", "Send a tier or a model, not both", 400);
  }
  const requested = readRequestedTier(named);
  if (!requested.ok) {
    throw new ApiError("unknown_tier", `tier must be one of ${MODEL_TIERS.join(", ")}`, 400);
  }
  const resolved = resolveTierForCatalog(requested.tier, catalog, modality, scope);
  if (!resolved.ok) {
    throw new ApiError("tier_unavailable", "No model is available for this tier right now", 503);
  }
  return { tier: resolved.tier, model: resolved.model, reasoning: { ...REASONING_BY_THINKING[resolved.thinking] } };
}

/** `chooseTierRun` against the tenant's catalog. The catalog is not read when the body names no tier. */
export function resolveTierRun(options: {
  body: unknown;
  modality: InputModality;
  tenant: TenantContext;
}): TierRun | null {
  const named = namedTier(options.body);
  if (named === undefined || named === null) {
    return null;
  }
  return chooseTierRun(options.body, options.modality, listSelectableModels(options.tenant), options.tenant);
}
