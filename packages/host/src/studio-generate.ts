import { z } from "zod";
import {
  ApiError,
  buildToolSecretScope,
  gatewayRequiredMessage,
  imageGenerateTool,
  isMusicModelId,
  isSpeechModelId,
  listToolRoutes,
  lyricsWriteTool,
  maskPii,
  mediaKind,
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
  rewriteModelNotOnKey,
  resolveMusicMode,
  runWithToolSecrets,
  speechUnavailableReason,
  studioVideoFailureStatus,
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
  type MusicMode,
  type SpeechUnavailableReason,
  type TenantContext,
} from "@agentforge/core";
import { ImageModelRejectedError, runImageSkills } from "@agentforge/core/images";
import { mediaReferenceId } from "@agentforge/core/tools/media-reference";
import { loadSettings } from "./settings-store";
import type { ModelCacheScope } from "./model-cache";
import { listImageModels, listMusicModels, listProbedVideoModels, listSpeechModels } from "./selectable-models";
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

const studioImageSourceSchema = z.string().refine(
  (value) => httpUrlSchema.safeParse(value).success || mediaReferenceId(value) !== null,
  { message: "Pass an image URL, or the reference of an image you can see (/api/v1/media/<id>/file or the id)." },
);

export const imageGenerateBodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required"),
  aspect: z.enum(["square", "landscape", "portrait"]).optional(),
  model: z.string().trim().min(1).optional(),
  imageUrl: studioImageSourceSchema.optional(),
});

export const videoGenerateBodySchema = z.object({
  prompt: z.string().trim().min(1, "prompt is required"),
  aspect: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  model: z.string().trim().min(1).optional(),
  imageUrl: studioImageSourceSchema.optional(),
  seconds: z.number().int().min(2).max(12).optional(),
  resolution: z.enum(["480p", "720p", "1080p"]).optional(),
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
  return (models ?? listImageModels(scope)).filter((model) => mediaKind(model.id) === "image");
}

export function listStudioVideoModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  return (models ?? listProbedVideoModels(undefined, scope)).filter((model) => mediaKind(model.id) === "video");
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
 * Why the studio's voice-over control is off, or `null` when a text-to-speech model is reachable.
 *
 * The catalog's only TTS id is realtime, and a realtime id speaks WebSocket behind an `openai`
 * endpoint label, so a job route cannot drive it. Reporting the reason is the whole point: the
 * studio says "this gateway serves no reachable speech model" instead of failing at submit.
 */
export function studioSpeechUnavailable(
  models?: ChatModel[],
  scope?: ModelCacheScope,
): SpeechUnavailableReason | null {
  return speechUnavailableReason((models ?? listSpeechModels(scope)).map((model) => model.id));
}

export function listStudioSpeechModels(models?: ChatModel[], scope?: ModelCacheScope): ChatModel[] {
  return (models ?? listSpeechModels(scope)).filter((model) => isSpeechModelId(model.id));
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
            },
            tenant,
          ),
        );
        const url = toolSuccessUrl(output, "image");
        if (!url) {
          return { url: null, error: toolFailureMessage(output, imageGenerateFailedMessage(locale)) };
        }
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
    recordImageUsage(tenant, { model: usedModel, count: 1, aspect: ran.aspect });
  }
  const { saveGeneratedImage } = await import("./media");
  const stored = await saveGeneratedImage(tenant, url);
  const id = mediaIdFromUrl(stored);
  if (id) {
    await persistMeta(tenant.tenantId, {
      mediaId: id,
      kind: "image",
      prompt: body.prompt,
      aspect: ran.aspect,
      model: usedModel,
      createdAt: new Date().toISOString(),
    });
    await upsertWorkSource(
      tenant,
      mediaWorkCard({
        kind: "image",
        mediaId: id,
        prompt: body.prompt,
        aspect: ran.aspect,
        model: usedModel,
        url: stored,
        type: options.workType,
      }),
    );
  }
  return { id, url: stored, prompt: body.prompt, aspect: ran.aspect, model: usedModel };
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
  recordVideoUsage(tenant, {
    model: harness.usedModel,
    seconds: harness.seconds,
    ...(body.resolution ? { resolution: body.resolution } : {}),
  });
  const { saveGeneratedVideo } = await import("./media");
  const stored = await saveGeneratedVideo(tenant, harness.url);
  const id = mediaIdFromUrl(stored);
  if (id) {
    await persistMeta(tenant.tenantId, {
      mediaId: id,
      kind: "video",
      prompt: harness.shot,
      aspect: body.aspect,
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
        aspect: body.aspect,
        model: harness.usedModel,
        url: stored,
        seconds: harness.seconds,
        resolution: body.resolution,
        type: options.workType,
      }),
    );
  }
  return { id, url: stored, prompt: body.prompt, aspect: body.aspect, model: harness.usedModel };
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
