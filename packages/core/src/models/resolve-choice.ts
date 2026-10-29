import { resolveChatWire } from "../runtime/chat-wire";
import { allowedReasoningEfforts } from "../runtime/effort-allowlist";
import type { InputModality } from "../tenancy/types";
import type { ChoiceKind, ChoiceProfile } from "./choice-profiles";
import type { CustomChoiceRequest, CustomEffort, RanChoice } from "./model-choice";
import { modelPolicy } from "./model-policy";
import { coerceReasoningEffortForModel, type ReasoningEffort } from "./reasoning-effort";

export type ChoiceCatalogModel = Readonly<{ id: string; inputModalities: readonly InputModality[] }>;

export type ResolveRequest =
  | Readonly<{ kind: "auto"; pick: ChoiceKind }>
  | Readonly<{ kind: ChoiceKind }>
  | CustomChoiceRequest;

export type ResolveChoiceInput = Readonly<{
  request: ResolveRequest;
  profile: ChoiceProfile;
  catalog: readonly ChoiceCatalogModel[];
  isDown: (model: string) => boolean;
  modality: InputModality;
}>;

export type ChoiceResolutionError =
  | "choice_unavailable"
  | "custom_model_not_allowed"
  | "custom_effort_invalid"
  | "custom_model_unavailable";

export type ResolvedChoice = Readonly<{
  ok: true;
  ran: RanChoice;
  model: string;
  effort: ReasoningEffort | "default";
  crossedOver: boolean;
}>;

export type ChoiceResolution = ResolvedChoice | Readonly<{ ok: false; error: ChoiceResolutionError }>;

type WalkInput = Pick<ResolveChoiceInput, "profile" | "catalog" | "isDown" | "modality">;

function sameModel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function canRead(model: ChoiceCatalogModel, modality: InputModality): boolean {
  return modality === "text" || model.inputModalities.includes(modality);
}

function unavailable(error: ChoiceResolutionError): ChoiceResolution {
  return Object.freeze({ ok: false, error });
}

function firstFit(input: WalkInput, kind: ChoiceKind): ResolvedChoice | undefined {
  for (const refs of Object.values(input.profile.lists[kind])) {
    for (const ref of refs ?? []) {
      const entry = input.catalog.find((model) => sameModel(model.id, ref.model));
      if (entry && canRead(entry, input.modality) && !input.isDown(entry.id)) {
        return Object.freeze({
          ok: true,
          ran: kind,
          model: entry.id,
          effort: coerceReasoningEffortForModel(entry.id, ref.effort),
          crossedOver: false,
        });
      }
    }
  }
  return undefined;
}

function resolveAuto(input: WalkInput, pick: ChoiceKind): ChoiceResolution {
  const first = firstFit(input, pick);
  if (first) {
    return first;
  }
  const other: ChoiceKind = pick === "everyday" ? "reasoning" : "everyday";
  const crossed = firstFit(input, other);
  return crossed ? Object.freeze({ ...crossed, crossedOver: true }) : unavailable("choice_unavailable");
}

function customEffortAllowed(model: string, effort: CustomEffort): boolean {
  if (effort === "default") {
    return true;
  }
  return (
    modelPolicy(model).known &&
    allowedReasoningEfforts(model, { wire: resolveChatWire("auto", model) }).includes(effort)
  );
}

function resolveCustom(input: WalkInput, request: CustomChoiceRequest): ChoiceResolution {
  const entry = input.catalog.find((model) => sameModel(model.id, request.model));
  if (!entry) {
    return unavailable("custom_model_not_allowed");
  }
  if (!customEffortAllowed(entry.id, request.effort)) {
    return unavailable("custom_effort_invalid");
  }
  if (input.isDown(entry.id)) {
    return unavailable("custom_model_unavailable");
  }
  return Object.freeze({ ok: true, ran: "custom", model: entry.id, effort: request.effort, crossedOver: false });
}

export function resolveChoice(input: ResolveChoiceInput): ChoiceResolution {
  const { request } = input;
  if (request.kind === "custom") {
    return resolveCustom(input, request);
  }
  if (request.kind === "auto") {
    return resolveAuto(input, request.pick);
  }
  return firstFit(input, request.kind) ?? unavailable("choice_unavailable");
}
