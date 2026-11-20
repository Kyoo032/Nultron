import type { CustomerConversation, CustomerMessage, ReplyWindow } from "@agentforge/core/inbox";

/**
 * The page's small pure rules, kept out of the component so they can be tested with a clock in hand:
 * which day "today" is, how long a reply window has left, how a customer is named, which word a
 * delivery state gets.
 */

const MINUTE_MS = 60 * 1000;

/** Midnight at the start of the owner's local day. The host cannot know the owner's time zone. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export type WindowState =
  | { kind: "never" }
  | { kind: "closed" }
  | { kind: "open"; hours: number; minutes: number };

/** What the composer should say about the 24-hour window, from the host's own `window` and the clock. */
export function windowState(window: ReplyWindow, now: number): WindowState {
  if (window.closesAt === null) {
    return { kind: "never" };
  }
  const left = window.closesAt - now;
  if (!window.open || left <= 0) {
    return { kind: "closed" };
  }
  // Round the minutes up so "0 m left" is never shown for a window that still has seconds.
  const totalMinutes = Math.ceil(left / MINUTE_MS);
  return { kind: "open", hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** The sender's number as people write it: the digits with a plus. */
export function formatPhone(contactId: string): string {
  return /^\d+$/.test(contactId) ? `+${contactId}` : contactId;
}

/** What the list and the thread call a customer: the name they chose, else their number. */
export function contactLabel(conversation: Pick<CustomerConversation, "contactName" | "contactId">): string {
  const name = conversation.contactName.trim();
  return name || formatPhone(conversation.contactId);
}

/** Initials for the avatar disc; a number-only contact gets a neutral dot instead of digits. */
export function initialsOf(conversation: Pick<CustomerConversation, "contactName">): string {
  const words = conversation.contactName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "·";
  }
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1] ?? "")[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export type ReplyTime = { unit: "seconds" | "minutes" | "hours"; value: number };

/** The median first-reply time as one number in a unit a person reads at a glance. */
export function replyTime(seconds: number | null): ReplyTime | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 90) {
    return { unit: "seconds", value: Math.max(1, Math.round(seconds)) };
  }
  if (seconds < 90 * 60) {
    return { unit: "minutes", value: Math.round(seconds / 60) };
  }
  return { unit: "hours", value: Math.round(seconds / 3600) };
}

/** The locale key for the small delivery word under an owner reply. */
export function deliveryKey(message: Pick<CustomerMessage, "direction" | "delivery">): string | null {
  if (message.direction !== "out") {
    return null;
  }
  return `customers.delivery.${message.delivery ?? "queued"}`;
}

/** Time of day for today's messages, the short date for older ones. */
export function stampLabel(at: number, now: number): string {
  const sameDay = startOfLocalDay(at) === startOfLocalDay(now);
  const date = new Date(at);
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** Cadence for the page's refresh while it is open and visible. */
export const POLL_INTERVAL_MS = 5000;

/** The Meta app's callback URL the owner pastes into Meta's webhook setup. */
export function callbackUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}
