import { GATEWAY_PROVIDER_ID } from "../providers/gateway-id";
import type { ProviderId } from "../providers/registry";
import { CHAT_DEFAULT_PREFERENCES } from "./preferred";
import type { ReasoningEffort } from "./reasoning-effort";

export const CHOICE_KINDS = Object.freeze(["everyday", "reasoning"] as const);

export type ChoiceKind = (typeof CHOICE_KINDS)[number];

export const CHOICE_PROFILE_IDS = Object.freeze(["opc", "enterprise"] as const);

export type ChoiceProfileId = (typeof CHOICE_PROFILE_IDS)[number];

export type CandidateRef = Readonly<{ model: string; effort: ReasoningEffort }>;

export type ChoiceProfile = Readonly<{
  id: ChoiceProfileId;
  lists: Readonly<Record<ChoiceKind, Readonly<Partial<Record<ProviderId, readonly CandidateRef[]>>>>>;
}>;

const EVERYDAY_FAST_IDS = ["deepseek-v4-1-flash", "gpt-6-luna", "gpt-5.6-luna", "deepseek-v4-flash"] as const;

const EVERYDAY_HEAD_LENGTH = 3;

const REASONING_IDS = ["claude-opus-5-5", "gpt-6-astra", "gpt-5.6-sol", "kimi-k3"] as const;

function withoutRepeats(refs: readonly CandidateRef[]): CandidateRef[] {
  const seen = new Set<string>();
  const kept: CandidateRef[] = [];
  for (const ref of refs) {
    if (!seen.has(ref.model)) {
      seen.add(ref.model);
      kept.push(ref);
    }
  }
  return kept;
}

const EVERYDAY_GATEWAY: readonly CandidateRef[] = Object.freeze(
  withoutRepeats([
    ...EVERYDAY_FAST_IDS.map((model) => ({ model, effort: "none" as const })),
    ...CHAT_DEFAULT_PREFERENCES.slice(0, EVERYDAY_HEAD_LENGTH).map((model) => ({
      model,
      effort: "medium" as const,
    })),
  ]),
);

const REASONING_GATEWAY: readonly CandidateRef[] = Object.freeze(
  REASONING_IDS.map((model) => ({ model, effort: "high" as const })),
);

function gatewayOnly(refs: readonly CandidateRef[]): Readonly<Partial<Record<ProviderId, readonly CandidateRef[]>>> {
  return Object.freeze({ [GATEWAY_PROVIDER_ID]: refs });
}

function profileFor(id: ChoiceProfileId): ChoiceProfile {
  return Object.freeze({
    id,
    lists: Object.freeze({
      everyday: gatewayOnly(EVERYDAY_GATEWAY),
      reasoning: gatewayOnly(REASONING_GATEWAY),
    }),
  });
}

export const CHOICE_PROFILES: Readonly<Record<ChoiceProfileId, ChoiceProfile>> = Object.freeze({
  opc: profileFor("opc"),
  enterprise: profileFor("enterprise"),
});

export const PROFILE_FOR_SHELL: Readonly<Record<ChoiceProfileId, ChoiceProfileId>> = Object.freeze({
  opc: "opc",
  enterprise: "enterprise",
});
