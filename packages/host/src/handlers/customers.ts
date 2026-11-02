/**
 * Customers — the owner's side of the customer inbox (docs/internal/whatsapp-omnichannel-plan.md).
 *
 *   GET    /api/v1/customers/whatsapp                       is a number connected, and is the server ready for Meta
 *   POST   /api/v1/customers/whatsapp                       connect a number (proves the token reaches it first)
 *   DELETE /api/v1/customers/whatsapp                       forget the token and stop receiving; conversations stay
 *   GET    /api/v1/customers/summary                        the Today strip
 *   GET    /api/v1/customers/conversations                  the list, filtered by state and a search
 *   GET    /api/v1/customers/conversations/:id              one conversation and its thread
 *   POST   /api/v1/customers/conversations/:id/read         clear the unread count
 *   POST   /api/v1/customers/conversations/:id/reply        send a free-form reply (inside the window)
 *   POST   /api/v1/customers/conversations/:id/state        mark done, or put it back with the owner
 *
 * Everything is desk-scoped through `getTenant`: the `DeskScope` handed to the store is the signed-in
 * tenant's, never anything the request names. A conversation id from another desk is a 404.
 *
 * Connecting and disconnecting a number is the owner's (or an admin's), not any member's: the token
 * is the desk's line to its customers.
 *
 * Nothing here reaches the model gateway. In Phase 1 every outbound message is written by the owner.
 */

import { ApiError, keyFingerprintOrNull, type TenantContext } from "@agentforge/core";
import {
  INBOX_KINDS,
  assertAccessToken,
  assertPhoneNumberId,
  assertReplyText,
  type ConversationState,
  type WhatsAppConnection,
} from "@agentforge/core/inbox";
import { isPinnedWhatsAppOrigin, resolvedWhatsAppApiOrigin } from "@agentforge/core/inbox/pinned";
import { jsonError, jsonOk } from "../errors";
import { inboxStore } from "../inbox/db";
import type { DeskScope, EndpointRow, InboxStore } from "../inbox/store";
import { WHATSAPP_APP_SECRET_ENV, WHATSAPP_VERIFY_TOKEN_ENV } from "../inbox/webhook-path";
import { WhatsAppClient } from "../inbox/whatsapp";
import { loadSettings, saveSettings } from "../settings-store";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

type TenantHandler = (tenant: TenantContext, request: HostRequest) => Promise<HostResult> | HostResult;

async function withTenant(request: HostRequest, run: TenantHandler): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    return await run(tenant, request);
  } catch (error) {
    return jsonError(error);
  }
}

/** Test seams: a store on a scratch database, a client on a local mock of Meta, a clock. */
export type CustomersDeps = {
  store?: InboxStore;
  client?: (token: string) => WhatsAppClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

function storeOf(deps: CustomersDeps): InboxStore {
  return deps.store ?? inboxStore();
}

function nowOf(deps: CustomersDeps): number {
  return (deps.now ?? Date.now)();
}

function scopeOf(tenant: TenantContext): DeskScope {
  return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId };
}

/** Roles that may connect or disconnect a number. A desk has one owner; `admin` is the portal's second word for it. */
function requireOwner(tenant: TenantContext): void {
  if (tenant.role !== "owner" && tenant.role !== "admin") {
    throw new ApiError("forbidden", "Only the owner of this desk can change its WhatsApp number", 403);
  }
}

function notFound(): ApiError {
  return new ApiError("not_found", "Conversation not found", 404);
}

function clientFor(token: string, deps: CustomersDeps): WhatsAppClient {
  return deps.client ? deps.client(token) : new WhatsAppClient(token);
}

function connectionPayload(
  tenant: TenantContext,
  endpoint: EndpointRow | null,
  deps: CustomersDeps,
): WhatsAppConnection {
  const token = loadSettings(tenant).whatsappAccessToken;
  const env = deps.env ?? process.env;
  const connected = Boolean(endpoint && token);
  return {
    connected,
    webhookReady: Boolean(env[WHATSAPP_APP_SECRET_ENV]?.trim() && env[WHATSAPP_VERIFY_TOKEN_ENV]?.trim()),
    phoneNumberId: connected ? (endpoint?.externalId ?? null) : null,
    displayPhone: connected ? (endpoint?.displayPhone ?? null) : null,
    verifiedName: connected ? (endpoint?.verifiedName ?? null) : null,
    connectedAt: connected ? (endpoint?.createdAt ?? null) : null,
    // The same non-secret handle Settings shows for the gateway key.
    fingerprint: connected ? keyFingerprintOrNull(token) : null,
    /** False only on a developer machine pointed at a mock; the page says so out loud. */
    pinnedOrigin: isPinnedWhatsAppOrigin(resolvedWhatsAppApiOrigin()),
  };
}

export function handleGetWhatsApp(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) =>
    jsonOk(connectionPayload(tenant, storeOf(deps).endpointForDesk(scopeOf(tenant), "whatsapp"), deps)),
  );
}

/**
 * Connect a number: shape-check both values, ask Meta whether this token reaches this number, and
 * only then write anything.
 *
 * The Meta call is also the ownership proof. A number belongs to one desk across the whole install,
 * and without this check a desk could register another company's number id and be sent its
 * customers' messages. A token that cannot read the number gets a refusal here.
 */
export function handlePostWhatsApp(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, async (tenant) => {
    requireOwner(tenant);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const phoneNumberId = assertPhoneNumberId(body.phoneNumberId);
    const token = assertAccessToken(body.accessToken);
    const number = await clientFor(token, deps).getPhoneNumber(phoneNumberId);
    const endpoint = storeOf(deps).connectEndpoint(
      scopeOf(tenant),
      {
        kind: INBOX_KINDS[0],
        externalId: phoneNumberId,
        displayPhone: number.displayPhone,
        verifiedName: number.verifiedName || null,
      },
      nowOf(deps),
    );
    saveSettings({ whatsappAccessToken: token }, tenant);
    return jsonOk(connectionPayload(tenant, endpoint, deps));
  });
}

/**
 * Forget the token and stop receiving. The conversations stay: the owner disconnected a number, they
 * did not ask to lose their customers, and reconnecting the same number picks up where it left off.
 */
export function handleDeleteWhatsApp(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    requireOwner(tenant);
    storeOf(deps).disconnectEndpoint(scopeOf(tenant), "whatsapp", nowOf(deps));
    saveSettings({ whatsappAccessToken: "" }, tenant);
    return jsonOk(connectionPayload(tenant, null, deps));
  });
}

/**
 * The start of the owner's day comes from their browser (the host's own clock may be in another
 * zone). It must be in the last 48 hours and not in the future; anything else is the last 24 hours.
 */
function sinceOf(raw: string | undefined, now: number): number {
  const value = Number(raw);
  if (Number.isFinite(value) && value <= now && value >= now - 48 * 60 * 60 * 1000) {
    return Math.trunc(value);
  }
  return now - 24 * 60 * 60 * 1000;
}

export function handleGetCustomersSummary(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) =>
    jsonOk(storeOf(deps).summary(scopeOf(tenant), sinceOf(request.query.since, nowOf(deps)))),
  );
}

const LISTABLE_STATES: readonly ConversationState[] = ["needs_you", "with_you", "closed", "auto"];

export function handleGetConversations(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const state = LISTABLE_STATES.find((row) => row === request.query.state);
    const conversations = storeOf(deps).listConversations(
      scopeOf(tenant),
      { state, query: request.query.q?.slice(0, 80) },
      nowOf(deps),
    );
    return jsonOk({ conversations });
  });
}

export function handleGetConversation(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const store = storeOf(deps);
    const scope = scopeOf(tenant);
    const conversation = store.getConversation(scope, request.params.conversationId, nowOf(deps));
    const messages = conversation ? store.listMessages(scope, conversation.id) : null;
    if (!conversation || !messages) {
      throw notFound();
    }
    return jsonOk({ conversation, messages });
  });
}

export function handlePostConversationRead(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    if (!storeOf(deps).markRead(scopeOf(tenant), request.params.conversationId)) {
      throw notFound();
    }
    return jsonOk({ ok: true });
  });
}

/**
 * Send the owner's reply.
 *
 * The reply is written as `queued` first and settled after Meta answers, so a send that fails shows
 * in the thread as failed instead of vanishing. Outside the 24-hour window nothing is sent at all:
 * Meta would refuse it, and a template (Phase 3) is the only thing that may go out then.
 */
export function handlePostConversationReply(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, async (tenant) => {
    const store = storeOf(deps);
    const scope = scopeOf(tenant);
    const now = nowOf(deps);
    const text = assertReplyText((request.body as Record<string, unknown> | undefined)?.text);
    const target = store.sendTarget(scope, request.params.conversationId, now);
    if (!target) {
      throw notFound();
    }
    if (!target.conversation.window.open) {
      throw new ApiError(
        "window_closed",
        "WhatsApp only allows a free-form reply for 24 hours after the customer wrote",
        409,
      );
    }
    const token = loadSettings(tenant).whatsappAccessToken;
    if (!token || target.endpoint.status !== "active") {
      throw new ApiError("channel_not_connected", "Connect a WhatsApp number for this desk first", 409);
    }
    const queued = store.beginOutbound(scope, target.conversation.id, text, now);
    try {
      const sent = await clientFor(token, deps).sendText(
        target.endpoint.externalId,
        target.conversation.contactId,
        text,
      );
      const message = store.finishOutbound(scope, queued.id, { ok: true, externalId: sent.messageId }, nowOf(deps));
      return jsonOk({ message });
    } catch (error) {
      store.finishOutbound(
        scope,
        queued.id,
        { ok: false, error: error instanceof ApiError ? error.message : "The message could not be sent" },
        nowOf(deps),
      );
      throw error;
    }
  });
}

export function handlePostConversationState(request: HostRequest, deps: CustomersDeps = {}): Promise<HostResult> {
  return withTenant(request, (tenant) => {
    const raw = (request.body as Record<string, unknown> | undefined)?.state;
    if (raw !== "closed" && raw !== "with_you" && raw !== "needs_you") {
      throw new ApiError("invalid_request", "A conversation can be marked closed, with you, or needing you", 400);
    }
    if (!storeOf(deps).setState(scopeOf(tenant), request.params.conversationId, raw, nowOf(deps))) {
      throw notFound();
    }
    return jsonOk({ ok: true, state: raw });
  });
}
