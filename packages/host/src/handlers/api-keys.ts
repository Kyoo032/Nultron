/**
 * F5a — session routes for managing a desk's API keys (`/api/v1/api-keys*`).
 *
 * Owner-only (the routes are registered under `ADMINISTER_ROUTES` in `role-policy.ts`):
 * create, list, revoke, rotate. The raw key leaves the desk exactly once, in the create /
 * rotate response body — after that the row holds only the SHA-256, the prefix and the
 * last four, and no route can be made to give it back.
 */
import { ApiError, reportAuditEvent } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, API_KEY_NAME_MAX } from "../public-api/keys";

function apiKeyAudit(tenantId: string, event: "api_key.create" | "api_key.revoke", actorId: string, keyId: string) {
  try {
    reportAuditEvent({
      tenantId,
      event,
      actorKind: "user",
      actorId,
      targetKind: "api_key",
      targetId: keyId,
      outcome: "ok",
    });
  } catch {
    // Audit is best-effort.
  }
}

export async function handleGetApiKeys(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return jsonOk({ apiKeys: listApiKeys(tenant.tenantId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostApiKeys(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      throw new ApiError("invalid_request", "name is required", 400);
    }
    if (name.length > API_KEY_NAME_MAX) {
      throw new ApiError("invalid_request", `name is limited to ${API_KEY_NAME_MAX} characters`, 400);
    }
    const allowedAgents = body.allowedAgents;
    if (
      !Array.isArray(allowedAgents) ||
      allowedAgents.length === 0 ||
      !allowedAgents.every((a) => typeof a === "string")
    ) {
      throw new ApiError("invalid_request", "allowedAgents must be a non-empty array of agent ids, or ['*']", 400);
    }
    const rateLimitRpm =
      body.rateLimitRpm === undefined || body.rateLimitRpm === null ? null : Number(body.rateLimitRpm);
    if (rateLimitRpm !== null && (!Number.isInteger(rateLimitRpm) || rateLimitRpm <= 0)) {
      throw new ApiError("invalid_request", "rateLimitRpm must be a positive integer", 400);
    }
    const expiresInDays =
      body.expiresInDays === undefined || body.expiresInDays === null ? null : Number(body.expiresInDays);
    if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
      throw new ApiError("invalid_request", "expiresInDays must be a positive number", 400);
    }
    const { key, apiKey } = createApiKey({
      workspaceId: tenant.workspaceId,
      tenantId: tenant.tenantId,
      name,
      allowedAgents,
      rateLimitRpm,
      expiresAt: expiresInDays === null ? null : Date.now() + expiresInDays * 86_400_000,
      createdBy: tenant.userId,
    });
    apiKeyAudit(tenant.tenantId, "api_key.create", tenant.userId, apiKey.id);
    // `key` is the one and only time the raw value leaves the desk (AC-5a.1).
    return jsonOk({ key, apiKey }, 201);
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostApiKeyRevoke(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    revokeApiKey(tenant.tenantId, request.params.id);
    apiKeyAudit(tenant.tenantId, "api_key.revoke", tenant.userId, request.params.id);
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handlePostApiKeyRotate(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const { key, apiKey } = rotateApiKey(tenant.tenantId, request.params.id, { createdBy: tenant.userId });
    apiKeyAudit(tenant.tenantId, "api_key.revoke", tenant.userId, request.params.id);
    apiKeyAudit(tenant.tenantId, "api_key.create", tenant.userId, apiKey.id);
    return jsonOk({ key, apiKey });
  } catch (error) {
    return jsonError(error);
  }
}
