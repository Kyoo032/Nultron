import { z } from "zod";
import {
  ApiError,
  buildToolSecretScope,
  gatewayRequiredMessage,
  imageGenerateTool,
  isMusicModelId,
  isOmniSpeechModelId,
  isSpeechModelId,
  listToolRoutes,
  lyricsWriteTool,
  maskPii,
  mediaKind,
  publishedMediaParamsFor,
  preferLyricDraft,
  resolveSongTitle,
  shouldRetryLyrics,
  shouldRetryMusicJob,
  stripMusicLanguageRule,
  modeMessage,
  musicCapabilities,
  musicGenerateTool,
  availableVideoDefault,
  pickPreferredImageModel,
  pickPreferredMusicModel,
  ratioOf,
  rewriteModelNotOnKey,
  resolveMusicMode,
  runWithToolSecrets,
  shapeOfRatio,
  speechUnavailableReason,
  studioVideoFailureStatus,
  VIDEO_JOB_PENDING_CODE,
  VIDEO_JOB_PENDING_STATUS,
  videoCapabilities,
  videoGenerateTool,
  withOutputLanguage,
  runVideoHarness,
  type VideoRenderCall,
  type VideoRenderResult,
  MUSIC_LYRICS_MAX,
  MUSIC_PROMPT_MAX,
  MUSIC_STYLE_MAX,
  MUSIC_TITLE_MAX,
  type ChatModel,
  type GatewayTrack,
  type ImageSent,
  type MediaAdjustment,
  type MusicMode,
  type VideoSent,
  type SpeechUnavailableReason,
  type TenantContext,
} from "@agentforge/core";
import { ImageModelRejectedError, runImageSkills } from "@agentforge/core/images";
import { mediaReferenceId } from "@agentforge/core/tools/media-reference";
import { loadSettings } from "./settings-store";
import { loadModelCache, type ModelCacheScope } from "./model-cache";
import { catalogOfCache, dropRefusedIds } from "./model-availability";
import {
  listImageModels,
  listMusicModels,
  listProbedVideoModels,
  listSpeechModels,
  withRelayMusicModels,
} from "./selectable-models";
import { mediaIdFromUrl } from "./media-id";
import { getStudioMediaMeta, saveStudioMediaMeta, type StudioMediaMeta } from "./studio-media-meta";
import { upsertWorkSource } from "./knowledge-ingest";
import { mediaWorkCard, musicWorkCard } from "./work-cards";
import type { WorkSourceType } from "./knowledge";
import { imageGenerateFailedMessage, imageModelRejectedMessage, withImageOutputLanguage } from "./image-output-locale";
import { localeForRun } from "./run-context";
import { recordImageUsage, recordMusicUsage, recordVideoUsage } from "./usage-record";

export type StudioGenerateOptions = {
  /** Knowledge source type for the work card. Defaults to Images / Videos; Edit passes "Edit". */
  workType?: Extract<WorkSourceType, "Images" | "Videos" | "Edit">;
};

export type VideoGenerateOptions = StudioGenerateOptions & {
  /** Tests inject the gateway call. Production uses `videoGenerateTool`. */
  renderVideo?: (input: VideoRenderCall) => Promise<unknown>;
};

/** The media kinds a studio gallery can list. Music shares the media store with Images and Videos. */
export type StudioKind = "image" | "video" | "audio";

const httpUrlSchema = z.string().url();

const studioImageSourceSchema = z
  .string()
  .refine((value) => httpUrlSchema.safeParse(value).success || mediaReferenceId(value) !== null, {
    message: "Pass an image URL, or the reference of an image you can see (/api/v1/media/<id>/file or the id).",
  });

/**
 * What a person may ask of an image model. Every field past `prompt` is optional, and none of them is
 * trusted: the model's media parameter spec decides what is sent (`settleImage`), so a value the model
 * does not take is moved to the nearest one it does, and the answer says what was sent.
 */
/** The shapes a media knob can take. A value that is not one of these is a malformed request, not a choice. */
const RATIO_RE = /^\d{1,3}(\.\d+)?:\d{1,3}(\.\d+)?$/;
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const RESOLUTION_RE = /^(\d{3,4}p|\d{1,2}k)$/i;
const TIER_RE = /^\d(\.\d)?k$/i;
const WORD_RE = /^[a-z]{2,12}$/i;

export const imageGenerateBodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required"),
  /** The loose three-way shape. An exact `size` or `aspectRatio` wins over it. */
  aspect: z.enum(["square", "landscape", "portrait"]).optional(),
  model: z.string().trim().min(1).optional(),
  imageUrl: studioImageSourceSchema.optional(),
  /** An exact size such as `1536x1024`. */
  size: z.string().trim().regex(SIZE_RE).optional(),
  /** A ratio such as `3:2`. */
  aspectRatio: z.string().trim().regex(RATIO_RE).optional(),
  quality: z.string().trim().regex(WORD_RE).optional(),
  /** A resolution tier such as `2k`. */
  tier: z.string().trim().regex(TIER_RE).optional(),
  count: z.number().int().min(1).max(4).optional(),
  outputFormat: z.string().trim().regex(WORD_RE).optional(),
});

export const videoGenerateBodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required"),
  /** A ratio such as `16:9`. Left out means the model's own default. */
  aspect: z.string().trim().regex(RATIO_RE).optional(),
  model: z.string().trim().min(1).optional(),
  imageUrl: studioImageSourceSchema.optional(),
  seconds: z.number().int().min(1).max(60).optional(),
  resolution: z.string().trim().regex(RESOLUTION_RE).optional(),
  /** Sound inside the clip. Left out means off. */
  audio: z.boolean().optional(),
});

/**
 * A music job is either a description the model turns into a song, or lyrics the desk wrote with a
 * style and a title. `mode` decides which fields are read; the parser refuses the combination that
 * would submit an empty brief rather than letting the gateway bill for it.
 */
export const musicGenerateBodySchema = z.object({
  mode: z.enum(["describe", "custom"]).optional().default("describe"),
  prompt: z.string().trim().max(MUSIC_PROMPT_MAX).optional(),
  lyrics: z.string().trim().max(MUSIC_LYRICS_MAX).optional(),
  style: z.string().trim().max(MUSIC_STYLE_MAX).optional(),
  title: z.string().trim().max(MUSIC_TITLE_MAX).optional(),
  instrumental: z.boolean().optional().default(false),
  model: z.string().trim().min(1).optional(),
});

export const lyricsWriteBodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required").max(MUSIC_PROMPT_MAX),
  model: z.string().trim().min(1).optional(),
});

export type ImageGenerateBody = z.infer<typeof imageGenerateBodySchema>;
export type VideoGenerateBody = z.infer<typeof videoGenerateBodySchema>;
export type MusicGenerateBody = z.infer<typeof musicGenerateBodySchema>;
export type LyricsWriteBody = z.infer<typeof lyricsWriteBodySchema>;

export type StudioGalleryItem = {
  id: string;
  url: string;
  mime: string;
  createdAt: string;
  prompt?: string;
  aspect?: string;
  model?: string;
  /** Music rows only. */
  title?: string;
  style?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  /**
   * Present (and `true`) only when the row's file is gone from the desk's store, so `GET
   * /api/v1/media/:id/file` would answer 404. The row is still listed: it is the owner's data and
   * nothing here deletes it. The gallery shows a "file missing" tile instead of a player that cannot
   * load. Absent means present, or not checked (the hosted object store is never probed per row).
   */
  fileMissing?: true;
};

export type StudioGenerateResult = {
  id: string | null;
  url: string;
  prompt: string;
  aspect: string;
  model: string;
  /** What the request actually carried after the model's spec had its say (absent off the gateway). */
  sent?: VideoSent | ImageSent;
  /** What was asked for and moved or left out, so the page can say so. */
  adjusted?: MediaAdjustment[];
  /** Further pictures of the same job, when the model made more than one. */
  extraIds?: (string | null)[];
};

/** One saved take. Suno returns two per job, and the desk is billed once for both. */
export type StudioTrackResult = {
  id: string | null;
  url: string;
  title?: string;
  durationSeconds?: number;
};

export type StudioMusicResult = {
  tracks: StudioTrackResult[];
  prompt: string;
  mode: MusicMode;
  model: string;
  style?: string;
  instrumental: boolean;
};

// Every list below reads the catalogue of one tenant. `scope` names it (a `TenantContext` goes in as it
// is); a desk has one catalogue and ignores it. See `ModelCacheScope`.
export function listStudioImageModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  // The host's own list is already the image list (by regex, or by the gateway's price list for an id no
  // regex knows). Only a list a caller hands in is checked again.
  return models ? models.filter((model) => mediaKind(model.id) === "image") : listImageModels(scope);
}

export function listStudioVideoModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  return models ? models.filter((model) => mediaKind(model.id) === "video") : listProbedVideoModels(undefined, scope);
}

export function defaultStudioImageModel(models?: ChatModel[], scope?: ModelCacheScope): string {
  return pickPreferredImageModel((models ?? listStudioImageModels(undefined, scope)).map((model) => model.id));
}

export function defaultStudioVideoModel(models?: ChatModel[], scope?: ModelCacheScope): string {
  return availableVideoDefault((models ?? listStudioVideoModels(undefined, scope)).map((model) => model.id));
}

export function listStudioMusicModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  return (models ?? listMusicModels(scope)).filter((model) => isMusicModelId(model.id));
}

export function defaultStudioMusicModel(models?: ChatModel[], scope?: ModelCacheScope): string {
  return pickPreferredMusicModel((models ?? listStudioMusicModels(undefined, scope)).map((model) => model.id));
}

/**
 * The Music picker: the catalog minus what this key's calls refused, plus a Settings or agent pin the
 * catalog does not carry — unless that pin is itself refused. `defaultModel` is always an id in the
 * list, or `""` when the list is empty, so the page can say why instead of failing on click
 * (`musicPickerEmpty`, `apps/web/lib/music-models.ts`).
 *
 * The pin join is why this is not just `listStudioMusicModels`: a relay id the gateway never lists
 * (`suno_music`) is a legal pin, and the select must be able to show what generate will send. A
 * refused pin is the one thing that must not come back, or the empty state could never be reached.
 */
export function studioMusicPicker(
  catalog: ChatModel[],
  pinned: string,
  scope?: ModelCacheScope,
): { models: ChatModel[]; defaultModel: string } {
  const asked = pinned.trim();
  const extra = asked ? dropRefusedIds([asked], scope) : [];
  const models = withRelayMusicModels(catalog, extra);
  const chosen = asked ? models.find((model) => model.id.toLowerCase() === asked.toLowerCase())?.id : undefined;
  // Non-empty, `defaultStudioMusicModel` answers an id from the list (its constant is only the empty
  // list's last resort), so `chosen ?? fallback` is always a listed id, or "".
  const fallback = models.length > 0 ? defaultStudioMusicModel(models, scope) : "";
  return { models, defaultModel: chosen ?? fallback };
}

/**
 * Why the studio's voice-over control is off, or `null` when a text-to-speech model is reachable.
 *
 * The catalog's only TTS id is realtime, and a realtime id speaks WebSocket behind an `openai`
 * endpoint label, so a job route cannot drive it. Reporting the reason is the whole point: the
 * studio says "this gateway serves no reachable speech model" instead of failing at submit.
 *
 * The full catalog is passed beside the offered list, so a key that refused every speech model reads
 * as `none_on_key` rather than as a gateway that has none (`speechUnavailableReason`).
 */
export function studioSpeechUnavailable(models?: ChatModel[], scope?: ModelCacheScope): SpeechUnavailableReason | null {
  const offered = (models ?? listSpeechModels(scope)).map((model) => model.id);
  const catalogIds = models ? offered : catalogOfCache(loadModelCache(scope)).map((entry) => entry.id);
  return speechUnavailableReason(offered, catalogIds);
}

export function listStudioSpeechModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  return (models ?? listSpeechModels(scope)).filter(
    (model) => isSpeechModelId(model.id) || isOmniSpeechModelId(model.id),
  );
}

export function parseImageGenerateBody(raw: unknown): ImageGenerateBody {
  const parsed = imageGenerateBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid_content_part", parsed.error.issues[0]?.message ?? "Invalid body", 400);
  }
  return parsed.data;
}

export function parseVideoGenerateBody(raw: unknown): VideoGenerateBody {
  const parsed = videoGenerateBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid_content_part", parsed.error.issues[0]?.message ?? "Invalid body", 400);
  }
  if (parsed.data.imageUrl && parsed.data.model && !videoCapabilities(parsed.data.model).imageToVideo) {
    throw new ApiError("video_still_unsupported", modeMessage("videoStillUnsupported", localeForRun()), 400);
  }
  return parsed.data;
}

export function parseMusicGenerateBody(raw: unknown): MusicGenerateBody {
  const parsed = musicGenerateBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid_content_part", parsed.error.issues[0]?.message ?? "Invalid body", 400);
  }
  const body = parsed.data;
  if (body.mode === "custom") {
    if (!body.lyrics?.trim()) {
      throw new ApiError("invalid_content_part", modeMessage("musicLyricsRequired", localeForRun()), 400);
    }
  } else if (!body.prompt?.trim()) {
    throw new ApiError("invalid_content_part", modeMessage("musicPromptRequired", localeForRun()), 400);
  }
  return body;
}

export function parseLyricsWriteBody(raw: unknown): LyricsWriteBody {
  const parsed = lyricsWriteBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("invalid_content_part", parsed.error.issues[0]?.message ?? "Invalid body", 400);
  }
  return parsed.data;
}

function toolFailureMessage(output: unknown, fallback: string): string {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const error = (output as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
  }
  return fallback;
}

/** The `code` a failed tool run carries, when it carries one. */
function toolFailureCode(output: unknown): string | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const code = (output as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }
  return null;
}

function toolSuccessUrl(output: unknown, key: "image" | "video"): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const record = output as Record<string, unknown>;
  if (record.success !== true) {
    return null;
  }
  const url = record[key];
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

/** What an image tool run reports beside its picture. `images` holds every picture when the model made more than one. */
function toolImageReport(
  output: unknown,
  first: string,
): { sent?: ImageSent; adjusted?: MediaAdjustment[]; extras: string[] } {
  const record =
    output && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
  const images = Array.isArray(record.images)
    ? record.images.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    sent: record.sent && typeof record.sent === "object" ? (record.sent as ImageSent) : undefined,
    adjusted: Array.isArray(record.adjusted) ? (record.adjusted as MediaAdjustment[]) : undefined,
    extras: images.filter((item) => item !== first),
  };
}

function toolModel(output: unknown, fallback: string): string {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const model = (output as { model?: unknown }).model;
    if (typeof model === "string" && model.trim()) {
      return model.trim();
    }
  }
  return fallback;
}

async function persistMeta(tenantId: string, meta: StudioMediaMeta): Promise<void> {
  try {
    await saveStudioMediaMeta(tenantId, meta);
  } catch {
    // Gallery still works from the media table without sidecar fields.
  }
}

export function studioRouteReady(
  capability: "image_gen" | "video_gen" | "music_gen" | "speech_gen",
  tenant: TenantContext,
): boolean {
  const routes = listToolRoutes(loadSettings(tenant));
  return Boolean(routes[capability]?.ready);
}

/** 1×1 PNG. A stub desk saves this instead of calling the gateway. */
const STUB_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function studioSourceImage(tenant: TenantContext, imageUrl: string | undefined): Promise<string | undefined> {
  const mediaId = imageUrl === undefined ? null : mediaReferenceId(imageUrl);
  if (!mediaId) {
    return imageUrl;
  }
  const { chatMediaReferenceResolver } = await import("./chat-media-resolver");
  const dataUrl = await chatMediaReferenceResolver(tenant, mediaId);
  if (!dataUrl) {
    throw new ApiError("not_found", "Media not found", 404);
  }
  return dataUrl;
}

export async function generateStudioImage(
  tenant: TenantContext,
  body: ImageGenerateBody,
  options: StudioGenerateOptions = {},
): Promise<StudioGenerateResult> {
  const settings = loadSettings(tenant);
  const locale = localeForRun();
  const scope = buildToolSecretScope(settings);
  const model = body.model || settings.imageGenModel || defaultStudioImageModel(undefined, tenant);
  const sourceImage = await studioSourceImage(tenant, body.imageUrl);
  // Edit keeps the live tool. The Images page, including a stub desk, uses the harness.
  const standIn = process.env.AGENTFORGE_RUNTIME === "stub" && options.workType !== "Edit";
  let ran: Awaited<ReturnType<typeof runImageSkills<string>>>;
  // What the tool reports back about the call that succeeded: what it carried, what it moved, and any
  // further pictures a model that makes more than one returned.
  let report: { sent?: ImageSent; adjusted?: MediaAdjustment[]; extras: string[] } = { extras: [] };
  try {
    ran = await runImageSkills({
      prompt: maskPii(body.prompt),
      aspect: body.aspect,
      model,
      execute: async (attempt) => {
        if (standIn) {
          return { url: STUB_IMAGE_DATA_URL, extra: model };
        }
        const output = await runWithToolSecrets(scope, () =>
          imageGenerateTool.execute(
            {
              prompt: withImageOutputLanguage(attempt.prompt, locale),
              aspect_ratio: attempt.aspect,
              image_url: sourceImage,
              model: attempt.model,
              ...(body.size ? { pixels: body.size } : {}),
              ...(body.aspectRatio ? { ratio: body.aspectRatio } : {}),
              ...(body.quality ? { quality: body.quality } : {}),
              ...(body.tier ? { resolution: body.tier } : {}),
              ...(body.count ? { count: body.count } : {}),
              ...(body.outputFormat ? { output_format: body.outputFormat } : {}),
            },
            tenant,
          ),
        );
        const url = toolSuccessUrl(output, "image");
        if (!url) {
          return { url: null, error: toolFailureMessage(output, imageGenerateFailedMessage(locale)) };
        }
        report = toolImageReport(output, url);
        return { url, extra: toolModel(output, model) };
      },
    });
  } catch (error) {
    if (error instanceof ImageModelRejectedError) {
      throw new ApiError("invalid_request", imageModelRejectedMessage(locale), 400);
    }
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      "tool_failed",
      error instanceof Error && error.message ? error.message : imageGenerateFailedMessage(locale),
      400,
    );
  }
  const url = ran.url;
  const usedModel = ran.extra ?? model;
  // Metered here, not after the file is stored: the gateway has already charged for this image, so
  // a failure to save it must not be a call that vanishes from the ledger (Phase 5 lane A). The
  // model recorded is the one that answered, which is not always the one that was asked for.
  // A stub stand-in never reached the gateway, so it is not a charge.
  if (!standIn) {
    recordImageUsage(tenant, {
      model: usedModel,
      count: 1 + report.extras.length,
      aspect: report.sent ? shapeOfRatio(ratioOf(report.sent.aspect) ?? 1) : ran.aspect,
    });
  }
  // What the picture is remembered as: the ratio the model drew when it said so, else the loose shape.
  const aspect = report.sent?.aspect ?? ran.aspect;
  const { saveGeneratedImage } = await import("./media");
  const saveOne = async (source: string): Promise<{ id: string | null; stored: string }> => {
    const stored = await saveGeneratedImage(tenant, source);
    const id = mediaIdFromUrl(stored);
    if (id) {
      await persistMeta(tenant.tenantId, {
        mediaId: id,
        kind: "image",
        prompt: body.prompt,
        aspect,
        model: usedModel,
        createdAt: new Date().toISOString(),
      });
      await upsertWorkSource(
        tenant,
        mediaWorkCard({
          kind: "image",
          mediaId: id,
          prompt: body.prompt,
          aspect,
          model: usedModel,
          url: stored,
          type: options.workType,
        }),
      );
    }
    return { id, stored };
  };
  const first = await saveOne(url);
  const extraIds: (string | null)[] = [];
  for (const extra of report.extras) {
    extraIds.push((await saveOne(extra)).id);
  }
  return {
    id: first.id,
    url: first.stored,
    prompt: body.prompt,
    aspect,
    model: usedModel,
    ...(report.sent ? { sent: report.sent } : {}),
    ...(report.adjusted && report.adjusted.length > 0 ? { adjusted: report.adjusted } : {}),
    ...(extraIds.length > 0 ? { extraIds } : {}),
  };
}

function videoToolResult(
  output: unknown,
  locale: ReturnType<typeof localeForRun>,
  model: string,
  availableIds: readonly string[],
): VideoRenderResult {
  const url = toolSuccessUrl(output, "video");
  if (url) {
    return { ok: true, url, model: toolModel(output, model) };
  }
  // A job the gateway still has when the wait ran out: said in the desk's language, and marked so the
  // harness does not submit the brief again (`packages/core/src/videos/job-pending.ts`).
  if (toolFailureCode(output) === VIDEO_JOB_PENDING_CODE) {
    return {
      ok: false,
      message: modeMessage("videoJobPending", locale),
      code: VIDEO_JOB_PENDING_CODE,
      status: VIDEO_JOB_PENDING_STATUS,
    };
  }
  const raw = toolFailureMessage(output, modeMessage("videoGenerateFailed", locale));
  const rewritten = rewriteModelNotOnKey(raw, locale, model, availableIds);
  if (rewritten) {
    return {
      ok: false,
      message: rewritten.message,
      code: "model_not_on_key",
      status: 400,
      ...(rewritten.suggestModel ? { suggestModel: rewritten.suggestModel } : {}),
    };
  }
  return { ok: false, message: raw, code: "tool_failed", status: studioVideoFailureStatus(raw) };
}

export async function generateStudioVideo(
  tenant: TenantContext,
  body: VideoGenerateBody,
  options: VideoGenerateOptions = {},
): Promise<StudioGenerateResult> {
  if (!options.renderVideo && !studioRouteReady("video_gen", tenant)) {
    throw new ApiError("invalid_request", gatewayRequiredMessage("videos", localeForRun()), 400);
  }
  const settings = loadSettings(tenant);
  const scope = buildToolSecretScope(settings);
  const locale = localeForRun();
  const availableIds = listStudioVideoModels(undefined, tenant).map((item) => item.id);
  const requested = (body.model || settings.videoGenModel || "").trim();
  const sourceImage = await studioSourceImage(tenant, body.imageUrl);
  const harness = await runVideoHarness(
    {
      prompt: body.prompt,
      requestedModel: requested,
      availableIds,
      aspect: body.aspect,
      imageUrl: sourceImage,
      seconds: body.seconds,
      resolution: body.resolution,
      audio: body.audio,
      published: requested ? publishedMediaParamsFor(requested, tenant) : undefined,
      locale,
    },
    async (call) => {
      const output = options.renderVideo
        ? await options.renderVideo(call)
        : await runWithToolSecrets(scope, () => videoGenerateTool.execute(call, tenant));
      return videoToolResult(output, locale, call.model, availableIds);
    },
  );
  // The gateway has been paid once a clip is kept, so the row is written before the file is
  // stored. The length is the snapped one the harness asked for, never `body.seconds`.
  const billedResolution = harness.sent.resolution;
  recordVideoUsage(tenant, {
    model: harness.usedModel,
    seconds: harness.seconds,
    ...(billedResolution === "480p" ||
    billedResolution === "720p" ||
    billedResolution === "1080p" ||
    billedResolution === "4k"
      ? { resolution: billedResolution }
      : {}),
  });
  const aspect = harness.sent.aspect ?? "";
  const { saveGeneratedVideo } = await import("./media");
  const stored = await saveGeneratedVideo(tenant, harness.url);
  const id = mediaIdFromUrl(stored);
  if (id) {
    await persistMeta(tenant.tenantId, {
      mediaId: id,
      kind: "video",
      prompt: harness.shot,
      aspect,
      model: harness.usedModel,
      createdAt: new Date().toISOString(),
      durationSeconds: harness.seconds,
    });
    await upsertWorkSource(
      tenant,
      mediaWorkCard({
        kind: "video",
        mediaId: id,
        prompt: harness.shot,
        aspect,
        model: harness.usedModel,
        url: stored,
        seconds: harness.seconds,
        resolution: harness.sent.resolution,
        type: options.workType,
      }),
    );
  }
  return {
    id,
    url: stored,
    prompt: body.prompt,
    aspect,
    model: harness.usedModel,
    sent: harness.sent,
    ...(harness.adjusted.length > 0 ? { adjusted: harness.adjusted } : {}),
  };
}

/** The text a music job is remembered by: the lyrics in custom mode, the brief in describe mode. */
function musicPromptOf(body: MusicGenerateBody): string {
  return (body.mode === "custom" ? body.lyrics : body.prompt)?.trim() ?? "";
}

function toolTracks(output: unknown): GatewayTrack[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return [];
  }
  const record = output as Record<string, unknown>;
  if (record.success !== true || !Array.isArray(record.tracks)) {
    return [];
  }
  return record.tracks.filter(
    (track): track is GatewayTrack =>
      Boolean(track) && typeof track === "object" && typeof (track as GatewayTrack).url === "string",
  );
}

/**
 * Run one music job and mirror every take it returns.
 *
 * The desk is billed once for the job and Suno hands back two takes, so both are saved: dropping one
 * would throw away something already paid for. Each take becomes its own media row and its own
 * Knowledge card, because each is a separate file the desk may keep or delete on its own.
 */
export async function generateStudioMusic(tenant: TenantContext, body: MusicGenerateBody): Promise<StudioMusicResult> {
  if (!studioRouteReady("music_gen", tenant)) {
    throw new ApiError("invalid_request", gatewayRequiredMessage("music", localeForRun()), 400);
  }
  const settings = loadSettings(tenant);
  const locale = localeForRun();
  const scope = buildToolSecretScope(settings);
  const model = body.model || settings.musicGenModel || defaultStudioMusicModel(undefined, tenant);
  const caps = musicCapabilities(model);
  const mode = resolveMusicMode(model, body.mode);
  const prompt = musicPromptOf(body);
  if (!prompt) {
    const key = mode === "custom" ? "musicLyricsRequired" : "musicPromptRequired";
    throw new ApiError("invalid_content_part", modeMessage(key, locale), 400);
  }
  const style = caps.style ? body.style?.trim() || undefined : undefined;
  const instrumental = caps.instrumental && body.instrumental === true;
  // A title they typed wins, then a title on the take, then the first sung line of the brief.
  // The title can ride the custom-mode relay body, so it is masked like the words.
  const songTitle = (takeTitle?: string) => {
    const named = resolveSongTitle({ ownerTitle: body.title, takeTitle, brief: prompt });
    return named ? maskPii(named).slice(0, MUSIC_TITLE_MAX).trim() || undefined : undefined;
  };
  const title = songTitle();
  const sungLyrics = mode === "custom" ? maskPii(stripMusicLanguageRule(prompt)) : "";
  if (mode === "custom" && !sungLyrics.trim()) {
    throw new ApiError("invalid_content_part", modeMessage("musicLyricsRequired", locale), 400);
  }
  const execute = () =>
    musicGenerateTool.execute(
      {
        // The owner's own lyrics are sung word for word, so they go as written. The language rule
        // rides only a description, the one text the model writes the words from; never the style tags.
        ...(mode === "custom"
          ? { lyrics: sungLyrics }
          : { prompt: withOutputLanguage(maskPii(prompt), "music", locale) }),
        style,
        title: caps.title ? title : undefined,
        instrumental,
        model,
      },
      tenant,
    );
  let output = await runWithToolSecrets(scope, execute);
  let tracks = toolTracks(output);
  // One more submit of the same brief when nothing comes back. Not a second model.
  if (shouldRetryMusicJob(1, tracks.length)) {
    output = await runWithToolSecrets(scope, execute);
    tracks = toolTracks(output);
  }
  if (tracks.length === 0) {
    throw new ApiError(
      "tool_failed",
      toolFailureMessage(output, modeMessage("musicGenerateFailed", locale)),
      studioVideoFailureStatus(toolFailureMessage(output, "")),
    );
  }
  const usedModel = toolModel(output, model);
  // One charge, however many takes come back — so the unit is `jobs` and the quantity is 1. A blank
  // first try is the same song and does not add a row. Metered before the takes are stored.
  recordMusicUsage(tenant, { model: usedModel });
  const { saveGeneratedAudio } = await import("./media");
  const saved: StudioTrackResult[] = [];
  for (const track of tracks) {
    const stored = await saveGeneratedAudio(tenant, track.url);
    const id = mediaIdFromUrl(stored);
    if (id) {
      await persistMeta(tenant.tenantId, {
        mediaId: id,
        kind: "audio",
        prompt,
        aspect: "",
        model: usedModel,
        createdAt: new Date().toISOString(),
        title: songTitle(track.title),
        style,
        instrumental,
        durationSeconds: track.durationSeconds,
      });
      await upsertWorkSource(
        tenant,
        musicWorkCard({
          mediaId: id,
          prompt,
          model: usedModel,
          url: stored,
          mode,
          title: songTitle(track.title),
          style,
          instrumental,
          durationSeconds: track.durationSeconds,
        }),
      );
    }
    saved.push({
      id,
      url: stored,
      title: songTitle(track.title),
      durationSeconds: track.durationSeconds,
    });
  }
  return { tracks: saved, prompt, mode, model: usedModel, style, instrumental };
}

function lyricDraftOf(output: unknown): { text: string; title?: string; model?: string } {
  const record = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  if (record.success !== true) {
    return { text: "" };
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined;
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
  return { text, title, model };
}

/** Draft lyrics only. Nothing is stored: the text goes straight back for the desk to edit. */
export async function writeStudioLyrics(
  tenant: TenantContext,
  body: LyricsWriteBody,
): Promise<{ text: string; title?: string; model: string }> {
  if (!studioRouteReady("music_gen", tenant)) {
    throw new ApiError("invalid_request", gatewayRequiredMessage("music", localeForRun()), 400);
  }
  const settings = loadSettings(tenant);
  const locale = localeForRun();
  const scope = buildToolSecretScope(settings);
  const asked = withOutputLanguage(maskPii(body.prompt), "music", locale);
  const execute = () => lyricsWriteTool.execute({ prompt: asked, model: body.model }, tenant);
  let output = await runWithToolSecrets(scope, execute);
  let draft = lyricDraftOf(output);
  // A one-line echo, or the language instruction sung back, is tried once more.
  if (shouldRetryLyrics(1, draft.text)) {
    const second = await runWithToolSecrets(scope, execute);
    const next = lyricDraftOf(second);
    const chosen = preferLyricDraft(draft.text, next.text);
    if (chosen && chosen === stripMusicLanguageRule(next.text).trim()) {
      output = second;
      draft = { ...next, text: chosen };
    } else {
      draft = { ...draft, text: chosen };
    }
  } else {
    draft = { ...draft, text: stripMusicLanguageRule(draft.text).trim() };
  }
  if (!draft.text) {
    throw new ApiError("tool_failed", toolFailureMessage(output, modeMessage("lyricsGenerateFailed", locale)), 400);
  }
  const usedModel = toolModel(output, body.model ?? "");
  // A lyrics draft is its own flat-rate gateway call, billed whether or not the desk goes on to
  // generate a song from it. A shape retry is the same draft from the desk's side, so one row.
  recordMusicUsage(tenant, { model: usedModel });
  const relayTitle = draft.title ? stripMusicLanguageRule(draft.title).trim() : "";
  const named = resolveSongTitle({ takeTitle: relayTitle || undefined, brief: body.prompt });
  const title = named ? maskPii(named).slice(0, MUSIC_TITLE_MAX).trim() || undefined : undefined;
  return {
    text: draft.text,
    title,
    model: usedModel,
  };
}

export async function listStudioGallery(tenant: TenantContext, kind: StudioKind): Promise<StudioGalleryItem[]> {
  const { listMediaByKind } = await import("./media");
  const { missingTenantObjects } = await import("./tenant-storage");
  const rows = await listMediaByKind(tenant, kind);
  const missing = await missingTenantObjects(
    tenant.tenantId,
    rows.map((row) => row.storagePath),
  );
  const items: StudioGalleryItem[] = [];
  for (const row of rows) {
    const meta = await getStudioMediaMeta(tenant.tenantId, row.id);
    items.push({
      id: row.id,
      url: row.url,
      mime: row.mime,
      createdAt: row.createdAt.toISOString(),
      prompt: meta?.prompt,
      aspect: meta?.aspect,
      model: meta?.model,
      title: meta?.title,
      style: meta?.style,
      instrumental: meta?.instrumental,
      durationSeconds: meta?.durationSeconds,
      ...(missing.has(row.storagePath) ? { fileMissing: true as const } : {}),
    });
  }
  return items;
}
