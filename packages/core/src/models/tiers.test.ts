import { describe, expect, it } from "vitest";
import { availableProviders, GATEWAY_PROVIDER_ID, PROVIDER_IDS, type ProviderId } from "../providers/registry";
import type { ResolvedChatWire } from "../runtime/chat-wire";
import { allowedEffortsFor, modelPolicy, offFormatFor } from "./model-policy";
import { CHAT_DEFAULT_PREFERENCES } from "./preferred";
import { bareModelId } from "./request-constraints";
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

/** The company behind a model id, read off its name. An id nobody has mapped is its own vendor. */
const VENDOR_PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^gpt-/, "openai"],
  [/^o\d/, "openai"],
  [/^claude-/, "anthropic"],
  [/^deepseek-/, "deepseek"],
  [/^gemini-/, "google"],
  [/^glm-/, "zhipu"],
  [/^qwen/, "alibaba"],
  [/^kimi-/, "moonshot"],
  [/^minimax/, "minimax"],
  [/^hy3/, "tencent"],
];

function vendorOf(id: string): string {
  const bare = bareModelId(id);
  return VENDOR_PREFIXES.find(([prefix]) => prefix.test(bare))?.[1] ?? id;
}

function vendorCount(ids: readonly string[]): number {
  return new Set(ids.map(vendorOf)).size;
}

/** Whether the first two candidates come from two different vendors, so one outage never takes both. */
function leadVendorsDiffer(ids: readonly string[]): boolean {
  return ids.length >= 2 && vendorOf(ids[0] as string) !== vendorOf(ids[1] as string);
}

function gatewayList(tier: ModelTierId): readonly string[] {
  return TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [];
}

/** What a `verified` note says when the id was tried live: "probe 2026-09-30 (...)". "Not yet probed" does not match. */
const PROBED_NOTE = /probe \d{4}-\d{2}-\d{2}/;

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

  it("lead every tier with a model that was probed live: an unprobed one may sit behind a probed one, never ahead", () => {
    for (const tier of MODEL_TIERS) {
      // The head is the first gateway candidate: what answers whenever nothing is held down.
      const head = gatewayList(tier)[0] as string;
      expect(head, tier).toBeDefined();
      expect(modelPolicy(head).verified, `${tier}: ${head} was never probed`).toMatch(PROBED_NOTE);
    }
  });
});

describe("the vendors behind each tier", () => {
  it("give every tier at least 3 candidates from at least 3 vendors, so one outage cannot empty it", () => {
    for (const tier of MODEL_TIERS) {
      const ids = gatewayList(tier);
      expect(ids.length, `${tier}: candidates`).toBeGreaterThanOrEqual(3);
      expect(vendorCount(ids), `${tier}: vendors in ${ids.join(", ")}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("start every tier with two candidates from two different vendors", () => {
    for (const tier of MODEL_TIERS) {
      const ids = gatewayList(tier);
      expect(leadVendorsDiffer(ids), `${tier}: ${ids[0]} and ${ids[1]} share a vendor`).toBe(true);
    }
  });

  it("still resolve each tier when every candidate of any one vendor is held down, and answer from another vendor", () => {
    for (const tier of MODEL_TIERS) {
      const ids = gatewayList(tier);
      for (const vendor of new Set(ids.map(vendorOf))) {
        const down = ids.filter((id) => vendorOf(id) === vendor);
        const result = resolveTier(tier, world({ down }));
        expect(result.ok, `${tier} without ${vendor}`).toBe(true);
        if (result.ok) {
          expect(vendorOf(result.model), `${tier} without ${vendor} answered ${result.model}`).not.toBe(vendor);
        }
      }
    }
  });

  it("have guards that can fail: a list from one vendor counts as one vendor and its lead pair shares it", () => {
    const oneVendor = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
    expect(vendorCount(oneVendor)).toBe(1);
    expect(vendorCount(oneVendor)).toBeLessThan(3);
    expect(leadVendorsDiffer(oneVendor)).toBe(false);
    expect(leadVendorsDiffer(["gpt-6-luna"])).toBe(false);
    // The mapping itself: a vendor prefix and case do not matter, and an unmapped id is its own vendor.
    expect(vendorOf("openai/GPT-6-Luna")).toBe("openai");
    expect(vendorOf("o3")).toBe("openai");
    expect(vendorOf("qwen3.8-flash")).toBe("alibaba");
    expect(vendorOf("banana-unknown")).toBe("banana-unknown");
    // The probe guard turns away an id whose note says it was never probed, and takes one that cites a probe.
    expect(modelPolicy("claude-haiku-5-5").verified).not.toMatch(PROBED_NOTE);
    expect(modelPolicy("gpt-6-luna").verified).toMatch(PROBED_NOTE);
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
