export const MODEL_CHOICES = Object.freeze(["auto", "everyday", "reasoning", "custom"] as const);

export type ModelChoiceId = (typeof MODEL_CHOICES)[number];

export const DEFAULT_MODEL_CHOICE = "auto" as const;

export const PRESET_CHOICES = Object.freeze(["auto", "everyday", "reasoning"] as const);

export type PresetChoiceId = (typeof PRESET_CHOICES)[number];

export const CUSTOM_EFFORTS = Object.freeze(["default", "low", "medium", "high"] as const);

export type CustomEffort = (typeof CUSTOM_EFFORTS)[number];

export type PresetChoiceRequest = Readonly<{ kind: PresetChoiceId }>;

export type CustomChoiceRequest = Readonly<{ kind: "custom"; model: string; effort: CustomEffort }>;

export type ModelChoiceRequest = PresetChoiceRequest | CustomChoiceRequest;

export const CHOICE_REQUEST_ERRORS = Object.freeze([
  "unknown_choice",
  "custom_model_required",
  "custom_effort_invalid",
] as const);

export type ChoiceRequestError = (typeof CHOICE_REQUEST_ERRORS)[number];

export type ChoiceRequestResult =
  | Readonly<{ ok: true; request: ModelChoiceRequest }>
  | Readonly<{ ok: false; error: ChoiceRequestError }>;

const LEGACY_TIER_CHOICES = new Map<string, PresetChoiceId>([
  ["daily", "auto"],
  ["fast", "everyday"],
  ["reasoning", "reasoning"],
]);

export function legacyTierToChoice(tier: unknown): PresetChoiceId | undefined {
  return typeof tier === "string" ? LEGACY_TIER_CHOICES.get(tier) : undefined;
}

export const RAN_CHOICES = Object.freeze(["everyday", "reasoning", "custom"] as const);

export type RanChoice = (typeof RAN_CHOICES)[number];

export type RunChoiceLabel = Readonly<{
  requested: ModelChoiceId;
  ran: RanChoice;
  thinking: boolean;
  model?: string;
  effort?: CustomEffort;
}>;

function isPresetChoice(value: unknown): value is PresetChoiceId {
  return typeof value === "string" && (PRESET_CHOICES as readonly string[]).includes(value);
}

function isCustomEffort(value: unknown): value is CustomEffort {
  return typeof value === "string" && (CUSTOM_EFFORTS as readonly string[]).includes(value);
}

function readCustomChoice(value: object): ChoiceRequestResult {
  const { model, effort } = value as { model?: unknown; effort?: unknown };
  const trimmed = typeof model === "string" ? model.trim() : "";
  if (trimmed === "") {
    return Object.freeze({ ok: false, error: "custom_model_required" });
  }
  if (!isCustomEffort(effort)) {
    return Object.freeze({ ok: false, error: "custom_effort_invalid" });
  }
  return Object.freeze({ ok: true, request: Object.freeze({ kind: "custom", model: trimmed, effort }) });
}

export function readChoiceRequest(value: unknown): ChoiceRequestResult {
  if (value === undefined || value === null) {
    return Object.freeze({ ok: true, request: Object.freeze({ kind: DEFAULT_MODEL_CHOICE }) });
  }
  if (isPresetChoice(value)) {
    return Object.freeze({ ok: true, request: Object.freeze({ kind: value }) });
  }
  if (value === "custom") {
    return Object.freeze({ ok: false, error: "custom_model_required" });
  }
  if (typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "custom") {
    return readCustomChoice(value);
  }
  return Object.freeze({ ok: false, error: "unknown_choice" });
}
