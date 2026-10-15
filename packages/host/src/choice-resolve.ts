import {
  ApiError,
  attachmentCountOf,
  readOptionalModel,
  typedTextOf,
  type InputModality,
  type ReasoningEffort,
  type ReasoningEffortChoice,
  type TenantContext,
} from "@agentforge/core";
import {
  legacyTierToChoice,
  readChoiceRequest,
  type ChoiceRequestError,
  type ChoiceRequestResult,
  type ModelChoiceId,
  type ModelChoiceRequest,
  type RanChoice,
} from "@agentforge/core/model-choice";
import { CHOICE_PROFILES, PROFILE_FOR_SHELL, type ChoiceProfile } from "@agentforge/core/choice-profiles";
import { decideAuto, estimateContextTokens, type AutoInput, type AutoReason } from "@agentforge/core/auto-choice";
import { resolveChoice, type ChoiceResolution, type ChoiceResolutionError } from "@agentforge/core/resolve-choice";
import { allowanceFor, catalogFor, type ModelAllowance } from "./model-allowance";
import { isJobModelDown } from "./job-model-fallback";
import { messageText } from "./message-text";
import { listMessages } from "./threads";
import type { SelectableModel } from "./selectable-models";
import { resolvedShell, type ShellKind } from "./shell-setting";

const CHOICE_FIELD = "choice";
const LEGACY_TIER_FIELD = "tier";
const MODEL_DEFAULT_EFFORT: ReasoningEffort = "medium";
const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(["image_url", "video_url"]);
const CONVERSATION_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);

const CHOICE_REQUEST_MESSAGES: Readonly<Record<ChoiceRequestError, string>> = Object.freeze({
  unknown_choice: "choice must be auto, everyday, reasoning or custom",
  custom_model_required: "A custom choice needs a model id",
  custom_effort_invalid: "effort must be model default, low, medium or high",
});

const RESOLUTION_FAILURES: Readonly<
  Record<Exclude<ChoiceResolutionError, "choice_unavailable">, Readonly<{ status: number; message: string }>>
> = Object.freeze({
  custom_model_not_allowed: { status: 403, message: "That model is not available to this account" },
  custom_effort_invalid: { status: 400, message: "That effort is not available for this model" },
  custom_model_unavailable: { status: 503, message: "That model is not answering right now" },
});

export type HostAutoReason = AutoReason | "pick_unavailable";

export type ThreadContext = Readonly<{ texts: readonly string[]; imageCount: number }>;

export type RunChoiceInput = Readonly<{
  request: ModelChoiceRequest;
  tenant: TenantContext;
  modality: InputModality;
  currentText?: string;
  history?: ThreadContext;
  shell?: ShellKind;
  allowance?: ModelAllowance;
  now?: number;
}>;

export type RunChoiceResolution = Readonly<{
  requested: ModelChoiceId;
  ran: RanChoice;
  model: string;
  reasoning: ReasoningEffortChoice;
  autoReason?: HostAutoReason;
}>;

type Walk = Readonly<{
  profile: ChoiceProfile;
  catalog: readonly SelectableModel[];
  isDown: (model: string) => boolean;
  modality: InputModality;
}>;

const NO_HISTORY: ThreadContext = Object.freeze({ texts: Object.freeze([]), imageCount: 0 });

export class ChoiceUnavailableError extends ApiError {
  readonly choice: ModelChoiceId;

  constructor(choice: ModelChoiceId) {
    super("choice_unavailable", "No model is available for this choice right now", 503);
    this.choice = choice;
  }
}

function bodyField(body: unknown, field: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return value === null ? undefined : value;
}

function choiceAndModelError(): ApiError {
  return new ApiError("choice_and_model", "Send one of choice, tier or model", 400);
}

function requestOrThrow(result: ChoiceRequestResult): ModelChoiceRequest {
  if (result.ok) {
    return result.request;
  }
  throw new ApiError(result.error, CHOICE_REQUEST_MESSAGES[result.error], 400);
}

function legacyTierRequest(tier: unknown): ModelChoiceRequest {
  const preset = legacyTierToChoice(tier);
  if (preset === undefined) {
    throw new ApiError("unknown_choice", CHOICE_REQUEST_MESSAGES.unknown_choice, 400);
  }
  return { kind: preset };
}

export function readRunChoice(body: unknown): ModelChoiceRequest | null {
  const choice = bodyField(body, CHOICE_FIELD);
  const tier = bodyField(body, LEGACY_TIER_FIELD);
  if (choice === undefined && tier === undefined) {
    return null;
  }
  const model = readOptionalModel(body);
  if (choice !== undefined) {
    if (tier !== undefined || model !== undefined) {
      throw choiceAndModelError();
    }
    return requestOrThrow(readChoiceRequest(choice));
  }
  if (model !== undefined) {
    throw choiceAndModelError();
  }
  return legacyTierRequest(tier);
}

export function choiceProfileFor(shell: ShellKind = resolvedShell()): ChoiceProfile {
  return CHOICE_PROFILES[PROFILE_FOR_SHELL[shell]];
}

function reasoningOf(effort: ReasoningEffort | "default"): ReasoningEffortChoice {
  return effort === "default" ? { effort: MODEL_DEFAULT_EFFORT, explicit: false } : { effort, explicit: true };
}

function resolutionFailure(choice: ModelChoiceId, error: ChoiceResolutionError): ApiError {
  if (error === "choice_unavailable") {
    return new ChoiceUnavailableError(choice);
  }
  const failure = RESOLUTION_FAILURES[error];
  return new ApiError(error, failure.message, failure.status);
}

function settle(
  requested: ModelChoiceId,
  resolution: ChoiceResolution,
  autoReason?: HostAutoReason,
): RunChoiceResolution {
  if (!resolution.ok) {
    throw resolutionFailure(requested, resolution.error);
  }
  return {
    requested,
    ran: resolution.ran,
    model: resolution.model,
    reasoning: reasoningOf(resolution.effort),
    ...(autoReason === undefined ? {} : { autoReason }),
  };
}

function contextLengthOf(catalog: readonly SelectableModel[], model: string): number | null {
  const length = catalog.find((row) => row.id === model)?.contextLength;
  return typeof length === "number" && Number.isFinite(length) ? length : null;
}

function autoInputOf(input: RunChoiceInput, everydayWindow: number | null): AutoInput {
  const text = input.currentText ?? "";
  const history = input.history ?? NO_HISTORY;
  const media = input.modality === "text" ? 0 : 1;
  return {
    typedText: typedTextOf(text),
    attachmentCount: attachmentCountOf(text) + media,
    contextTokens: estimateContextTokens([...history.texts, text], history.imageCount + media),
    everydayWindow,
  };
}

function resolveAuto(walk: Walk, input: RunChoiceInput): RunChoiceResolution {
  const everyday = resolveChoice({ ...walk, request: { kind: "everyday" } });
  const everydayWindow = everyday.ok ? contextLengthOf(walk.catalog, everyday.model) : null;
  const decision = decideAuto(autoInputOf(input, everydayWindow));
  const resolution = resolveChoice({ ...walk, request: { kind: "auto", pick: decision.pick } });
  const reason: HostAutoReason = resolution.ok && resolution.crossedOver ? "pick_unavailable" : decision.reason;
  return settle("auto", resolution, reason);
}

export function resolveRunChoice(input: RunChoiceInput): RunChoiceResolution {
  const now = input.now ?? Date.now();
  const walk: Walk = {
    profile: choiceProfileFor(input.shell),
    catalog: catalogFor(input.tenant, input.allowance ?? allowanceFor(input.tenant)),
    isDown: (model) => isJobModelDown(model, now, input.tenant),
    modality: input.modality,
  };
  const { request } = input;
  switch (request.kind) {
    case "custom":
      return settle("custom", resolveChoice({ ...walk, request }));
    case "auto":
      return resolveAuto(walk, input);
    case "everyday":
    case "reasoning":
      return settle(request.kind, resolveChoice({ ...walk, request: { kind: request.kind } }));
  }
}

function mediaPartCount(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter(
    (part) =>
      typeof part === "object" && part !== null && MEDIA_PART_TYPES.has(String((part as { type?: unknown }).type)),
  ).length;
}

export async function readThreadContext(tenant: TenantContext, threadId: string): Promise<ThreadContext> {
  const rows = (await listMessages(tenant, threadId)).filter((row) => CONVERSATION_ROLES.has(row.role));
  return {
    texts: rows.map((row) => messageText(row.content)),
    imageCount: rows.reduce((total, row) => total + mediaPartCount(row.content), 0),
  };
}
