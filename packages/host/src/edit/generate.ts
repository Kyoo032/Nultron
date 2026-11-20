import { ApiError, maskPii, VIDEO_JOB_PENDING_CODE, VIDEO_JOB_PENDING_STATUS, type TenantContext } from "@agentforge/core";
import { generateFailureMessage } from "./generate-failure";

export type GenerateSubmitResult = {
  status: number;
  body: unknown;
  outputAssetIds?: string[];
};

export type GenerateSubmitFn = (input: {
  kind: "generate_image" | "generate_video";
  /** What to make: prompt, aspect, model, still. It carries no identity, and none is read from it. */
  request: unknown;
  /**
   * Whose key pays, whose ledger is charged and whose desk the output lands on. Resolved by the job
   * runner from the project (`workerTenant`), never from the job's stored request.
   */
  tenant: TenantContext;
  signal: AbortSignal;
}) => Promise<GenerateSubmitResult>;

const PREPAID = /prepaid_async_requires_fixed_price/i;

let submitImpl: GenerateSubmitFn | null = null;

export function setGenerateSubmit(next: GenerateSubmitFn | null): void {
  submitImpl = next;
}

/** The answer of a video the gateway accepted and was still rendering when the wait ran out. */
export function isVideoJobPending(body: unknown): boolean {
  return Boolean(body) && typeof body === "object" && (body as { code?: unknown }).code === VIDEO_JOB_PENDING_CODE;
}

export function isPrepaidFailure(status: number, body: unknown): boolean {
  if (status !== 403) {
    return false;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return PREPAID.test(text) || text.includes("prepaid");
}

export function maskGeneratePrompt(request: unknown): unknown {
  if (!request || typeof request !== "object") {
    return request;
  }
  const record = { ...(request as Record<string, unknown>) };
  if (typeof record.prompt === "string") {
    record.prompt = maskPii(record.prompt);
  }
  return record;
}

export async function runGenerateJob(
  kind: "generate_image" | "generate_video",
  request: unknown,
  signal: AbortSignal,
  tenant: TenantContext,
): Promise<{ outputAssetIds: string[] }> {
  const masked = maskGeneratePrompt(request);
  if (!submitImpl) {
    throw new ApiError("not_enabled_in_phase_1", "Generation is not enabled in phase 1", 400);
  }
  const attempt = async () => submitImpl!({ kind, request: masked, tenant, signal });
  let result: GenerateSubmitResult;
  try {
    result = await attempt();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    result = await attempt();
  }
  if (isPrepaidFailure(result.status, result.body)) {
    throw new ApiError("prepaid_async_requires_fixed_price", "Prepaid async generation is not retried", 403);
  }
  // The gateway still has this job and will bill it when it finishes: the 5xx retry below would send the
  // brief again. The job ends here, with the message that says so.
  if (isVideoJobPending(result.body)) {
    throw new ApiError(VIDEO_JOB_PENDING_CODE, generateFailureMessage(result.status, result.body), VIDEO_JOB_PENDING_STATUS);
  }
  if (result.status >= 400 && result.status < 500) {
    throw new ApiError("generate_failed", generateFailureMessage(result.status, result.body), 400);
  }
  if (result.status >= 500) {
    const retry = await attempt();
    if (retry.status >= 400) {
      throw new ApiError("generate_failed", generateFailureMessage(retry.status, retry.body), 400);
    }
    return { outputAssetIds: retry.outputAssetIds ?? [] };
  }
  return { outputAssetIds: result.outputAssetIds ?? [] };
}
