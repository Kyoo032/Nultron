import { ApiError, type TenantContext } from "@agentforge/core";
import { log } from "../log";
import {
  MEDIA_CURRENCY,
  MEDIA_PROPOSAL_EXPIRED_CODE,
  MEDIA_PROPOSAL_NOT_FOUND_CODE,
  MEDIA_PROPOSAL_NOT_PENDING_CODE,
  MEDIA_PROPOSAL_TTL_MS,
  type MediaKind,
  type MediaProposalStatus,
} from "./constants";
import type { GeneratedMedia, MediaApprovalDeps } from "./deps";
import type { StoredMediaRequest } from "./request";
import type { MediaEstimate } from "./estimate";
import type { MediaOwner, MediaProposalRecord } from "./store";
import { mediaPartOf, writeMediaResultToThread } from "./thread-result";

export type MediaProposalView = {
  readonly id: string;
  readonly kind: MediaKind;
  readonly prompt: string;
  readonly model: string;
  readonly estimate: MediaEstimate;
  readonly status: MediaProposalStatus;
  readonly threadId: string;
  readonly createdAt: number;
  readonly decidedAt: number | null;
};

export type GenerateOutcome = {
  readonly proposal: MediaProposalView;
  readonly result: Record<string, unknown>;
};

export function ownerOf(tenant: TenantContext): MediaOwner {
  return { organizationId: tenant.organizationId, userId: tenant.userId };
}

function notFound(): ApiError {
  return new ApiError(MEDIA_PROPOSAL_NOT_FOUND_CODE, "Not found", 404);
}

function notPending(): ApiError {
  return new ApiError(MEDIA_PROPOSAL_NOT_PENDING_CODE, "That card has already been decided.", 409);
}

function expired(): ApiError {
  return new ApiError(MEDIA_PROPOSAL_EXPIRED_CODE, "That card has expired. Ask again in the chat.", 409);
}

function loadOwn(deps: MediaApprovalDeps, owner: MediaOwner, id: string): MediaProposalRecord {
  const record = deps.store.get(owner, id);
  if (!record) {
    throw notFound();
  }
  return record;
}

function settleExpiry(
  deps: MediaApprovalDeps,
  owner: MediaOwner,
  record: MediaProposalRecord,
  now: number,
): MediaProposalRecord {
  if (record.status !== "pending" || now - record.createdAt <= MEDIA_PROPOSAL_TTL_MS) {
    return record;
  }
  deps.store.expire(owner, record.id, now);
  return { ...record, status: "expired", decidedAt: now };
}

function viewOf(
  record: MediaProposalRecord,
  status: MediaProposalStatus = record.status,
  decidedAt: number | null = record.decidedAt,
): MediaProposalView {
  return {
    id: record.id,
    kind: record.kind,
    prompt: record.request.prompt,
    model: record.model,
    estimate: { amountMicros: record.estimateMicros, currency: MEDIA_CURRENCY },
    status,
    threadId: record.threadId,
    createdAt: record.createdAt,
    decidedAt,
  };
}

function toolResultOf(request: StoredMediaRequest, generated: GeneratedMedia): Record<string, unknown> {
  if (request.kind === "image") {
    return { success: true, image: generated.url, model: generated.model, prompt: generated.prompt };
  }
  return {
    success: true,
    video: generated.url,
    model: generated.model,
    modality: request.imageUrl ? "image" : "text",
    prompt: generated.prompt,
  };
}

export function getMediaProposal(
  tenant: TenantContext,
  id: string,
  deps: MediaApprovalDeps,
): { readonly proposal: MediaProposalView } {
  const owner = ownerOf(tenant);
  const record = settleExpiry(deps, owner, loadOwn(deps, owner, id), deps.now());
  return { proposal: viewOf(record) };
}

export function skipMediaProposal(
  tenant: TenantContext,
  id: string,
  deps: MediaApprovalDeps,
): { readonly proposal: MediaProposalView } {
  const owner = ownerOf(tenant);
  const now = deps.now();
  const record = settleExpiry(deps, owner, loadOwn(deps, owner, id), now);
  if (record.status === "expired") {
    throw expired();
  }
  if (record.status !== "pending" || !deps.store.skip(owner, id, now)) {
    throw notPending();
  }
  return { proposal: viewOf(record, "skipped", now) };
}

export async function generateMediaProposal(
  tenant: TenantContext,
  id: string,
  deps: MediaApprovalDeps,
): Promise<GenerateOutcome> {
  const owner = ownerOf(tenant);
  const now = deps.now();
  const record = settleExpiry(deps, owner, loadOwn(deps, owner, id), now);
  if (record.status === "expired") {
    throw expired();
  }
  if (record.status !== "pending") {
    throw notPending();
  }
  deps.gate(tenant);
  if (!deps.store.claim(owner, id, now)) {
    throw notPending();
  }
  let generated: GeneratedMedia;
  try {
    generated = await deps.generate(tenant, record.request);
  } catch (error) {
    deps.store.finish(owner, id, "failed", deps.now());
    throw error;
  }
  const finishedAt = deps.now();
  deps.store.finish(owner, id, "generated", finishedAt);
  const result = toolResultOf(record.request, generated);
  try {
    await writeMediaResultToThread(
      tenant,
      record.threadId,
      id,
      result,
      mediaPartOf(record.request.kind, generated.url),
    );
  } catch (error) {
    log.warn("media_proposal_thread_not_updated", {
      detail: error instanceof Error ? error.message : "unknown",
    });
  }
  return { proposal: viewOf(record, "generated", finishedAt), result };
}

export function getAlwaysAllow(tenant: TenantContext, deps: MediaApprovalDeps): Readonly<Record<MediaKind, boolean>> {
  return deps.store.allowedByKind(ownerOf(tenant));
}

export function setAlwaysAllow(
  tenant: TenantContext,
  kind: MediaKind,
  allow: boolean,
  deps: MediaApprovalDeps,
): Readonly<Record<MediaKind, boolean>> {
  deps.store.setAllowed(ownerOf(tenant), kind, allow, deps.now());
  return deps.store.allowedByKind(ownerOf(tenant));
}
