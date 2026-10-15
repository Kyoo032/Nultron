import type { TenantContext } from "@agentforge/core";
import type { StoredMediaRequest } from "./request";
import type { MediaApprovalStore } from "./store";

export type GeneratedMedia = {
  readonly url: string;
  readonly prompt: string;
  readonly model: string;
};

export type MediaApprovalDeps = {
  readonly store: MediaApprovalStore;
  readonly now: () => number;
  readonly gate: (tenant: TenantContext) => void;
  readonly generate: (tenant: TenantContext, request: StoredMediaRequest) => Promise<GeneratedMedia>;
};

let cached: MediaApprovalDeps | null = null;

export async function defaultMediaApprovalDeps(): Promise<MediaApprovalDeps> {
  if (!cached) {
    const { sql } = await import("@agentforge/db");
    const { getLocalVaultKey } = await import("@agentforge/db/vault-key");
    const { requireGatewayAllowedFor } = await import("../gateway-gate");
    const { generateStudioImage, generateStudioVideo } = await import("../studio-generate");
    const { withRunSlot } = await import("../run-limits");
    const { runWithMediaReferenceResolver } = await import("@agentforge/core/tools/media-reference");
    const { chatMediaReferenceResolver } = await import("../chat-media-resolver");
    const { createMediaApprovalStore } = await import("./store");

    const generateOnce = async (tenant: TenantContext, request: StoredMediaRequest): Promise<GeneratedMedia> => {
      if (request.kind === "image") {
        const made = await generateStudioImage(tenant, {
          prompt: request.prompt,
          aspect: request.aspect,
          model: request.model,
          ...(request.imageUrl ? { imageUrl: request.imageUrl } : {}),
        });
        return { url: made.url, prompt: made.prompt, model: made.model };
      }
      const made = await generateStudioVideo(tenant, {
        prompt: request.prompt,
        aspect: request.aspect,
        model: request.model,
        ...(request.imageUrl ? { imageUrl: request.imageUrl } : {}),
        ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
      });
      return { url: made.url, prompt: made.prompt, model: made.model };
    };

    cached = {
      store: createMediaApprovalStore(sql, getLocalVaultKey),
      now: () => Date.now(),
      gate: (tenant) => {
        requireGatewayAllowedFor(tenant);
      },
      generate: (tenant, request) =>
        withRunSlot(tenant, () =>
          runWithMediaReferenceResolver(chatMediaReferenceResolver, () => generateOnce(tenant, request)),
        ),
    };
  }
  return cached;
}
