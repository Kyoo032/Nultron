import { describe, expect, it } from "vitest";
import { GATEWAY_PROVIDER_ID } from "../providers/gateway-id";
import { resolveChatWire } from "../runtime/chat-wire";
import { allowedReasoningEfforts } from "../runtime/effort-allowlist";
import {
  CHOICE_KINDS,
  CHOICE_PROFILE_IDS,
  CHOICE_PROFILES,
  type CandidateRef,
  type ChoiceKind,
  type ChoiceProfile,
  PROFILE_FOR_SHELL,
} from "./choice-profiles";
import { modelPolicy } from "./model-policy";
import { coerceReasoningEffortForModel } from "./reasoning-effort";

function gatewayRefs(profile: ChoiceProfile, kind: ChoiceKind): readonly CandidateRef[] {
  return profile.lists[kind][GATEWAY_PROVIDER_ID] ?? [];
}

function allRefs(profile: ChoiceProfile): Array<{ kind: ChoiceKind; ref: CandidateRef }> {
  return CHOICE_KINDS.flatMap((kind) => gatewayRefs(profile, kind).map((ref) => ({ kind, ref })));
}

describe("choice profiles seed", () => {
  it("has the two profile keys, opc and enterprise", () => {
    expect(CHOICE_PROFILE_IDS).toEqual(["opc", "enterprise"]);
    expect(CHOICE_PROFILES.opc.id).toBe("opc");
    expect(CHOICE_PROFILES.enterprise.id).toBe("enterprise");
  });

  it("maps each shell to the profile of the same name", () => {
    expect(PROFILE_FOR_SHELL).toEqual({ opc: "opc", enterprise: "enterprise" });
  });

  it("has the two kinds Everyday and Reasoning", () => {
    expect(CHOICE_KINDS).toEqual(["everyday", "reasoning"]);
  });

  it("seeds Everyday with the fast list first, then the head of the chat default list, each id once", () => {
    expect(gatewayRefs(CHOICE_PROFILES.opc, "everyday").map((ref) => ref.model)).toEqual([
      "deepseek-v4-1-flash",
      "gpt-6-luna",
      "claude-haiku-5-5",
      "qwen3.8-flash",
      "claude-sonnet-5-5",
    ]);
  });

  it("gives every Everyday candidate an explicit effort: Off for the fast list, medium for the chat default head", () => {
    expect(gatewayRefs(CHOICE_PROFILES.opc, "everyday").map((ref) => [ref.model, ref.effort])).toEqual([
      ["deepseek-v4-1-flash", "none"],
      ["gpt-6-luna", "none"],
      ["claude-haiku-5-5", "none"],
      ["qwen3.8-flash", "none"],
      ["claude-sonnet-5-5", "medium"],
    ]);
  });

  it("seeds Reasoning with the reasoning list, each candidate at high", () => {
    expect(gatewayRefs(CHOICE_PROFILES.opc, "reasoning").map((ref) => [ref.model, ref.effort])).toEqual([
      ["claude-opus-5-5", "high"],
      ["gpt-6-astra", "high"],
      ["deepseek-v4-pro", "high"],
      ["qwen3.8-max", "high"],
    ]);
  });

  it("seeds enterprise exactly like opc today", () => {
    expect(CHOICE_PROFILES.enterprise.lists).toEqual(CHOICE_PROFILES.opc.lists);
  });
});

describe.each(CHOICE_PROFILE_IDS)("choice profile %s guards", (profileId) => {
  const profile = CHOICE_PROFILES[profileId];

  it("has a non-empty list for the pinned gateway provider in both kinds", () => {
    expect(gatewayRefs(profile, "everyday").length).toBeGreaterThan(0);
    expect(gatewayRefs(profile, "reasoning").length).toBeGreaterThan(0);
  });

  it("has no id twice in one list", () => {
    for (const kind of CHOICE_KINDS) {
      const models = gatewayRefs(profile, kind).map((ref) => ref.model);
      expect(new Set(models).size).toBe(models.length);
    }
  });

  it("names only models the policy table knows", () => {
    for (const { ref } of allRefs(profile)) {
      expect(modelPolicy(ref.model).known).toBe(true);
    }
  });

  it("gives each candidate an effort its wire accepts", () => {
    for (const { ref } of allRefs(profile)) {
      const wire = resolveChatWire("auto", ref.model);
      expect(allowedReasoningEfforts(ref.model, { wire })).toContain(ref.effort);
    }
  });

  it("keeps every Everyday candidate at none, low or medium after the host's coercion", () => {
    for (const ref of gatewayRefs(profile, "everyday")) {
      expect(["none", "low", "medium"]).toContain(coerceReasoningEffortForModel(ref.model, ref.effort));
    }
  });

  it("keeps every Reasoning candidate at high or above after the host's coercion", () => {
    for (const ref of gatewayRefs(profile, "reasoning")) {
      expect(["high", "xhigh", "max", "ultra"]).toContain(coerceReasoningEffortForModel(ref.model, ref.effort));
    }
  });
});
