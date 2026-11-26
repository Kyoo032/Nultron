/**
 * Session routes for the email channel — `/api/v1/channels/email`, desk-scoped like the rest of
 * `handlers/channels.ts`. They manage the channel rows and the sender allowlist; the webhook is
 * `inbound.ts` and lives outside the session gate.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ApiError, type TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../../types";
import { jsonError, jsonOk } from "../../errors";
import { getTenant } from "../../tenant";
import { sql } from "@agentforge/db";
import { emailStore } from "./db";
import { normalizeAllowlistPattern } from "./identity";
import { fromDomain } from "./outbound";
import type { EmailStore } from "./store";

type TenantHandler = (tenant: TenantContext, request: HostRequest) => Promise<HostResult> | HostResult;

export type EmailRouteDeps = {
  store?: EmailStore;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the app database; tests hand a scratch one. */
  db?: Pick<Database.Database, "prepare">;
};

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

/**
 * Create a channel: an address for one agent, and the unknown-sender policy. A caller may ask
 * for an address only under the relay's own domain (`AGENTFORGE_EMAIL_FROM_DOMAIN`) — a desk
 * cannot claim addresses the relay does not serve, so no channel can redirect another
 * organisation's mail. With no address the desk gets a generated `agent-<rand>@<domain>`.
 */
export function handleCreateEmailChannel(request: HostRequest, deps: EmailRouteDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requested = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const policy = body.unknownSenderPolicy === "refuse" ? "refuse" : "ignore";
    if (!agentId) {
      throw new ApiError("invalid_agent", "An email channel needs an agent.", 400);
    }
    const domain = fromDomain(deps.env ?? process.env);
    let address = requested;
    if (address) {
      if (!ADDRESS_RE.test(address)) {
        throw new ApiError("invalid_address", "An email channel needs a full address (name@domain).", 400);
      }
      if (domain && !address.endsWith(`@${domain}`)) {
        throw new ApiError("address_domain", `The address must be under ${domain}.`, 400);
      }
    } else {
      if (!domain) {
        throw new ApiError("address_domain", "Set AGENTFORGE_EMAIL_FROM_DOMAIN or pass an address.", 400);
      }
      address = `agent-${randomUUID().slice(0, 8)}@${domain}`;
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
    // The pattern maps mail to a member's acts — a non-member id would silently run as no one,
    // or worse, name somebody who left the desk.
    if (userId) {
      const db = deps.db ?? sql;
      const member = db
        .prepare(`SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
        .get(tenant.workspaceId, userId) as { ok: number } | undefined;
      if (!member) {
        throw new ApiError("user_not_member", "The allowlist maps senders to members of this desk.", 400);
      }
    }
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
