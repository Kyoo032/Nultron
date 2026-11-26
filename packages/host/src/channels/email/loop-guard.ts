/**
 * Loop protection (F5b): never answer an auto-reply, cap one sender per hour, cap the body size.
 *
 * The hourly cap is an in-process sliding window. `email_inbound_seen` cannot hold the count (its
 * columns are the dedupe contract), and a cap that survives a restart is not required to break a
 * loop — two auto-responders re-arm within seconds, not across a reboot.
 */
import { createHash } from "node:crypto";
import { EMAIL_DEFAULT_MAX_PER_SENDER_HOUR, EMAIL_MAX_PER_SENDER_HOUR_ENV } from "./path";

const HOUR_MS = 3_600_000;

const AUTO_SUBMITTED_RE = /^(auto-generated|auto-replied|auto-notified)$/i;
const PRECEDENCE_RE = /^(bulk|junk|list|auto_reply)$/i;

/**
 * Whether a delivery is itself machine-made. Honour `Auto-Submitted` (anything but "no"),
 * `Precedence` (bulk/junk/list/auto_reply) and the common auto-responder markers. An auto-reply
 * is never answered — answering one is how two mail daemons loop forever.
 */
export function isAutoSubmitted(headers: Record<string, unknown>): boolean {
  const get = (name: string): string => (typeof headers[name] === "string" ? (headers[name] as string).trim() : "");
  const autoSubmitted = get("auto-submitted");
  if (autoSubmitted && !/^no$/i.test(autoSubmitted)) {
    return AUTO_SUBMITTED_RE.test(autoSubmitted) || autoSubmitted.length > 0;
  }
  if (PRECEDENCE_RE.test(get("precedence"))) {
    return true;
  }
  return (
    get("x-autoreply").length > 0 ||
    get("x-autorespond").length > 0 ||
    (/^yes$/i.test(get("x-auto-response-suppress")) === false && get("x-auto-response-suppress").length > 0)
  );
}

/** sha256 of the sender address — the only sender-shaped value allowed into audit/log lines (S2). */
export function senderHash(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex");
}

export function maxPerSenderHour(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env[EMAIL_MAX_PER_SENDER_HOUR_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : EMAIL_DEFAULT_MAX_PER_SENDER_HOUR;
}

export class SenderCap {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while the sender stays under the cap; the attempt itself is counted. */
  admit(channelId: string, addressHash: string): boolean {
    const key = `${channelId}:${addressHash}`;
    const cutoff = this.now() - HOUR_MS;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }
}
