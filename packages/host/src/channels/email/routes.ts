/**
 * Session routes for the email channel — `/api/v1/channels/email`, desk-scoped like the rest of
 * `handlers/channels.ts`. They manage the channel rows and the sender allowlist; the webhook is
 * `inbound.ts` and lives outside the session gate.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../../types";
import { jsonError, jsonOk } from "../../errors";
import { getTenant } from "../../tenant";
import { emailStore } from "./db";
import { normalizeAllowlistPattern } from "./identity";
import type { EmailStore } from "./store";

type TenantHandler = (tenant: TenantContext, request: HostRequest) => Promise<HostResult> | HostResult;

export type EmailRouteDeps = { store?: EmailStore };

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function withTenant(request: HostRequest, run: TenantHandler): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return await run(tenant, request);
  } catch (error) {
    return jsonError(error);
  }
}

const storeFor = (deps: EmailRouteDeps): EmailStore => deps.store ?? emailStore();

/** The desk's email channels with their allowlist sizes. */
export function handleListEmailChannels(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeFor(deps);
    const channels = store.listChannels(tenant.workspaceId).map((channel) => ({
      ...channel,
      allowlistSize: store.listAllowlist(channel.id).length,
    }));
    return jsonOk({ channels });
  });
}

/** Create a channel: an address for one agent, and the unknown-sender policy. */
export function handleCreateEmailChannel(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const policy = body.unknownSenderPolicy === "refuse" ? "refuse" : "ignore";
    if (!ADDRESS_RE.test(address)) {
      throw new ApiError("invalid_address", "An email channel needs a full address (name@domain).", 400);
    }
    if (!agentId) {
      throw new ApiError("invalid_agent", "An email channel needs an agent.", 400);
    }
    const store = storeFor(deps);
    if (store.findChannelByAddress(address)) {
      throw new ApiError("address_taken", "That address already belongs to a channel.", 409);
    }
    return jsonOk(
      store.createChannel({ workspaceId: tenant.workspaceId, agentId, address, unknownSenderPolicy: policy }),
      201,
    );
  });
}

/** Remove the channel; its allowlist rows cascade. */
export function handleDeleteEmailChannel(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeFor(deps);
    if (!store.removeChannel(tenant.workspaceId, request.params.channelId)) {
      throw new ApiError("channel_not_found", "No email channel with that id on this desk.", 404);
    }
    return jsonOk({ ok: true });
  });
}

export function handleListEmailAllowlist(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeFor(deps);
    const channel = store.getChannel(tenant.workspaceId, request.params.channelId);
    if (!channel) {
      throw new ApiError("channel_not_found", "No email channel with that id on this desk.", 404);
    }
    return jsonOk({ channelId: channel.id, entries: store.listAllowlist(channel.id) });
  });
}

/** Add an allowlist pattern: a full address, or `@domain` for the whole domain. `userId` may be null → the owner. */
export function handleAddEmailAllowlist(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeFor(deps);
    const channel = store.getChannel(tenant.workspaceId, request.params.channelId);
    if (!channel) {
      throw new ApiError("channel_not_found", "No email channel with that id on this desk.", 404);
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const pattern = normalizeAllowlistPattern(body.pattern);
    if (!pattern) {
      throw new ApiError("invalid_pattern", "An allowlist pattern is a full address or @domain.", 400);
    }
    const userId = typeof body.userId === "string" && body.userId ? body.userId : null;
    return jsonOk(store.addAllowlistEntry(channel.id, pattern, userId), 201);
  });
}

export function handleRemoveEmailAllowlist(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeFor(deps);
    const channel = store.getChannel(tenant.workspaceId, request.params.channelId);
    if (!channel || !store.removeAllowlistEntry(channel.id, request.params.entryId)) {
      throw new ApiError("allowlist_not_found", "No allowlist entry with that id on this channel.", 404);
    }
    return jsonOk({ ok: true });
  });
}
