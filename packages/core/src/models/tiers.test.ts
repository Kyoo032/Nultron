import { describe, expect, it } from "vitest";
import { availableProviders, GATEWAY_PROVIDER_ID, PROVIDER_IDS, type ProviderId } from "../providers/registry";
import type { ResolvedChatWire } from "../runtime/chat-wire";
import { allowedEffortsFor, modelPolicy, offFormatFor } from "./model-policy";
import { CHAT_DEFAULT_PREFERENCES } from "./preferred";
import {
  DEFAULT_MODEL_TIER,
  isModelTierId,
  MODEL_TIERS,
  type ModelTierId,
  readRequestedTier,
  resolveTier,
  TIER_DEFINITIONS,
  type TierDefinition,
  type TierDefinitions,
  type TierLiveness,
} from "./tiers";

const GATEWAY_IDS = [
  ...new Set(MODEL_TIERS.flatMap((tier) => TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [])),
];

type World = {
  providers?: readonly ProviderId[];
  /** The catalog: each provider's ids, spelled the way that provider spells them. */
  listed?: Partial<Record<ProviderId, readonly string[]>>;
  /** Ids the breaker holds down on every provider. */
  down?: readonly string[];
  /** Ids the breaker holds down on one provider only. */
  downOn?: Partial<Record<ProviderId, readonly string[]>>;
  /** Ids the host demotes for this turn, on every provider. Absent: the liveness has no `demoted` at all. */
  demoted?: readonly string[];
};

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A catalog and a breaker as plain data, so a test can say exactly what is live and what is held down. */
function world(options: World = {}): TierLiveness {
  const listed = options.listed ?? { [GATEWAY_PROVIDER_ID]: GATEWAY_IDS };
  return {
    providers: options.providers ?? [GATEWAY_PROVIDER_ID],
    listedAs: (provider, candidate) => (listed[provider] ?? []).find((id) => sameId(id, candidate)),
    isDown: (provider, model) =>
      (options.down ?? []).some((id) => sameId(id, model)) ||
      (options.downOn?.[provider] ?? []).some((id) => sameId(id, model)),
    ...(options.demoted
      ? { demoted: (_provider: ProviderId, model: string) => (options.demoted ?? []).some((id) => sameId(id, model)) }
      : {}),
  };
}

/** The shipped definitions with one tier's candidate lists swapped, for tests that need other providers. */
function definitionsWith(tier: ModelTierId, candidates: TierDefinition["candidates"]): TierDefinitions {
  return {
    daily: tier === "daily" ? { ...TIER_DEFINITIONS.daily, candidates } : TIER_DEFINITIONS.daily,
    fast: tier === "fast" ? { ...TIER_DEFINITIONS.fast, candidates } : TIER_DEFINITIONS.fast,
    reasoning: tier === "reasoning" ? { ...TIER_DEFINITIONS.reasoning, candidates } : TIER_DEFINITIONS.reasoning,
  };
}

function resolvedWire(id: string): ResolvedChatWire {
  const { wire } = modelPolicy(id);
  return wire === "auto" ? "chat_completions" : wire;
}

/** What is wrong with `id` as a Fastest model: its role is Fast drafts and Thinking can be turned off. */
function fastProblems(id: string): string[] {
  const policy = modelPolicy(id);
  const wire = resolvedWire(id);
  const problems: string[] = [];
  if (!policy.known) {
    problems.push("not in the policy table");
  }
  if (policy.bestFor !== "Fast drafts") {
    problems.push(`its role is ${policy.bestFor}`);
  }
  const off = offFormatFor(policy, wire);
  const canTurnOff =
    off === "thinking_disabled" || (off === "send_none" && allowedEffortsFor(policy, wire, false).includes("none"));
  if (!canTurnOff) {
    problems.push("Thinking cannot be turned off");
  }
  return problems;
}

/** What is wrong with `id` as a Reasoning model: its role is Deep reasoning and it accepts the Deep level. */
function reasoningProblems(id: string): string[] {
  const policy = modelPolicy(id);
  const problems: string[] = [];
  if (!policy.known) {
    problems.push("not in the policy table");
  }
  if (policy.bestFor !== "Deep reasoning") {
    problems.push(`its role is ${policy.bestFor}`);
  }
  if (!allowedEffortsFor(policy, resolvedWire(id), false).includes("high")) {
    problems.push("does not accept the Deep level");
  }
  return problems;
}

describe("the three tiers", () => {
  it("are daily, fast and reasoning, and daily is the default", () => {
    expect([...MODEL_TIERS]).toEqual(["daily", "fast", "reasoning"]);
    expect(DEFAULT_MODEL_TIER).toBe("daily");
  });

  it("decide how much the model thinks: fast off, daily the model's own default, reasoning deep", () => {
    expect(TIER_DEFINITIONS.fast.thinking).toBe("off");
    expect(TIER_DEFINITIONS.daily.thinking).toBe("default");
    expect(TIER_DEFINITIONS.reasoning.thinking).toBe("deep");
  });

  it("each carry the id they are stored under", () => {
    for (const tier of MODEL_TIERS) {
      expect(TIER_DEFINITIONS[tier].id, tier).toBe(tier);
    }
  });

  it("are frozen all the way down, so no later line can widen a list at run time", () => {
    expect(Object.isFrozen(TIER_DEFINITIONS)).toBe(true);
    for (const tier of MODEL_TIERS) {
      const definition = TIER_DEFINITIONS[tier];
      expect(Object.isFrozen(definition), tier).toBe(true);
      expect(Object.isFrozen(definition.candidates), tier).toBe(true);
      for (const ids of Object.values(definition.candidates)) {
        expect(Object.isFrozen(ids), tier).toBe(true);
      }
    }
  });

  it("keep their candidate maps free of a prototype, so no provider name finds an inherited list", () => {
    for (const tier of MODEL_TIERS) {
      expect(Object.getPrototypeOf(TIER_DEFINITIONS[tier].candidates), tier).toBeNull();
    }
  });
});

describe("candidate lists", () => {
  it("make daily exactly the Chat default list, so Daily behaves like Chat does today", () => {
    expect(TIER_DEFINITIONS.daily.candidates[GATEWAY_PROVIDER_ID]).toEqual(CHAT_DEFAULT_PREFERENCES);
  });

  it("give every tier a gateway list with no repeated id", () => {
    for (const tier of MODEL_TIERS) {
      const ids = TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [];
      expect(ids.length, tier).toBeGreaterThan(0);
      expect(new Set(ids).size, tier).toBe(ids.length);
    }
  });

  it("only name providers the registry knows", () => {
    for (const tier of MODEL_TIERS) {
      for (const provider of Object.keys(TIER_DEFINITIONS[tier].candidates)) {
        expect(PROVIDER_IDS as readonly string[], `${tier}.${provider}`).toContain(provider);
      }
    }
  });

  it("only name models the policy table knows, each with a verified note", () => {
    for (const tier of MODEL_TIERS) {
      for (const ids of Object.values(TIER_DEFINITIONS[tier].candidates)) {
        for (const id of ids) {
          const policy = modelPolicy(id);
          expect(policy.known, `${tier}: ${id}`).toBe(true);
          expect(policy.verified.trim().length, `${tier}: ${id}`).toBeGreaterThan(10);
        }
      }
    }
  });

  it("name only models that fit the Fastest tier: role Fast drafts, and Thinking can be turned off", () => {
    for (const id of TIER_DEFINITIONS.fast.candidates[GATEWAY_PROVIDER_ID] ?? []) {
      expect(fastProblems(id), id).toEqual([]);
    }
  });

  it("name only models that fit the Reasoning tier: role Deep reasoning, and the Deep level is accepted", () => {
    for (const id of TIER_DEFINITIONS.reasoning.candidates[GATEWAY_PROVIDER_ID] ?? []) {
      expect(reasoningProblems(id), id).toEqual([]);
    }
  });

  it("have guards that can fail: they turn away a model that belongs to another tier", () => {
    // A Deep reasoning model is not a Fastest model, and one that cannot be turned off never is.
    expect(fastProblems("claude-opus-5-5")).toContain("its role is Deep reasoning");
    expect(fastProblems("gpt-6-astra")).toContain("Thinking cannot be turned off");
    // A plain chat model, a fast model and an id nobody has seen are not Reasoning models.
    expect(reasoningProblems("gpt-4o")).toContain("its role is General chat");
    expect(reasoningProblems("gpt-6-luna")).toContain("its role is Fast drafts");
    expect(reasoningProblems("banana-unknown")).toContain("not in the policy table");
  });
});

describe("resolveTier", () => {
  it("answers with the first candidate that is listed and not held down", () => {
    const result = resolveTier("daily", world());
    expect(result).toMatchObject({
      ok: true,
      tier: "daily",
      provider: GATEWAY_PROVIDER_ID,
      model: CHAT_DEFAULT_PREFERENCES[0],
      thinking: "default",
      skipped: [],
    });
  });

  it("skips an id the catalog does not list, and says so", () => {
    const first = CHAT_DEFAULT_PREFERENCES[0] as string;
    const second = CHAT_DEFAULT_PREFERENCES[1] as string;
    const result = resolveTier(
      "daily",
      world({ listed: { [GATEWAY_PROVIDER_ID]: GATEWAY_IDS.filter((id) => id !== first) } }),
    );
    expect(result).toMatchObject({
      ok: true,
      model: second,
      skipped: [{ provider: GATEWAY_PROVIDER_ID, model: first, reason: "unlisted" }],
    });
  });

  it("skips an id the breaker holds down, and says so", () => {
    const first = CHAT_DEFAULT_PREFERENCES[0] as string;
    const second = CHAT_DEFAULT_PREFERENCES[1] as string;
    const result = resolveTier("daily", world({ down: [first] }));
    expect(result).toMatchObject({
      ok: true,
      model: second,
      skipped: [{ provider: GATEWAY_PROVIDER_ID, model: first, reason: "down" }],
    });
  });

  it("answers with the catalog's spelling and asks the breaker about that spelling", () => {
    const asked: string[] = [];
    const liveness: TierLiveness = {
      providers: [GATEWAY_PROVIDER_ID],
      listedAs: (_provider, candidate) => (candidate === "gpt-6-luna" ? "GPT-6-Luna" : undefined),
      isDown: (_provider, model) => {
        asked.push(model);
        return false;
      },
    };
    const result = resolveTier("fast", liveness);
    expect(result).toMatchObject({
      ok: true,
      model: "GPT-6-Luna",
      skipped: [{ model: "deepseek-v4-1-flash", reason: "unlisted" }],
    });
    expect(asked).toEqual(["GPT-6-Luna"]);
  });

  it("answers tier_unavailable when nothing is live", () => {
    const result = resolveTier("fast", world({ listed: { [GATEWAY_PROVIDER_ID]: [] } }));
    expect(result).toMatchObject({ ok: false, tier: "fast", error: "tier_unavailable" });
  });

  it("answers tier_unavailable when no provider is allowed", () => {
    expect(resolveTier("daily", world({ providers: [] }))).toMatchObject({
      ok: false,
      error: "tier_unavailable",
      skipped: [],
    });
  });

  it("never falls through to another tier: a person who chose Reasoning is not given a fast model", () => {
    const reasoningOnly = (TIER_DEFINITIONS.reasoning.candidates[GATEWAY_PROVIDER_ID] ?? []).filter(
      (id) =>
        !(TIER_DEFINITIONS.daily.candidates[GATEWAY_PROVIDER_ID] ?? []).includes(id) &&
        !(TIER_DEFINITIONS.fast.candidates[GATEWAY_PROVIDER_ID] ?? []).includes(id),
    );
    expect(reasoningOnly.length).toBeGreaterThan(0);
    const onlyReasoningIsLive = world({ listed: { [GATEWAY_PROVIDER_ID]: reasoningOnly } });
    expect(resolveTier("daily", onlyReasoningIsLive).ok).toBe(false);
    expect(resolveTier("fast", onlyReasoningIsLive).ok).toBe(false);
    expect(resolveTier("reasoning", onlyReasoningIsLive).ok).toBe(true);
  });

  it("answers tier_unavailable when every candidate is held down", () => {
    const result = resolveTier("reasoning", world({ down: GATEWAY_IDS }));
    expect(result).toMatchObject({ ok: false, error: "tier_unavailable" });
  });

  it("reports every skipped candidate in the order it tried them, even on failure", () => {
    const result = resolveTier("reasoning", world({ listed: { [GATEWAY_PROVIDER_ID]: [] } }));
    const expected = TIER_DEFINITIONS.reasoning.candidates[GATEWAY_PROVIDER_ID] ?? [];
    expect(result.skipped.map((entry) => entry.model)).toEqual([...expected]);
    expect(new Set(result.skipped.map((entry) => entry.reason))).toEqual(new Set(["unlisted"]));
  });

  it("returns results nobody can change afterwards", () => {
    const result = resolveTier("reasoning", world({ listed: { [GATEWAY_PROVIDER_ID]: [] } }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skipped)).toBe(true);
    expect(Object.isFrozen(result.skipped[0])).toBe(true);
  });

  it("tries a provider named twice only once", () => {
    const once = resolveTier(
      "reasoning",
      world({ providers: [GATEWAY_PROVIDER_ID], listed: { [GATEWAY_PROVIDER_ID]: [] } }),
    );
    const twice = resolveTier(
      "reasoning",
      world({ providers: [GATEWAY_PROVIDER_ID, GATEWAY_PROVIDER_ID], listed: { [GATEWAY_PROVIDER_ID]: [] } }),
    );
    expect(twice.skipped).toEqual(once.skipped);
  });

  it("never reads an inherited property as a provider's list", () => {
    const plainObjectLists = definitionsWith("fast", { [GATEWAY_PROVIDER_ID]: ["deepseek-v4-1-flash"] });
    for (const provider of ["constructor", "toString", "__proto__", "hasOwnProperty"] as unknown as ProviderId[]) {
      for (const definitions of [plainObjectLists, TIER_DEFINITIONS]) {
        const result = resolveTier("fast", world({ providers: [provider], listed: {} }), definitions);
        expect(result, provider).toMatchObject({ ok: false, error: "tier_unavailable", skipped: [] });
      }
    }
  });
});

describe("resolveTier across providers", () => {
  const sonnet = ["claude-sonnet-5-5", "claude-sonnet-5"];
  const definitions = definitionsWith(
    "daily",
    Object.freeze({ anthropic: Object.freeze(sonnet), [GATEWAY_PROVIDER_ID]: Object.freeze(["gpt-6-luna"]) }),
  );
  const listed = { anthropic: sonnet, [GATEWAY_PROVIDER_ID]: ["gpt-6-luna"] };

  it("walks the providers in the order it is given", () => {
    expect(
      resolveTier("daily", world({ providers: ["anthropic", GATEWAY_PROVIDER_ID], listed }), definitions),
    ).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(
      resolveTier("daily", world({ providers: [GATEWAY_PROVIDER_ID, "anthropic"], listed }), definitions),
    ).toMatchObject({
      ok: true,
      provider: GATEWAY_PROVIDER_ID,
      model: "gpt-6-luna",
    });
  });

  it("tries every candidate of one provider before it moves to the next", () => {
    const oneDown = world({ providers: ["anthropic", GATEWAY_PROVIDER_ID], listed, down: ["claude-sonnet-5-5"] });
    expect(resolveTier("daily", oneDown, definitions)).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const bothDown = world({ providers: ["anthropic", GATEWAY_PROVIDER_ID], listed, down: sonnet });
    expect(resolveTier("daily", bothDown, definitions)).toMatchObject({
      ok: true,
      provider: GATEWAY_PROVIDER_ID,
      model: "gpt-6-luna",
    });
  });

  it("holds a model down for one provider without holding it down for another", () => {
    const same = definitionsWith(
      "daily",
      Object.freeze({
        [GATEWAY_PROVIDER_ID]: Object.freeze(["claude-sonnet-5-5"]),
        anthropic: Object.freeze(["claude-sonnet-5-5"]),
      }),
    );
    const result = resolveTier(
      "daily",
      world({
        providers: [GATEWAY_PROVIDER_ID, "anthropic"],
        listed: { [GATEWAY_PROVIDER_ID]: ["claude-sonnet-5-5"], anthropic: ["claude-sonnet-5-5"] },
        downOn: { [GATEWAY_PROVIDER_ID]: ["claude-sonnet-5-5"] },
      }),
      same,
    );
    expect(result).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      skipped: [{ provider: GATEWAY_PROVIDER_ID, model: "claude-sonnet-5-5", reason: "down" }],
    });
  });

  it("uses only the providers it is given: Personal passes the gateway alone, whatever the lists and the catalog say", () => {
    const personal = availableProviders({});
    expect([...personal]).toEqual([GATEWAY_PROVIDER_ID]);
    expect(resolveTier("daily", world({ providers: personal, listed }), definitions)).toMatchObject({
      ok: true,
      provider: GATEWAY_PROVIDER_ID,
      model: "gpt-6-luna",
    });
    const onlyAnthropicIsListed = world({ providers: personal, listed: { anthropic: sonnet } });
    expect(resolveTier("daily", onlyAnthropicIsListed, definitions)).toMatchObject({
      ok: false,
      error: "tier_unavailable",
    });
  });

  it("skips a provider that has no list for the tier", () => {
    const gatewayOnly = definitionsWith(
      "fast",
      Object.freeze({ [GATEWAY_PROVIDER_ID]: Object.freeze(["deepseek-v4-1-flash"]) }),
    );
    const result = resolveTier("fast", world({ providers: ["openrouter", GATEWAY_PROVIDER_ID] }), gatewayOnly);
    expect(result).toMatchObject({
      ok: true,
      provider: GATEWAY_PROVIDER_ID,
      model: "deepseek-v4-1-flash",
      skipped: [],
    });
  });
});

describe("resolveTier with demoted candidates", () => {
  const [first, second, third] = CHAT_DEFAULT_PREFERENCES as [string, string, string];

  it("tries a demoted candidate after every other live one, and says it passed it over", () => {
    const result = resolveTier("daily", world({ demoted: [first] }));
    expect(result).toMatchObject({
      ok: true,
      model: second,
      thinking: "default",
      skipped: [{ provider: GATEWAY_PROVIDER_ID, model: first, reason: "demoted" }],
    });
  });

  it("changes nothing for the rest of the order: a demoted second candidate leaves the head the head", () => {
    expect(resolveTier("daily", world({ demoted: [second] }))).toMatchObject({ ok: true, model: first, skipped: [] });
    // Two demoted ahead of the answer: the answer is the first live one that is not demoted, and both are reported.
    const result = resolveTier("daily", world({ demoted: [first, second] }));
    expect(result).toMatchObject({
      ok: true,
      model: third,
      skipped: [
        { model: first, reason: "demoted" },
        { model: second, reason: "demoted" },
      ],
    });
  });

  it("is the plain walk when the liveness demotes nothing, and when it demotes nothing that is live", () => {
    const plain = resolveTier("daily", world());
    expect(resolveTier("daily", world({ demoted: [] }))).toEqual(plain);
    expect(resolveTier("daily", world({ demoted: ["a-model-no-list-names"] }))).toEqual(plain);
  });

  it("answers with the first demoted candidate when every live candidate is demoted, so the tier still answers", () => {
    const result = resolveTier("daily", world({ demoted: GATEWAY_IDS }));
    expect(result).toMatchObject({ ok: true, model: first, thinking: "default", skipped: [] });
    // Only two demoted models are live, and the first in the list's order answers.
    const two = resolveTier(
      "daily",
      world({ listed: { [GATEWAY_PROVIDER_ID]: [third, second] }, demoted: [second, third] }),
    );
    expect(two).toMatchObject({ ok: true, model: second });
    expect(new Set(two.skipped.map((entry) => entry.reason))).toEqual(new Set(["unlisted"]));
  });

  it("reports an unlisted or held-down candidate as that, and never asks whether it is demoted", () => {
    const asked: string[] = [];
    const liveness: TierLiveness = {
      ...world({ listed: { [GATEWAY_PROVIDER_ID]: [second, third] }, down: [second] }),
      demoted: (_provider, model) => {
        asked.push(model);
        return model === third;
      },
    };
    const result = resolveTier("daily", liveness);
    expect(asked).toEqual([third]);
    expect(result).toMatchObject({ ok: true, model: third });
    expect(result.skipped.slice(0, 2)).toEqual([
      { provider: GATEWAY_PROVIDER_ID, model: first, reason: "unlisted" },
      { provider: GATEWAY_PROVIDER_ID, model: second, reason: "down" },
    ]);
    // The only live candidate is demoted and answers; nothing was passed over for it, so no demotion is reported.
    expect(result.skipped.some((entry) => entry.reason === "demoted")).toBe(false);
  });

  it("holds a demoted candidate back across providers, and does not break the provider order otherwise", () => {
    const sonnet = ["claude-sonnet-5-5"];
    const definitions = definitionsWith(
      "daily",
      Object.freeze({ anthropic: Object.freeze(sonnet), [GATEWAY_PROVIDER_ID]: Object.freeze(["gpt-6-luna"]) }),
    );
    const listed = { anthropic: sonnet, [GATEWAY_PROVIDER_ID]: ["gpt-6-luna"] };
    const providers: ProviderId[] = [GATEWAY_PROVIDER_ID, "anthropic"];
    // The gateway is first, but its only candidate is demoted: the next provider's candidate answers.
    expect(resolveTier("daily", world({ providers, listed, demoted: ["gpt-6-luna"] }), definitions)).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      skipped: [{ provider: GATEWAY_PROVIDER_ID, model: "gpt-6-luna", reason: "demoted" }],
    });
    // Both demoted: the first in provider order answers.
    const bothDemoted = world({ providers, listed, demoted: ["gpt-6-luna", "claude-sonnet-5-5"] });
    expect(resolveTier("daily", bothDemoted, definitions)).toMatchObject({
      ok: true,
      provider: GATEWAY_PROVIDER_ID,
      model: "gpt-6-luna",
      skipped: [],
    });
    // Nothing demoted: unchanged.
    expect(resolveTier("daily", world({ providers, listed }), definitions)).toMatchObject({
      provider: GATEWAY_PROVIDER_ID,
      model: "gpt-6-luna",
    });
  });

  it("is still tier_unavailable when nothing is live, and a demoted model that is held down does not count as live", () => {
    expect(resolveTier("daily", world({ listed: { [GATEWAY_PROVIDER_ID]: [] }, demoted: GATEWAY_IDS }))).toMatchObject({
      ok: false,
      error: "tier_unavailable",
      skipped: expect.any(Array),
    });
    const onlyFirstIsListed = resolveTier(
      "daily",
      world({ listed: { [GATEWAY_PROVIDER_ID]: [first] }, down: [first], demoted: [first] }),
    );
    expect(onlyFirstIsListed).toMatchObject({ ok: false, error: "tier_unavailable" });
    expect(onlyFirstIsListed.skipped[0]).toEqual({ provider: GATEWAY_PROVIDER_ID, model: first, reason: "down" });
  });

  it("returns results nobody can change afterwards", () => {
    for (const demoted of [[first], GATEWAY_IDS]) {
      const result = resolveTier("daily", world({ demoted }));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.skipped)).toBe(true);
      for (const entry of result.skipped) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    }
  });
});

describe("readRequestedTier", () => {
  it("gives daily when the request names no tier, including a JSON null", () => {
    expect(readRequestedTier(undefined)).toEqual({ ok: true, tier: "daily" });
    expect(readRequestedTier(null)).toEqual({ ok: true, tier: "daily" });
  });

  it("accepts each tier id", () => {
    for (const tier of MODEL_TIERS) {
      expect(readRequestedTier(tier)).toEqual({ ok: true, tier });
      expect(isModelTierId(tier)).toBe(true);
    }
  });

  it("refuses anything else instead of defaulting, so a typo never quietly picks a model", () => {
    for (const value of ["Daily", "DAILY", " daily", "", "turbo", "best", "constructor", 5, true, {}, []]) {
      expect(readRequestedTier(value), JSON.stringify(value)).toEqual({ ok: false, error: "unknown_tier" });
      expect(isModelTierId(value)).toBe(false);
    }
  });

  it("returns results nobody can change afterwards", () => {
    expect(Object.isFrozen(readRequestedTier("fast"))).toBe(true);
    expect(Object.isFrozen(readRequestedTier("nope"))).toBe(true);
    expect(Object.isFrozen(readRequestedTier(undefined))).toBe(true);
  });
});
