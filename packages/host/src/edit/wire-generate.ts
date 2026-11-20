import { and, eq } from "drizzle-orm";
import { media } from "@agentforge/db";
import { db } from "@agentforge/db";
import { ApiError, VIDEO_JOB_PENDING_CODE, type TenantContext } from "@agentforge/core";
import { generateStudioImage, generateStudioVideo } from "../studio-generate";
import { mediaIdFromUrl } from "../media-id";
import { setGenerateSubmit } from "./generate";

let wired = false;

function isCompleteTenant(tenant: TenantContext | undefined): tenant is TenantContext {
  return Boolean(tenant?.tenantId && tenant.organizationId && tenant.workspaceId && tenant.userId);
}

export function ensureGenerateSubmitWired(): void {
  if (wired) {
    return;
  }
  wired = true;
  setGenerateSubmit(async ({ kind, request, tenant, signal }) => {
    void signal;
    const body = (request ?? {}) as Record<string, unknown>;
    // The tenant is the job runner's, resolved from the project. `body.tenant` — which a job row
    // written before that change may still carry — is never read: it was how a queued job could name
    // somebody else's key, ledger and desk.
    if (!isCompleteTenant(tenant)) {
      return { status: 400, body: { error: "tenant_required" } };
    }
    try {
      if (kind === "generate_image") {
        const aspectRaw = String(body.aspect ?? "square");
        const aspect =
          aspectRaw === "16:9" || aspectRaw === "landscape"
            ? "landscape"
            : aspectRaw === "9:16" || aspectRaw === "portrait"
              ? "portrait"
              : "square";
        const result = await generateStudioImage(
          tenant,
          {
            prompt: String(body.prompt ?? ""),
            aspect,
            model: typeof body.model === "string" ? body.model : undefined,
            imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
            ...(typeof body.quality === "string" ? { quality: body.quality } : {}),
            ...(typeof body.tier === "string" ? { tier: body.tier } : {}),
            ...(typeof body.outputFormat === "string" ? { outputFormat: body.outputFormat } : {}),
          },
          { workType: "Edit" },
        );
        const mediaId = result.id ?? mediaIdFromUrl(result.url);
        return {
          status: 200,
          body: result,
          outputAssetIds: mediaId ? [mediaId] : [],
        };
      }
      const result = await generateStudioVideo(
        tenant,
        {
          prompt: String(body.prompt ?? ""),
          aspect: typeof body.aspect === "string" ? body.aspect : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
          seconds: typeof body.seconds === "number" ? body.seconds : undefined,
          resolution: typeof body.resolution === "string" ? body.resolution : undefined,
          ...(typeof body.audio === "boolean" ? { audio: body.audio } : {}),
        },
        { workType: "Edit" },
      );
      const mediaId = result.id ?? mediaIdFromUrl(result.url);
      return {
        status: 200,
        body: result,
        outputAssetIds: mediaId ? [mediaId] : [],
      };
    } catch (error) {
      const status =
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
      const message = error instanceof Error ? error.message : "generate_failed";
      // A job the gateway still has is told apart by its code, so `runGenerateJob` does not submit it again.
      const pending = error instanceof ApiError && error.code === VIDEO_JOB_PENDING_CODE;
      return { status, body: { error: message, ...(pending ? { code: VIDEO_JOB_PENDING_CODE } : {}) } };
    }
  });
}

export async function loadMediaRow(mediaId: string, organizationId: string) {
  const rows = await db
    .select()
    .from(media)
    .where(and(eq(media.organizationId, organizationId), eq(media.id, mediaId)))
    .limit(1);
  return rows[0] ?? null;
}
