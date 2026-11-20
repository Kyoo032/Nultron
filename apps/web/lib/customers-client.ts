import type {
  ConversationState,
  CustomerConversation,
  CustomerMessage,
  InboxSummary,
  WhatsAppConnection,
} from "@agentforge/core/inbox";
import { apiFetch } from "./api-client";

export type { ConversationState, CustomerConversation, CustomerMessage, InboxSummary, WhatsAppConnection };

/** What a conversation list can be narrowed to. `all` sends no filter. */
export type ConversationFilter = "all" | "needs_you" | "with_you" | "closed";

export type ConversationDetail = { conversation: CustomerConversation; messages: CustomerMessage[] };

/** The host's code for "this desk has no number yet", which the page turns into its own prompt. */
export const NOT_CONNECTED_CODE = "channel_not_connected";
/** The host's code for "the 24-hour window has closed", which the page turns into its own words. */
export const WINDOW_CLOSED_CODE = "window_closed";

export class CustomersError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomersError";
    this.code = code;
  }
}

function errorFrom(payload: unknown, fallback: string): CustomersError {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && typeof error === "object") {
      const message = typeof error.message === "string" && error.message.trim() ? error.message : fallback;
      const code = typeof error.code === "string" ? error.code : "customers_error";
      return new CustomersError(code, message);
    }
  }
  return new CustomersError("customers_error", fallback);
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw errorFrom(data, fallback);
  }
  return data as T;
}

function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function conversationPath(conversationId: string, tail = ""): string {
  return `/api/v1/customers/conversations/${encodeURIComponent(conversationId)}${tail}`;
}

export async function loadWhatsApp(): Promise<WhatsAppConnection> {
  const res = await apiFetch("/api/v1/customers/whatsapp");
  return readJson<WhatsAppConnection>(res, "Could not load this desk's WhatsApp number");
}

/** The token travels in the body and nowhere else; the host proves it reaches the number before it keeps it. */
export async function connectWhatsApp(phoneNumberId: string, accessToken: string): Promise<WhatsAppConnection> {
  const res = await post("/api/v1/customers/whatsapp", { phoneNumberId, accessToken });
  return readJson<WhatsAppConnection>(res, "WhatsApp did not accept that number and token");
}

export async function disconnectWhatsApp(): Promise<WhatsAppConnection> {
  const res = await apiFetch("/api/v1/customers/whatsapp", { method: "DELETE" });
  return readJson<WhatsAppConnection>(res, "Could not disconnect the number");
}

/** `since` is the start of the owner's local day, so "today" means their day and not the server's. */
export async function loadSummary(since: number): Promise<InboxSummary> {
  const res = await apiFetch(`/api/v1/customers/summary?since=${encodeURIComponent(String(since))}`);
  return readJson<InboxSummary>(res, "Could not load today's numbers");
}

export async function loadConversations(filter: ConversationFilter, query: string): Promise<CustomerConversation[]> {
  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("state", filter);
  }
  const q = query.trim();
  if (q) {
    params.set("q", q);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const res = await apiFetch(`/api/v1/customers/conversations${suffix}`);
  const payload = await readJson<{ conversations: CustomerConversation[] }>(res, "Could not load conversations");
  return payload.conversations ?? [];
}

export async function loadConversation(conversationId: string): Promise<ConversationDetail> {
  const res = await apiFetch(conversationPath(conversationId));
  return readJson<ConversationDetail>(res, "Could not load that conversation");
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const res = await post(conversationPath(conversationId, "/read"));
  await readJson<{ ok: boolean }>(res, "Could not mark that conversation read");
}

export async function replyToConversation(conversationId: string, text: string): Promise<CustomerMessage> {
  const res = await post(conversationPath(conversationId, "/reply"), { text });
  const payload = await readJson<{ message: CustomerMessage }>(res, "WhatsApp did not accept that reply");
  return payload.message;
}

export async function setConversationState(
  conversationId: string,
  state: Exclude<ConversationState, "auto">,
): Promise<void> {
  const res = await post(conversationPath(conversationId, "/state"), { state });
  await readJson<{ ok: boolean }>(res, "Could not change that conversation");
}

/** Erase the conversation and every message in it, for good. The owner's (the host refuses a member). */
export async function eraseConversation(conversationId: string): Promise<void> {
  const res = await apiFetch(conversationPath(conversationId), { method: "DELETE" });
  await readJson<{ ok: boolean }>(res, "Could not erase that customer");
}
