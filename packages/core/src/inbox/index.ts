/**
 * The customer inbox — the kernel half.
 *
 * Record shapes, caps, the reply-window rule and the validators that run before anything is stored
 * or sent. The transport work (WhatsApp's wire format, signatures and API client) lives in the host
 * (`packages/host/src/inbox/`). Plan: docs/internal/whatsapp-omnichannel-plan.md.
 *
 * Do not import `node:crypto` here — the renderer reaches this module through
 * `@agentforge/core/inbox`.
 *
 * A customer conversation is **not** a Chat thread. In a thread a `user` message is the owner's own
 * word, so customer text there would read as the owner's instructions. It is also not an owner
 * channel (`@agentforge/core/channels`): those are groups the owner posts into by hand.
 */

import { ApiError } from "../errors";

/** Channels a customer can write on. WhatsApp first; Telegram joins in Phase 3 behind the same interface. */
export const INBOX_KINDS = ["whatsapp"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/**
 * Where a conversation stands.
 *
 * `needs_you`: the customer wrote last and nobody has answered. `with_you`: the owner answered.
 * `closed`: the owner marked it done; a new customer message reopens it. `auto` is reserved for
 * Phase 2 (a conversation Nultron answers on its own) and is never written in Phase 1.
 */
export const CONVERSATION_STATES = ["auto", "needs_you", "with_you", "closed"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** Who wrote a message. `auto` is Phase 2. */
export const MESSAGE_SENDERS = ["customer", "auto", "owner"] as const;
export type MessageSender = (typeof MESSAGE_SENDERS)[number];

/** `text` is a real message; `unsupported` is a placeholder for an image, voice note or file. */
export const MESSAGE_KINDS = ["text", "unsupported"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Delivery of an outbound message, in the order Meta reports it. `failed` can follow any state. */
export const DELIVERY_STATUSES = ["queued", "sent", "delivered", "read", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const INBOX_CAPS = {
  /** Customer conversations one desk keeps. Past this the oldest by last message goes. */
  maxConversationsPerDesk: 500,
  /** Messages kept per conversation, newest last. Older ones are dropped on write. */
  maxStoredMessages: 200,
  /** WhatsApp's own text-message limit; checked here rather than by Meta. */
  maxTextChars: 4096,
  /** Display strings from outside (a profile name) are capped so one cannot wreck the list. */
  maxNameChars: 120,
  /** The one-line preview the list shows. */
  maxPreviewChars: 140,
  /** Conversations one list call returns. */
  maxListed: 100,
} as const;

/**
 * The one public inbound route for WhatsApp, as the owner pastes it into Meta's webhook setup
 * (prefixed with the app's own origin). A literal path, never a prefix: it is exempt from the
 * session gate and the CSRF rule on the host, so nothing else may share its spelling.
 */
export const WHATSAPP_WEBHOOK_PATH = "/api/v1/channels/whatsapp/webhook";

/** Meta's customer service window: free-form replies are allowed for 24 hours after the customer writes. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReplyWindow = {
  open: boolean;
  /** When free-form replies stop being allowed; null when the customer has never written. */
  closesAt: number | null;
};

/**
 * Is a free-form reply allowed right now?
 *
 * Open strictly before `lastInboundAt + 24 h`: at the boundary itself the window is closed, because
 * a reply that arrives at Meta a moment later would be refused, and refusing here is the cheaper
 * mistake. After it closes only an approved template can be sent, which is Phase 3.
 */
export function whatsappReplyWindow(lastInboundAt: number | null, now: number): ReplyWindow {
  if (lastInboundAt === null || !Number.isFinite(lastInboundAt)) {
    return { open: false, closesAt: null };
  }
  const closesAt = lastInboundAt + WHATSAPP_WINDOW_MS;
  return { open: now < closesAt, closesAt };
}

/** The window for a conversation of any kind. A kind with no window rule is always open. */
export function replyWindowFor(kind: InboxKind, lastInboundAt: number | null, now: number): ReplyWindow {
  switch (kind) {
    case "whatsapp":
      return whatsappReplyWindow(lastInboundAt, now);
  }
}

/** A WhatsApp contact id (`wa_id`): the number in international form, digits only. */
const WA_ID_PATTERN = /^\d{5,20}$/;
/** A WhatsApp phone number id (Meta's id for the business number, not the number itself). */
const PHONE_NUMBER_ID_PATTERN = /^\d{5,25}$/;

/** `value` when it is a plausible `wa_id`, otherwise null. Untrusted input from a webhook. */
export function parseWaId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return WA_ID_PATTERN.test(text) ? text : null;
}

/** The owner's phone number id, validated before it reaches a URL path. */
export function assertPhoneNumberId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!PHONE_NUMBER_ID_PATTERN.test(value)) {
    throw new ApiError("invalid_request", "A phone number id is the long number from Meta's WhatsApp setup page", 400);
  }
  return value;
}

/** The owner's access token: opaque, so only its presence and a sane length are checked. */
export function assertAccessToken(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new ApiError("invalid_request", "An access token is required", 400);
  }
  if (value.length < 20 || value.length > 1024 || /\s/.test(value)) {
    throw new ApiError("invalid_request", "That does not look like a WhatsApp access token", 400);
  }
  return value;
}

/** Outbound text, trimmed and capped. Empty after trimming is a 400: an empty reply helps nobody. */
export function assertReplyText(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new ApiError("invalid_request", "A reply needs some text", 400);
  }
  if (value.length > INBOX_CAPS.maxTextChars) {
    throw new ApiError("invalid_request", `A reply is at most ${INBOX_CAPS.maxTextChars} characters`, 400);
  }
  return value;
}

/** Display text from outside: collapsed to one line and capped. */
export function inboxDisplayText(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return (value || fallback).slice(0, INBOX_CAPS.maxNameChars);
}

/** The one-line preview the list shows for a message. */
export function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > INBOX_CAPS.maxPreviewChars ? `${flat.slice(0, INBOX_CAPS.maxPreviewChars - 1)}…` : flat;
}

const DELIVERY_RANK: Record<DeliveryStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * The delivery status after a report, which never goes backwards.
 *
 * Meta's status webhooks arrive at least once and in no guaranteed order, so a late `sent` must not
 * undo a `read`. `failed` is final once it is the newest word on a message that was never delivered;
 * a `failed` that arrives after `delivered` or `read` is ignored, because the customer has it.
 */
export function nextDeliveryStatus(current: DeliveryStatus, reported: DeliveryStatus): DeliveryStatus {
  if (reported === "failed") {
    return DELIVERY_RANK[current] >= DELIVERY_RANK.delivered && current !== "failed" ? current : "failed";
  }
  if (current === "failed") {
    return DELIVERY_RANK[reported] >= DELIVERY_RANK.delivered ? reported : current;
  }
  return DELIVERY_RANK[reported] > DELIVERY_RANK[current] ? reported : current;
}

/** What the page is told about one conversation. */
export type CustomerConversation = {
  id: string;
  kind: InboxKind;
  /** The customer's number as the channel reports it (digits). The page shows it; logs never do. */
  contactId: string;
  /** The profile name the customer chose. Untrusted display text. */
  contactName: string;
  state: ConversationState;
  unreadCount: number;
  lastMessageAt: number;
  lastMessagePreview: string;
  lastMessageDirection: MessageDirection;
  lastInboundAt: number | null;
  window: ReplyWindow;
  createdAt: number;
};

export type CustomerMessage = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  sentBy: MessageSender;
  kind: MessageKind;
  /** The customer's words or ours. For an `unsupported` message, a fixed label such as "[image]". */
  text: string;
  delivery: DeliveryStatus | null;
  deliveryError: string | null;
  at: number;
};

/** The numbers on the Today strip. */
export type InboxSummary = {
  needsYou: number;
  withYou: number;
  closed: number;
  unread: number;
  /** Customer messages received since the start of the local day the host was asked about. */
  receivedToday: number;
  /** Replies the owner sent since then. */
  sentToday: number;
  /** Median seconds from a customer's message to the owner's reply, today. Null with no replies yet. */
  medianFirstReplySeconds: number | null;
};

/** The state of the number connected to this desk. Never the token. */
export type WhatsAppConnection = {
  connected: boolean;
  /** True when the server has the Meta app secret and verify token Meta's webhook needs. */
  webhookReady: boolean;
  phoneNumberId: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  connectedAt: number | null;
  /** `sha256:` prefix of the saved token, or null. */
  fingerprint: string | null;
  /** False when a developer machine is pointed at a local mock of Meta's API. */
  pinnedOrigin: boolean;
};
