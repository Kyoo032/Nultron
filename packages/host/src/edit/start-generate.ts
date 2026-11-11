import { and, eq } from "drizzle-orm";
import {
  ApiError,
  assertSendableMediaUrl,
  DEFAULT_GATEWAY_IMAGE_MODEL,
  DEFAULT_GATEWAY_VIDEO_MODEL,
  estimateJobUsd,
  imageToVideoForModel,
  ratioOf,
  routeEditModel,
  secondsToFrames,
  settleVideo,
  shapeOfRatio,
  snapVideoSeconds,
  videoSpecFor,
  type Clip,
  type EditProject,
  type EditStartGenerateJobInput,
  type EditStartGenerateJobResult,
  type TenantContext,
} from "@agentforge/core";
import { db, editCards, media } from "@agentforge/db";
import type { ModelCacheScope } from "../model-cache";
import { listImageModels, listVideoModels } from "../selectable-models";
import { appendOps, foldProject, writeSnapshot } from "./ops";
import { enqueueEditJob } from "./jobs";
import { mapCard, mapJob } from "./projects";
import { editEvents } from "./events";
import { resolveStillSource, type StillSource } from "./still-source";

/** The loose shape of a ratio such as `16:9`, for an image job. */
function imageAspectForEdit(aspect: string): "square" | "landscape" | "portrait" {
  return shapeOfRatio(ratioOf(aspect) ?? 16 / 9);
}

/**
 * The resolution a job will be priced at: the model's own, so the estimate and the call agree. Edit's price
 * table has three tiers; a bigger one (2k, 4k) is priced as the top tier it has.
 */
function settledResolution(model: string, asked: string | undefined): "480p" | "720p" | "1080p" {
  const used = settleVideo(videoSpecFor(model), { resolution: asked }).resolution;
  if (used === "480p" || used === "720p" || used === "1080p") {
    return used;
  }
  return used ? "1080p" : "720p";
}

function timelineTailFrame(project: EditProject, trackId = "v1"): number {
  let end = 0;
  for (const clip of project.clips) {
    if (clip.trackId === trackId) {
      end = Math.max(end, clip.timelineStartFrame + clip.durationFrames);
    }
  }
  return end;
}

function stillClipDurationFrames(project: EditProject): number {
  return Math.max(1, project.fps);
}

function projectAspect(doc: EditProject): "16:9" | "9:16" | "1:1" {
  if (doc.width === doc.height) {
    return "1:1";
  }
  return doc.width > doc.height ? "16:9" : "9:16";
}

function liveModelIds(scope: ModelCacheScope, extra?: string): string[] {
  const ids = [...listImageModels(scope), ...listVideoModels(scope)].map((model) => model.id);
  if (extra && !ids.includes(extra)) {
    ids.push(extra);
  }
  return ids;
}

function routeModel(tenant: TenantContext, input: EditStartGenerateJobInput, requireImageToVideo: boolean): string {
  const kind = input.kind === "generate_image" ? "image" : "video";
  const tier = input.tier ?? "standard";
  const routed = routeEditModel({
    kind,
    tier,
    liveModelIds: liveModelIds(tenant, input.model),
    requireImageToVideo,
  });
  // Nothing live matched and nothing was named: the gateway defaults the rest of the app uses, not a
  // per-token Grok id a prepaid key cannot run.
  return routed ?? input.model ?? (kind === "image" ? DEFAULT_GATEWAY_IMAGE_MODEL : DEFAULT_GATEWAY_VIDEO_MODEL);
}

const STILL_NOT_FOUND = new ApiError(
  "still_not_found",
  "The still image could not be used. Import it into this project or paste a public https URL.",
  400,
);

/**
 * Local media is inlined as a data URL at submit time (see `withInlinedStill`) because a
 * remote gateway cannot fetch this machine; here we only confirm the media row exists.
 *
 * Only inside the caller's organization, which is where the worker reads the still from
 * (`readMediaDataUrl`). Looked up by id alone, another tenant's media id passed this check while an
 * unknown id was refused, so the answer told a caller whether an id existed anywhere.
 */
async function assertStillAvailable(tenant: TenantContext, still: StillSource): Promise<void> {
  if (still.kind !== "local") {
    return;
  }
  const rows = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.organizationId, tenant.organizationId), eq(media.id, still.mediaId)))
    .limit(1);
  if (!rows[0]) {
    throw STILL_NOT_FOUND;
  }
}

function nextClipId(): string {
  return crypto.randomUUID();
}

function placeholderClips(
  doc: EditProject,
  input: EditStartGenerateJobInput,
  model: string,
  stillAssetId: string | undefined,
): Clip[] {
  const toolKey = input.toolKey ?? input.kind;
  const count = Math.min(4, Math.max(1, input.count ?? 1));
  const aspectTrack = input.placeAt?.trackId ?? "v1";
  const fps = doc.fps;
  const videoSeconds = input.addSeconds ?? input.seconds ?? 5;
  const duration =
    toolKey === "extend_clip"
      ? Math.max(1, secondsToFrames(input.addSeconds ?? 4, fps))
      : input.kind === "generate_image"
        ? stillClipDurationFrames(doc)
        : Math.max(1, secondsToFrames(videoSeconds, fps));
  const parent = input.clipId ? doc.clips.find((clip) => clip.id === input.clipId) : undefined;

  if (toolKey === "regenerate_clip" && parent) {
    return [
      {
        ...parent,
        status: "pending",
        lineage: {
          parentClipId: parent.id,
          prompt: input.prompt,
          model,
          tier: input.tier ?? parent.lineage?.tier,
          ingredientIds: input.ingredientIds ?? parent.lineage?.ingredientIds,
        },
      },
    ];
  }

  const clips: Clip[] = [];
  let start =
    input.placeAt?.timelineStartFrame ??
    (parent ? parent.timelineStartFrame + parent.durationFrames : timelineTailFrame(doc, aspectTrack));
  const n = toolKey === "variations" || toolKey === "extend_clip" ? count : count;
  for (let i = 0; i < n; i += 1) {
    clips.push({
      id: nextClipId(),
      trackId: aspectTrack,
      timelineStartFrame: start,
      durationFrames: duration,
      status: "pending",
      fallbackAssetId: stillAssetId,
      lineage: {
        parentClipId: parent?.id,
        prompt: input.prompt,
        model,
        tier: input.tier,
        ingredientIds: input.ingredientIds,
      },
    });
    start += duration;
  }
  return clips;
}

export async function startGenerateJob(
  tenant: TenantContext,
  projectId: string,
  input: EditStartGenerateJobInput,
  options: { runId?: string; onSettled?: () => void } = {},
): Promise<EditStartGenerateJobResult> {
  const doc = await foldProject(projectId, tenant.workspaceId);
  const still = input.kind === "generate_video" ? resolveStillSource(doc, input) : null;
  if (still === "unresolvable") {
    throw STILL_NOT_FOUND;
  }
  const hasStill = still !== null;
  const model = routeModel(tenant, input, input.kind === "generate_video" && hasStill);
  if (input.kind === "generate_video" && hasStill && !imageToVideoForModel(model)) {
    throw new ApiError("video_still_unsupported", "This model does not accept a still image", 400);
  }
  if (still?.kind === "remote") {
    // The provider fetches a remote still itself. From the Edit agent it must be one the run made, a search
    // returned or the person typed (H1, 2026-10-13); from the person's own form no guard is open and it passes.
    assertSendableMediaUrl(still.url);
  }
  if (still) {
    await assertStillAvailable(tenant, still);
  }
  const imageUrl = still?.kind === "remote" ? still.url : undefined;
  const stillMediaId = still?.kind === "local" ? still.mediaId : undefined;
  const stillAssetId = still?.kind === "local" ? still.assetId : undefined;
  // The project's frame unless a ratio was named; the model's spec moves a ratio it does not take.
  const aspect = input.aspect?.trim() ? input.aspect.trim() : projectAspect(doc);
  const count = Math.min(4, Math.max(1, input.count ?? 1));
  const requestedSeconds = input.addSeconds ?? input.seconds ?? (input.kind === "generate_video" ? 5 : undefined);
  // Veo only renders 4/6/8 s; snap here so the job, the placeholder and the price agree.
  const seconds = input.kind === "generate_video" ? snapVideoSeconds(model, requestedSeconds) : requestedSeconds;
  const timedInput =
    input.kind === "generate_video" ? { ...input, seconds, addSeconds: input.addSeconds ? seconds : undefined } : input;
  const resolution = input.kind === "generate_video" ? settledResolution(model, input.resolution) : "720p";
  const estimateUsd = estimateJobUsd(model, {
    seconds,
    count,
    resolution,
  });
  const clips = placeholderClips(doc, timedInput, model, stillAssetId);
  const cardId = crypto.randomUUID();
  const runId = options.runId ?? "owner";
  const actor = runId === "owner" ? ("owner" as const) : (`agent:${runId}` as const);
  const toolKey = input.toolKey ?? input.kind;
  const [cardRow] = await db
    .insert(editCards)
    .values({
      id: cardId,
      projectId,
      runId,
      toolKey,
      verb: toolKey.replaceAll("_", " "),
      object: input.prompt.slice(0, 80),
      opIdsJson: [],
      status: "pending",
      thumbsJson: [],
      estimateUsd,
      tier: input.tier,
    })
    .returning();
  const parent = input.clipId ? doc.clips.find((clip) => clip.id === input.clipId) : undefined;
  const ops =
    toolKey === "regenerate_clip" && parent
      ? [{ type: "set_clip_status" as const, payload: { clipId: parent.id, status: "pending" as const } }]
      : clips.map((clip) => ({ type: "add_clip" as const, payload: { clip } }));
  const applied = await appendOps(
    projectId,
    ops.map((op) => ({ ...op, cardId })),
    { actor, cardId, workspaceId: tenant.workspaceId },
  );
  const targetClipIds = toolKey === "regenerate_clip" && parent ? [parent.id] : clips.map((clip) => clip.id);
  const job = await enqueueEditJob(projectId, {
    kind: input.kind,
    // No tenant in the request: the worker resolves it from the project and `requestedBy`.
    request: {
      prompt: input.prompt,
      aspect: input.kind === "generate_image" ? imageAspectForEdit(aspect) : aspect,
      model,
      imageUrl,
      stillMediaId,
      imageAssetId: stillAssetId,
      seconds: seconds ?? 5,
      // What the person chose (left out means the model's own default, 720p where offered). The job
      // settles it against the model's spec again when it runs.
      ...(input.kind === "generate_video"
        ? { ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.audio !== undefined ? { audio: input.audio } : {}) }
        : {
            ...(input.quality ? { quality: input.quality } : {}),
            ...(input.imageResolution ? { tier: input.imageResolution } : {}),
            ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
          }),
      projectId,
    },
    targetClipIds,
    cardId,
    model,
    tier: input.tier,
    estimateUsd,
    requestedBy: tenant.userId,
    onSettled: options.onSettled,
  });
  const [updated] = await db
    .update(editCards)
    .set({ jobId: job.id, opIdsJson: applied.applied.map((op) => op.id) })
    .where(and(eq(editCards.id, cardId), eq(editCards.projectId, projectId)))
    .returning();
  const folded = await foldProject(projectId, tenant.workspaceId);
  const stamped = structuredClone(folded);
  for (const clip of stamped.clips) {
    if (targetClipIds.includes(clip.id)) {
      clip.badge = { cardId };
      clip.jobId = job.id;
    }
  }
  await writeSnapshot(projectId, stamped.seq, stamped);
  const card = mapCard(updated ?? cardRow);
  editEvents.emitEvent({ type: "card.updated", projectId, card });
  return {
    job: mapJob(job),
    clips: stamped.clips.filter((clip) => targetClipIds.includes(clip.id)),
    estimateUsd,
    card,
  };
}
