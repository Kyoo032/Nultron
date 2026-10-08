import { ApiError } from "../errors";
import type { InputModality } from "../tenancy/types";
import { modelImageInput } from "./image-input";
import { mediaKind } from "./media-kind";

export type ModelModalities = {
  text: true;
  image: boolean;
  video: boolean;
};

const DEFAULT: ModelModalities = { text: true, image: false, video: false };

const BY_PREFIX: Array<{ prefix: string; caps: ModelModalities }> = [
  { prefix: "default", caps: { text: true, image: true, video: true } },
  { prefix: "deepseek", caps: { text: true, image: true, video: false } },
  { prefix: "kimi", caps: { text: true, image: true, video: false } },
  { prefix: "glm", caps: { text: true, image: true, video: false } },
  { prefix: "gemini", caps: { text: true, image: true, video: true } },
  { prefix: "gemma", caps: { text: true, image: true, video: false } },
  { prefix: "doubao-seedance", caps: { text: true, image: true, video: true } },
  { prefix: "doubao", caps: { text: true, image: true, video: true } },
  { prefix: "seedance", caps: { text: true, image: true, video: true } },
  { prefix: "gpt-5", caps: { text: true, image: true, video: false } },
  { prefix: "gpt-4o", caps: { text: true, image: true, video: false } },
  { prefix: "gpt-4.1", caps: { text: true, image: true, video: false } },
  { prefix: "gpt-4", caps: { text: true, image: true, video: false } },
  { prefix: "claude", caps: { text: true, image: true, video: false } },
  { prefix: "o4", caps: { text: true, image: true, video: false } },
  { prefix: "o3", caps: { text: true, image: true, video: false } },
  { prefix: "o1", caps: { text: true, image: false, video: false } },
  { prefix: "ep-", caps: { text: true, image: true, video: false } },
];

export function getModelModalities(model: string): ModelModalities {
  const match = BY_PREFIX.find((entry) => model.toLowerCase().startsWith(entry.prefix));
  const caps = match?.caps ?? DEFAULT;
  // A Chat model's image answer is `modelImageInput`'s where that has one. The prefix list above called every
  // `glm-` and `deepseek-` id vision-capable (`glm-5.3` and `deepseek-v4-pro` are text-only) and no `gpt-6-`
  // id (they read images), so a known yes or no replaces it. Where the rule has no line ("unknown") the
  // prefix answer stands, as it did before the rule existed: job regeneration still checks this table
  // strictly, and a model the person hand-picked for a section must not start to be refused. A generator
  // keeps its prefix answer: for a video model "image" means the still it animates, a different question.
  if (mediaKind(model) !== "chat") {
    return caps;
  }
  const support = modelImageInput(model);
  return { ...caps, image: support === "yes" || (support === "unknown" && caps.image) };
}

export function assertModelSupportsModality(model: string, modality: InputModality): void {
  if (modality === "text") {
    return;
  }
  const caps = getModelModalities(model);
  if (!caps[modality]) {
    throw new ApiError("model_missing_modality", `Model '${model}' does not support ${modality} input`, 400);
  }
}

/**
 * The Chat form of the check above. Chat sends an image to a model it has no line for (the gateway's
 * list moves faster than ours; the person is told before they send, and a refusal from the gateway is
 * shown as one), and refuses only a model known to be text-only. Video keeps the strict rule.
 */
export function assertChatModelAcceptsModality(model: string, modality: InputModality): void {
  if (modality === "image") {
    if (modelImageInput(model) === "no") {
      throw new ApiError("model_missing_modality", `Model '${model}' does not support image input`, 400);
    }
    return;
  }
  assertModelSupportsModality(model, modality);
}

export function assertAgentSupportsModality(inputModalities: InputModality[], modality: InputModality): void {
  if (!inputModalities.includes(modality)) {
    throw new ApiError("modality_not_enabled", `This agent does not accept ${modality} input`, 400);
  }
}

export const RUN_PATHS = {
  text: "/api/v1/threads/{threadId}/runs/text",
  image: "/api/v1/threads/{threadId}/runs/image",
  video: "/api/v1/threads/{threadId}/runs/video",
} as const;
