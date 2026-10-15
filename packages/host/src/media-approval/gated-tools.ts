import { imageGenerateTool, videoGenerateTool, type TenantContext, type ToolDefinition } from "@agentforge/core";
import type { z, ZodTypeAny } from "zod";
import { getRunContext } from "../run-context";
import { loadSettings } from "../settings-store";
import { defaultStudioImageModel, defaultStudioVideoModel } from "../studio-generate";
import { currentToolRun } from "../tool-run-context";
import { isAttendedRun } from "./presence";
import {
  MEDIA_NEEDS_PERSON_REASON,
  MEDIA_PENDING_STATUS,
  PENDING_DESCRIPTION_SENTENCE,
  type MediaKind,
} from "./constants";
import { ownerOf } from "./decisions";
import { defaultMediaApprovalDeps, type MediaApprovalDeps } from "./deps";
import { estimateStoredMedia } from "./estimate";
import { mediaApprovalOn } from "./gate";
import { imageRequestFrom, videoRequestFrom, type StoredMediaRequest } from "./request";

type DepsSource = () => Promise<MediaApprovalDeps>;

type GateOptions<TSchema extends ZodTypeAny> = {
  readonly kind: MediaKind;
  readonly depsOf: DepsSource;
  readonly request: (args: z.infer<TSchema>, tenant: TenantContext) => StoredMediaRequest;
};

function defaultModelOf(kind: MediaKind, tenant: TenantContext): string {
  const settings = loadSettings(tenant);
  return kind === "image"
    ? settings.imageGenModel || defaultStudioImageModel(undefined, tenant)
    : settings.videoGenModel || defaultStudioVideoModel(undefined, tenant);
}

function withAutoAllowed(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return output;
  }
  return { ...(output as Record<string, unknown>), autoAllowed: true };
}

function gated<TSchema extends ZodTypeAny>(
  core: ToolDefinition<TSchema>,
  options: GateOptions<TSchema>,
): ToolDefinition<TSchema> {
  const execute = async (args: z.infer<TSchema>, tenant: TenantContext): Promise<unknown> => {
    if (!mediaApprovalOn()) {
      return core.execute(args, tenant);
    }
    const deps = await options.depsOf();
    const owner = ownerOf(tenant);
    if (deps.store.allowedFor(owner, options.kind)) {
      return withAutoAllowed(await core.execute(args, tenant));
    }
    const context = getRunContext();
    if (!isAttendedRun() || !context) {
      return { ok: false, status: "denied", reason: MEDIA_NEEDS_PERSON_REASON };
    }
    const request = options.request(args, tenant);
    const estimate = estimateStoredMedia(request);
    const proposalId = deps.store.propose({
      owner,
      workspaceId: tenant.workspaceId,
      threadId: context.threadId,
      runId: currentToolRun()?.runId ?? null,
      kind: options.kind,
      model: request.model,
      estimateMicros: estimate.amountMicros,
      request,
      now: deps.now(),
    });
    return {
      ok: true,
      status: MEDIA_PENDING_STATUS,
      kind: options.kind,
      proposalId,
      prompt: request.prompt,
      estimate,
    };
  };

  return {
    key: core.key,
    name: core.name,
    get description() {
      return mediaApprovalOn() ? `${core.description} ${PENDING_DESCRIPTION_SENTENCE}` : core.description;
    },
    schema: core.schema,
    handlerKey: core.handlerKey,
    capability: core.capability,
    pack: core.pack,
    trust: core.trust,
    execute,
  };
}

export function gatedImageGenerateTool(
  depsOf: DepsSource = defaultMediaApprovalDeps,
): ToolDefinition<typeof imageGenerateTool.schema> {
  return gated(imageGenerateTool, {
    kind: "image",
    depsOf,
    request: (args, tenant) => imageRequestFrom(args, defaultModelOf("image", tenant)),
  });
}

export function gatedVideoGenerateTool(
  depsOf: DepsSource = defaultMediaApprovalDeps,
): ToolDefinition<typeof videoGenerateTool.schema> {
  return gated(videoGenerateTool, {
    kind: "video",
    depsOf,
    request: (args, tenant) => videoRequestFrom(args, defaultModelOf("video", tenant)),
  });
}
