import { GATEWAY_PROVIDER_ID } from "../providers/gateway-id";
import type { ProviderId } from "../providers/registry";
import { CHAT_DEFAULT_PREFERENCES } from "./preferred";

/**
 * The three model choices a person sees (tester code, chat-first plan, track M0).
 *
 * A person picks a tier. The host turns it into a real model with `resolveTier`, and by default the
 * screen never learns which model answered. This file is pure: it holds the lists and the walk, and
 * knows nothing about the catalog, the breaker or a request. The caller passes those in as
 * `TierLiveness`, which keeps the walk testable and keeps this file free of host imports.
 *
 * - `daily` is the default and behaves like Chat does today: its gateway list is exactly
 *   `CHAT_DEFAULT_PREFERENCES`, imported rather than copied, so a change to the published default list
 *   reaches Daily on the next sync with no edit here.
 * - `fast` runs with Thinking off and answers first.
 * - `reasoning` thinks at a deep level before it answers.
 *
 * `ModelTier` in `model-policy.ts` ("everyday" or "advanced") is a different thing: a curation label
 * for the Recommended group. It is left alone on purpose, because renaming an exported type in a file
 * the published code also edits would cost a conflict at every sync. Rename it at promotion time.
 */

export const MODEL_TIERS = Object.freeze(["daily", "fast", "reasoning"] as const);

export type ModelTierId = (typeof MODEL_TIERS)[number];

export const DEFAULT_MODEL_TIER: ModelTierId = "daily";

/**
 * What a tier asks of the model's Thinking control. `off` is Off, `default` leaves the model's own
 * default, `deep` is the Deep level (`high`). The host maps these to a reasoning effort per model in
 * M1; the levels a model accepts still come from `modelPolicy`.
 */
export type TierThinking = "off" | "default" | "deep";

export type TierDefinition = Readonly<{
  id: ModelTierId;
  thinking: TierThinking;
  /**
   * Model ids for each provider, best first. The first id that is listed and not held down answers.
   * A provider with no list is skipped, which is how a tenant that only has an Anthropic key resolves
   * inside Anthropic's list once M4 fills it in.
   */
  candidates: Readonly<Partial<Record<ProviderId, readonly string[]>>>;
}>;

export type TierDefinitions = Readonly<Record<ModelTierId, TierDefinition>>;

function freezeList(ids: readonly string[]): readonly string[] {
  return Object.freeze([...ids]);
}

/**
 * The candidate map has no prototype, so a provider name such as "constructor" or "__proto__" can
 * never find an inherited property. `resolveTier` also checks for an own key, because a test or a
 * later tenant list may hand it a plain object.
 */
function define(
  id: ModelTierId,
  thinking: TierThinking,
  candidates: Partial<Record<ProviderId, readonly string[]>>,
): TierDefinition {
  const lists: Partial<Record<ProviderId, readonly string[]>> = Object.create(null);
  for (const provider of Object.keys(candidates) as ProviderId[]) {
    lists[provider] = freezeList(candidates[provider] ?? []);
  }
  return Object.freeze({ id, thinking, candidates: Object.freeze(lists) });
}

/**
 * Seed lists, 2026-10-06. Every id is one the repo already recommends, defaults to or falls back on,
 * and whose role in `gateway-roles.ts` matches the tier. `tiers.test.ts` holds the same kind of guard
 * as `model-policy-guard.test.ts` and goes further: it checks the role word and what the model's
 * policy says about Thinking, so an id that does not fit its tier fails the build.
 *
 * What is measured and what is not:
 * - `fast` follows the probe of 2026-09-30 (`docs/internal/gateway-model-selection.md`, section 10.3):
 *   `deepseek-v4-1-flash` answered its first token in 1.3 to 1.9 s and `gpt-6-luna` in 1.9 to 2.3 s,
 *   both with Off accepted. `gpt-5.6-luna` and `deepseek-v4-flash` were not probed.
 * - `reasoning` leads with the two ids that document names as the deep-reasoning picks, probed the same
 *   day (`claude-opus-5-5` Deep first token 9.0 s, `gpt-6-astra` 5.4 to 7.0 s). `gpt-5.6-sol` and
 *   `kimi-k3` are role-matched stand-ins that were not probed.
 * - No worker-routing eval has run yet (`chat-workers-spec.md`, section 5). A model that routes badly
 *   comes off a list when it does.
 *
 * Only the pinned gateway has lists. Enterprise key providers get theirs in M4.
 */
export const TIER_DEFINITIONS: TierDefinitions = Object.freeze({
  daily: define("daily", "default", { [GATEWAY_PROVIDER_ID]: CHAT_DEFAULT_PREFERENCES }),
  fast: define("fast", "off", {
    [GATEWAY_PROVIDER_ID]: ["deepseek-v4-1-flash", "gpt-6-luna", "gpt-5.6-luna", "deepseek-v4-flash"],
  }),
  reasoning: define("reasoning", "deep", {
    [GATEWAY_PROVIDER_ID]: ["claude-opus-5-5", "gpt-6-astra", "gpt-5.6-sol", "kimi-k3"],
  }),
});

export function isModelTierId(value: unknown): value is ModelTierId {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

export type RequestedTier = Readonly<{ ok: true; tier: ModelTierId }> | Readonly<{ ok: false; error: "unknown_tier" }>;

/**
 * The tier a request names. A request that names none gets Daily, and so does a JSON `null`, which is
 * how a client says "none". A request that names something that is not a tier gets `unknown_tier` and
 * never a default, so a typo cannot quietly pick a model. The match is exact: "Daily" is not "daily".
 */
export function readRequestedTier(value: unknown): RequestedTier {
  if (value === undefined || value === null) {
    return Object.freeze({ ok: true, tier: DEFAULT_MODEL_TIER });
  }
  return isModelTierId(value)
    ? Object.freeze({ ok: true, tier: value })
    : Object.freeze({ ok: false, error: "unknown_tier" });
}

/** What is live right now. The host builds this from the model catalog and the breaker. */
export type TierLiveness = Readonly<{
  /** The providers this tenant may use, in the order to try them. Personal passes `availableProviders()`, which is the pinned gateway only. */
  providers: readonly ProviderId[];
  /**
   * The model as this provider's catalog spells it, or undefined when the catalog does not list it.
   * The answer goes on the wire, so it must be the catalog's spelling: a list that says `gpt-6-luna`
   * and a catalog that says `GPT-6-Luna` would otherwise send a name the gateway can answer 404 to,
   * and a 404 is not a failure the fallback retries.
   */
  listedAs: (provider: ProviderId, candidate: string) => string | undefined;
  /**
   * Whether the breaker holds this model down for this provider. `model` is the catalog spelling. The
   * breaker that exists today keys by lower-case id alone, so the host adapter lower-cases and ignores
   * `provider` until the breaker learns providers, which M4 needs.
   */
  isDown: (provider: ProviderId, model: string) => boolean;
  /**
   * Whether this live model is held to the end of the walk for this turn: it answers only when no other
   * candidate of the tier, on any provider, is live. It is demoted, never dropped, so a tier whose only live
   * candidates are demoted still answers. Absent means nothing is demoted. `model` is the catalog spelling.
   * The walk does not know why: the host decides, from the turn and from what it has measured of the model.
   */
  demoted?: (provider: ProviderId, model: string) => boolean;
}>;

export type SkippedCandidate = Readonly<{
  provider: ProviderId;
  /** The catalog spelling when the model was listed, otherwise the spelling in the list. */
  model: string;
  /** `demoted`: live, but passed over for a later candidate that is not demoted. */
  reason: "unlisted" | "down" | "demoted";
}>;

export type TierResolution =
  | Readonly<{
      ok: true;
      tier: ModelTierId;
      provider: ProviderId;
      model: string;
      thinking: TierThinking;
      /** The candidates tried before this one, in order, for the log. */
      skipped: readonly SkippedCandidate[];
    }>
  | Readonly<{
      ok: false;
      tier: ModelTierId;
      error: "tier_unavailable";
      skipped: readonly SkippedCandidate[];
    }>;

/**
 * Turn a tier into a model. Providers are tried in the order given, each once, and all of one
 * provider's candidates are tried before the next provider. A candidate is skipped when the catalog
 * does not list it or the breaker holds it down. When none is left the answer is `tier_unavailable`,
 * which is also the answer for an empty provider list.
 *
 * A candidate `liveness.demoted` names is tried after every other candidate of the tier, across all
 * providers, in the order the lists give. The order of everything else is unchanged. When only demoted
 * candidates are live, the first of them answers.
 *
 * It never falls through to another tier: a person who chose Reasoning and got a fast model was told
 * something untrue. Chat's fallback after a failed call is the same walk run again, because the host
 * puts the failed id on the breaker first.
 *
 * `definitions` is a parameter so a test, and later a tenant's own lists, can supply different ones.
 * `tier` must already be a tier id: `readRequestedTier` is the door for anything from a request.
 */
export function resolveTier(
  tier: ModelTierId,
  liveness: TierLiveness,
  definitions: TierDefinitions = TIER_DEFINITIONS,
): TierResolution {
  const definition = definitions[tier];
  const skipped: SkippedCandidate[] = [];
  const held: { provider: ProviderId; model: string }[] = [];
  const answer = (provider: ProviderId, model: string, trail: readonly SkippedCandidate[]): TierResolution =>
    Object.freeze({
      ok: true,
      tier,
      provider,
      model,
      thinking: definition.thinking,
      skipped: Object.freeze([...trail]),
    });
  for (const provider of new Set(liveness.providers)) {
    const candidates = Object.hasOwn(definition.candidates, provider) ? definition.candidates[provider] : undefined;
    for (const candidate of candidates ?? []) {
      const model = liveness.listedAs(provider, candidate);
      if (model === undefined) {
        skipped.push(Object.freeze({ provider, model: candidate, reason: "unlisted" }));
        continue;
      }
      if (liveness.isDown(provider, model)) {
        skipped.push(Object.freeze({ provider, model, reason: "down" }));
        continue;
      }
      if (liveness.demoted?.(provider, model)) {
        held.push({ provider, model });
        skipped.push(Object.freeze({ provider, model, reason: "demoted" }));
        continue;
      }
      return answer(provider, model, skipped);
    }
  }
  // Nothing undemoted is live. The first demoted candidate answers, and the log has no demotion to report
  // for it: nothing was passed over for it.
  const [fallback] = held;
  const passedOver = skipped.filter((entry) => entry.reason !== "demoted");
  if (fallback) {
    return answer(fallback.provider, fallback.model, passedOver);
  }
  return Object.freeze({ ok: false, tier, error: "tier_unavailable", skipped: Object.freeze(passedOver) });
}
