import { ApiError } from "../errors";
import { parseAppLocale, type AppLocale } from "../locale";
import { modelNotOnKeyMessage, resolveVideoModelForKey } from "../models/key-models";
import {
  settleVideo,
  videoSpecFor,
  type MediaAdjustment,
  type PublishedMediaParams,
  type VideoSent,
} from "../models/media-params";
import { modeMessage } from "../mode-messages";
import { withOutputLanguage } from "../output-language";
import { maskPii } from "../security/pii";
import { VIDEO_JOB_PENDING_CODE } from "./job-pending";

/**
 * The five skills of the Videos mode, read by `harness/modes/videos.ts`. Three are wired here
 * (`new`): write the shot, render once more, keep the clip. The model list, the length snap and a
 * still the model cannot take stay as they were (`has`), and the cost line stays in the studio.
 * `keep-clip` carries what "bill the snapped length" and "keep the gallery" used to name: the clip
 * is kept, billed and captioned at the length and shot the harness asked for.
 */
export const VIDEO_HARNESS_SKILLS = [
  { id: "write-shot", name: "Write the shot", status: "new" },
  { id: "start-from-still", name: "Start from a still", status: "has" },
  { id: "estimate-and-tighten", name: "Estimate the cost and tighten the prompt", status: "has" },
  { id: "render-retry", name: "Render once more when the job dies", status: "new" },
  { id: "keep-clip", name: "Keep the clip at the billed length", status: "new" },
] as const;

export type VideoHarnessSkillId = (typeof VIDEO_HARNESS_SKILLS)[number]["id"];

/** The skills a run exercised, in order. A run that never retried has no `render-retry`. */
export type VideoHarnessSkill = "write-shot" | "render-retry" | "keep-clip";

export type VideoRenderCall = {
  prompt: string;
  /** Absent when the model has no aspect control. */
  aspect_ratio?: string;
  image_url?: string;
  model: string;
  seconds: number;
  /** Absent when the model has no resolution control. */
  resolution?: string;
  /** Sound inside the clip; absent when the model has no switch for it. */
  audio?: boolean;
};

export type VideoRenderResult =
  | { ok: true; url: string; model: string }
  | { ok: false; message: string; code: string; status: number; suggestModel?: string };

export type VideoHarnessInput = {
  prompt: string;
  requestedModel: string;
  availableIds: readonly string[];
  /** A ratio such as `16:9`; the model's own set decides which are valid. */
  aspect?: string;
  imageUrl?: string;
  seconds?: number;
  resolution?: string;
  /** Sound inside the clip. Left out means the app's default (off). */
  audio?: boolean;
  /** What the gateway published for the model, laid over the built-in spec. */
  published?: PublishedMediaParams;
  locale: AppLocale;
  /**
   * A shot from outside the composer. Production leaves this empty.
   * Tests pass one that drops the sentence so the repair runs.
   */
  draftShot?: string;
};

export type VideoHarnessResult = {
  shot: string;
  shotRepaired: boolean;
  model: string;
  seconds: number;
  /** What the request carries after the model's spec had its say. */
  sent: VideoSent;
  /** What was asked for and moved or left out. */
  adjusted: MediaAdjustment[];
  outboundPrompt: string;
  url: string;
  usedModel: string;
  skills: VideoHarnessSkill[];
  attempts: number;
};

const CAMERA = /\b(camera|close-up|close up|wide shot|dolly|push-in|push in|tracking shot|steadicam|lens)\b/i;
const MOTION =
  /\b(moves?|moving|motion|walks?|holds?|holding|drifts?|drift|pans?|tilts?|tracks?|tracking|falls?|falling|pours?|turns?|turning)\b/i;

/** A prompt that already names a camera and a motion, or is already a full brief. */
export function promptAlreadyShot(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length >= 400) {
    return true;
  }
  return CAMERA.test(text) && MOTION.test(text);
}

/** One shot from a sentence: the sentence stays, plus one motion and one camera. */
export function composeVideoShot(prompt: string): string {
  const ask = prompt.trim();
  if (promptAlreadyShot(ask)) {
    return ask;
  }
  return [
    `Subject: ${ask}`,
    "Motion: one continuous action that follows the subject, and nothing else.",
    "Camera: one steady shot.",
    "Do not add people, places, or objects the subject line did not name.",
  ].join("\n");
}

/** The owner's sentence is still in the shot. */
export function shotKeepsAsk(shot: string, prompt: string): boolean {
  const ask = prompt.trim().toLowerCase();
  return ask.length > 0 && shot.toLowerCase().includes(ask);
}

/**
 * Check the shot. If it dropped the sentence, repair once with the composed shot.
 */
export function acceptVideoShot(prompt: string, draft?: string): { shot: string; repaired: boolean } {
  const candidate = draft?.trim() ? draft.trim() : composeVideoShot(prompt);
  if (shotKeepsAsk(candidate, prompt)) {
    return { shot: candidate, repaired: false };
  }
  const repaired = composeVideoShot(prompt);
  if (shotKeepsAsk(repaired, prompt)) {
    return { shot: repaired, repaired: true };
  }
  const ask = prompt.trim();
  return {
    shot: `Subject: ${ask}\nMotion: one continuous action that follows the subject, and nothing else.\nCamera: one steady shot.`,
    repaired: true,
  };
}

// The last two are the words of `videoJobPending` (`mode-messages.ts`): a job the gateway still has. Sent
// again, it would be billed twice. The code (`VIDEO_JOB_PENDING_CODE`) is what the harness reads first;
// these keep a caller that only passes the message on the safe side.
const NO_RETRY =
  /gateway key|rejected the API key|not available for this key|does not accept a still|prepaid|按次价格|预付账户|model_not_on_key|may still finish and be billed|mungkin tetap selesai dan ditagih/i;

const RETRY =
  /timed out|timeout|HTTP 50[234]|no live gateway channel|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|returned no video/i;

/**
 * A dead render is worth one more try. A refused key, model, or still is not, and neither is a job the
 * gateway accepted and is still rendering: the first one will bill when it finishes.
 */
export function videoRenderShouldRetry(message: string): boolean {
  if (NO_RETRY.test(message)) {
    return false;
  }
  return RETRY.test(message);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i;

/** A playable clip address. A still, or anything that is not a URL, is not a clip. */
export function clipIsVideoUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (/^data:image\//i.test(trimmed)) {
    return false;
  }
  if (/^data:video\//i.test(trimmed)) {
    return true;
  }
  if (!/^https?:\/\//i.test(trimmed) && !/^\/api\/v1\/media\//i.test(trimmed)) {
    return false;
  }
  if (IMAGE_EXT.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Videos harness: write the shot, fit the listed model and snapped length, refuse a still
 * the model cannot take, render once more when the job dies before a video file, then keep
 * that file at the billed length.
 */
export async function runVideoHarness(
  input: VideoHarnessInput,
  render: (call: VideoRenderCall) => Promise<VideoRenderResult>,
): Promise<VideoHarnessResult> {
  const locale = parseAppLocale(input.locale);
  const skills: VideoHarnessSkill[] = [];
  const accepted = acceptVideoShot(input.prompt, input.draftShot);
  skills.push("write-shot");

  const choice = resolveVideoModelForKey({
    requested: input.requestedModel,
    availableIds: input.availableIds,
  });
  if (!choice.ok) {
    throw new ApiError(
      "model_not_on_key",
      modelNotOnKeyMessage(locale, choice.rejected, choice.suggestion),
      400,
      choice.suggestion,
    );
  }
  const model = choice.model;
  const spec = videoSpecFor(model, input.published);
  if (input.imageUrl && !spec.imageInput.firstFrame) {
    throw new ApiError("video_still_unsupported", modeMessage("videoStillUnsupported", locale), 400);
  }
  // Settled here, before any money is spent: a value the model does not take is moved to the nearest
  // one it does, and sound asked of a silent model is refused.
  const { adjustments, ...sent } = settleVideo(
    spec,
    { aspect: input.aspect, seconds: input.seconds, resolution: input.resolution, audio: input.audio },
    { model, locale },
  );
  const seconds = sent.seconds;
  const outboundPrompt = withOutputLanguage(maskPii(accepted.shot), "videos", locale);
  const call: VideoRenderCall = {
    prompt: outboundPrompt,
    ...(sent.aspect ? { aspect_ratio: sent.aspect } : {}),
    model,
    seconds,
    ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
    ...(sent.resolution ? { resolution: sent.resolution } : {}),
    ...(sent.audio !== undefined ? { audio: sent.audio } : {}),
  };

  let attempts = 0;
  let lastFailure: Extract<VideoRenderResult, { ok: false }> | null = null;
  let url: string | null = null;
  let usedModel = model;

  while (attempts < 2) {
    attempts += 1;
    const result = await render(call);
    if (result.ok && clipIsVideoUrl(result.url)) {
      url = result.url.trim();
      usedModel = result.model.trim() || model;
      break;
    }
    const missingFile = result.ok;
    lastFailure = missingFile
      ? {
          ok: false,
          message: modeMessage("videoClipRejected", locale),
          code: "video_clip_rejected",
          status: 502,
        }
      : result;
    // A job still rendering at the gateway is never submitted again, whatever its message says.
    const stillRendering = !result.ok && result.code === VIDEO_JOB_PENDING_CODE;
    const retryable = missingFile || (!stillRendering && videoRenderShouldRetry(result.ok ? "" : result.message));
    if (attempts === 2 || !retryable) {
      break;
    }
    skills.push("render-retry");
  }

  if (!url) {
    const failure = lastFailure ?? {
      ok: false as const,
      message: modeMessage("videoGenerateFailed", locale),
      code: "tool_failed",
      status: 400,
    };
    throw new ApiError(failure.code, failure.message, failure.status, failure.suggestModel);
  }
  skills.push("keep-clip");
  return {
    shot: accepted.shot,
    shotRepaired: accepted.repaired,
    model,
    seconds,
    sent,
    adjusted: adjustments,
    outboundPrompt,
    url,
    usedModel,
    skills,
    attempts,
  };
}
