/**
 * WhatsApp Business Cloud API — the wire work, and the only place in the product that opens a socket
 * to Meta.
 *
 * Two halves. **Inbound** is Meta calling us: the handshake, the signature check and the payload
 * parser, all pure functions so a test drives them without a server. **Outbound** is `WhatsAppClient`:
 * read a phone number (the proof that a pasted token is real) and send a text. Plan and the rules it
 * implements: docs/internal/whatsapp-omnichannel-plan.md.
 *
 * Properties this file exists to hold:
 *
 *  - **Nothing is parsed before the signature passes.** `verifySignature` takes the raw bytes.
 *  - **The origin is pinned** (`@agentforge/core/inbox/pinned`). No stored base URL, no owner
 *    override; the dev hook is ignored in a packaged build and in production.
 *  - **The token never leaves this file in a string anyone else sees.** It rides in an
 *    `Authorization` header, not the URL, but every message that can escape still goes through
 *    `redactToken`, and `whatsapp.test.ts` asserts it.
 *  - **No redirects.** A 3xx is an error, never a hop.
 *  - **Everything in a payload is untrusted.** Text is capped, ids are shape-checked, and a message
 *    that is not plain text becomes a fixed label, never the sender's content.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError, type EnvLike } from "@agentforge/core";
import {
  INBOX_CAPS,
  assertAccessToken,
  assertPhoneNumberId,
  inboxDisplayText,
  parseWaId,
  type DeliveryStatus,
  type MessageKind,
} from "@agentforge/core/inbox";
import { resolvedWhatsAppApiOrigin, WHATSAPP_GRAPH_VERSION } from "@agentforge/core/inbox/pinned";
import { log } from "../log";
import { WHATSAPP_APP_SECRET_ENV, WHATSAPP_VERIFY_TOKEN_ENV } from "./webhook-path";

export const WHATSAPP_TIMEOUT_MS = 15_000;
export const WHATSAPP_MAX_RESPONSE_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------------- inbound: trust */

export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "whatsapp_not_configured" | "whatsapp_unauthorized"; readonly message: string };

/** `timingSafeEqual` throws on a length mismatch, so the lengths are compared first. */
function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this delivery from the party that holds the Meta app secret?
 *
 * Fails closed and loudly when no secret is set: an open webhook is a route by which anybody on the
 * internet could put text into any desk that has connected a number. `env` is a parameter so the
 * tests drive every verdict without touching the process.
 */
export function verifySignature(
  rawBody: Uint8Array | undefined,
  presented: string | undefined,
  env: EnvLike = process.env,
): SignatureVerdict {
  const secret = env[WHATSAPP_APP_SECRET_ENV]?.trim();
  if (!secret) {
    return {
      ok: false,
      code: "whatsapp_not_configured",
      message: `No WhatsApp app secret is configured. Set ${WHATSAPP_APP_SECRET_ENV} before pointing Meta at this route.`,
    };
  }
  const unauthorized = {
    ok: false,
    code: "whatsapp_unauthorized",
    message: "This WhatsApp delivery was not authenticated.",
  } as const;
  const header = presented?.trim() ?? "";
  if (!rawBody || !header.startsWith("sha256=")) {
    return unauthorized;
  }
  const claimed = header.slice("sha256=".length);
  // Hex of a SHA-256 is exactly 64 characters; anything else cannot match and is not worth decoding.
  if (!/^[0-9a-fA-F]{64}$/.test(claimed)) {
    return unauthorized;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return constantTimeEquals(expected, Buffer.from(claimed, "hex")) ? { ok: true } : unauthorized;
}

/** The value Meta's signature header carries for `rawBody` under `secret`. Used by the sandbox and the tests. */
export function signBody(rawBody: Uint8Array | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export type HandshakeVerdict =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly status: 403 | 503; readonly code: string; readonly message: string };

/**
 * Meta's subscription handshake: `hub.mode=subscribe`, the operator's verify token and a challenge to
 * echo. The challenge is echoed only when the token matches, and only as digits-and-letters text, so
 * the response can carry nothing a page could execute.
 */
export function verifyHandshake(query: Record<string, string | undefined>, env: EnvLike = process.env): HandshakeVerdict {
  const expected = env[WHATSAPP_VERIFY_TOKEN_ENV]?.trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      code: "whatsapp_not_configured",
      message: `No WhatsApp verify token is configured. Set ${WHATSAPP_VERIFY_TOKEN_ENV} before pointing Meta at this route.`,
    };
  }
  const presented = query["hub.verify_token"]?.trim() ?? "";
  const challenge = query["hub.challenge"] ?? "";
  const tokenOk = constantTimeEquals(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
  if (query["hub.mode"] !== "subscribe" || !tokenOk || !/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) {
    return { ok: false, status: 403, code: "whatsapp_unauthorized", message: "This WhatsApp handshake was refused." };
  }
  return { ok: true, challenge };
}

/* ----------------------------------------------------------------------- inbound: the payload */

export type InboundMessage = {
  type: "message";
  phoneNumberId: string;
  /** The customer's number (`wa_id`), digits only. */
  contactId: string;
  /** The profile name the customer chose; untrusted display text. */
  contactName: string;
  /** Meta's message id (`wamid.…`): the dedupe key. */
  messageId: string;
  at: number;
  kind: MessageKind;
  /** Plain text for a text message; a fixed label such as `[image]` for anything else. */
  text: string;
};

export type InboundStatus = {
  type: "status";
  phoneNumberId: string;
  messageId: string;
  status: DeliveryStatus;
  at: number;
  /** Meta's own error title for a `failed` report, capped. */
  error: string | null;
};

export type InboundEvent = InboundMessage | InboundStatus;

export type ParsedWebhook = {
  events: InboundEvent[];
  /** Entries this parser read and chose to ignore (a reaction, an unknown field). For the log, not the page. */
  skipped: number;
};

/**
 * Labels for the message types that are not text. The label is ours: the sender's own content (a
 * caption, a file name, a location name) is never copied into the thread by this path.
 */
const UNSUPPORTED_LABELS: Readonly<Record<string, string>> = Object.freeze({
  image: "[image]",
  audio: "[voice note]",
  video: "[video]",
  document: "[document]",
  sticker: "[sticker]",
  location: "[location]",
  contacts: "[contact card]",
  button: "[button reply]",
  interactive: "[interactive reply]",
  order: "[order]",
});
const UNKNOWN_LABEL = "[unsupported message]";

/** Types that are not a customer writing to us at all. */
const IGNORED_TYPES: ReadonlySet<string> = new Set(["reaction", "system", "unknown", "request_welcome", "ephemeral"]);

const STATUS_BY_WORD: Readonly<Record<string, DeliveryStatus>> = Object.freeze({
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Meta's timestamps are Unix seconds as a string; a missing or silly one falls back to `now`. */
function atMs(value: unknown, now: number): number {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return now;
  }
  const ms = Math.trunc(seconds) * 1000;
  // A clock a day ahead of ours is a bad sender, not a message from the future.
  return ms > now + 24 * 60 * 60 * 1000 ? now : ms;
}

/** A message id is `wamid.` plus base64-ish text. Shape-checked because it becomes a unique key. */
function messageIdOf(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._=+/-]{4,256}$/.test(text) ? text : null;
}

/**
 * Read a webhook body into events. Defensive to the point of dullness: every field is optional, every
 * shape is checked, and anything unrecognised is skipped rather than thrown on, because a throw here
 * is a 500 and a 500 makes Meta retry the same delivery for a week.
 */
export function parseWebhook(payload: unknown, now: number = Date.now()): ParsedWebhook {
  const events: InboundEvent[] = [];
  let skipped = 0;
  const root = record(payload);
  if (root.object !== "whatsapp_business_account") {
    return { events, skipped: 1 };
  }
  for (const entry of list(root.entry)) {
    for (const change of list(record(entry).changes)) {
      const changeRecord = record(change);
      if (changeRecord.field !== "messages") {
        skipped += 1;
        continue;
      }
      const value = record(changeRecord.value);
      const phoneNumberId = (() => {
        const raw = record(value.metadata).phone_number_id;
        const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
        return /^\d{5,25}$/.test(text) ? text : null;
      })();
      if (!phoneNumberId) {
        skipped += 1;
        continue;
      }
      const names = new Map<string, string>();
      for (const contact of list(value.contacts)) {
        const row = record(contact);
        const waId = parseWaId(row.wa_id);
        if (waId) {
          names.set(waId, inboxDisplayText(record(row.profile).name, ""));
        }
      }
      for (const raw of list(value.messages)) {
        const message = record(raw);
        const type = typeof message.type === "string" ? message.type : "";
        const messageId = messageIdOf(message.id);
        const contactId = parseWaId(message.from);
        if (!messageId || !contactId || IGNORED_TYPES.has(type)) {
          skipped += 1;
          continue;
        }
        let kind: MessageKind = "text";
        let text = "";
        if (type === "text") {
          const body = record(message.text).body;
          text = typeof body === "string" ? body.slice(0, INBOX_CAPS.maxTextChars) : "";
          if (!text.trim()) {
            skipped += 1;
            continue;
          }
        } else {
          kind = "unsupported";
          text = UNSUPPORTED_LABELS[type] ?? UNKNOWN_LABEL;
        }
        events.push({
          type: "message",
          phoneNumberId,
          contactId,
          contactName: names.get(contactId) ?? "",
          messageId,
          at: atMs(message.timestamp, now),
          kind,
          text,
        });
      }
      for (const raw of list(value.statuses)) {
        const row = record(raw);
        const messageId = messageIdOf(row.id);
        const status = typeof row.status === "string" ? STATUS_BY_WORD[row.status] : undefined;
        if (!messageId || !status) {
          skipped += 1;
          continue;
        }
        const firstError = record(list(row.errors)[0]);
        const error =
          status === "failed"
            ? inboxDisplayText(firstError.title ?? firstError.message, "WhatsApp could not deliver this message")
            : null;
        events.push({ type: "status", phoneNumberId, messageId, status, at: atMs(row.timestamp, now), error });
      }
    }
  }
  return { events, skipped };
}

/* ---------------------------------------------------------------------------- outbound: client */

export type WhatsAppFetch = typeof globalThis.fetch;

export type WhatsAppPhoneNumber = { displayPhone: string; verifiedName: string };

export type WhatsAppSent = { messageId: string };

/** Meta error codes the page turns into its own sentence. Everything else is a plain `channel_error`. */
export const WHATSAPP_WINDOW_CLOSED_CODE = "window_closed";
/** 131047: re-engagement message. The customer service window had already closed at Meta's end. */
const GRAPH_CODE_WINDOW_CLOSED = 131047;
/** 190 and 10: the token is invalid, expired, or lacks the permission for this number. */
const GRAPH_TOKEN_CODES: ReadonlySet<number> = new Set([190, 10, 200]);

/**
 * Strip anything that looks like a Meta access token out of text on its way to a log line or an
 * ApiError. Tokens start `EAA…` and run long; a `Bearer` header is replaced wholesale too.
 */
export function redactToken(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <token>")
    .replace(/\bEAA[A-Za-z0-9]{20,}\b/g, "<token>");
}

async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return await response.text();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > WHATSAPP_MAX_RESPONSE_BYTES) {
          throw new ApiError("channel_error", "WhatsApp sent more than this client will read", 502);
        }
        chunks.push(value);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export type WhatsAppClientOptions = {
  fetchImpl?: WhatsAppFetch;
  timeoutMs?: number;
  /** Test seam only; production always resolves the pinned origin. */
  origin?: string;
};

export class WhatsAppClient {
  private readonly token: string;
  private readonly fetchImpl: WhatsAppFetch;
  private readonly timeoutMs: number;
  private readonly origin: string;

  constructor(token: string, options: WhatsAppClientOptions = {}) {
    this.token = assertAccessToken(token);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? WHATSAPP_TIMEOUT_MS;
    this.origin = options.origin ?? resolvedWhatsAppApiOrigin();
  }

  private async call(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = `${this.origin}/${WHATSAPP_GRAPH_VERSION}/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        // `manual`: a redirect would re-send the Authorization header to a host Meta did not answer from.
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError("channel_error", `WhatsApp did not answer within ${this.timeoutMs / 1000}s`, 504);
      }
      const detail = redactToken(error instanceof Error ? error.message : String(error));
      log.warn("whatsapp_call_failed", { detail });
      throw new ApiError("channel_error", `Could not reach WhatsApp: ${detail}`, 502);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError("channel_error", `WhatsApp answered with a redirect (${response.status})`, 502);
    }
    const text = await readCapped(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError("channel_error", `WhatsApp answered with something that is not JSON (${response.status})`, 502);
    }
    const failure = record(record(parsed).error);
    if (response.ok && Object.keys(failure).length === 0) {
      return parsed;
    }
    const code = typeof failure.code === "number" ? failure.code : response.status;
    const detail = typeof failure.message === "string" ? failure.message : "";
    if (code === GRAPH_CODE_WINDOW_CLOSED) {
      throw new ApiError(
        WHATSAPP_WINDOW_CLOSED_CODE,
        "WhatsApp only allows a free-form reply for 24 hours after the customer wrote",
        409,
      );
    }
    const message = detail ? `WhatsApp refused the call: ${detail}` : "WhatsApp refused the call";
    throw new ApiError(
      GRAPH_TOKEN_CODES.has(code) || response.status === 401 || response.status === 403
        ? "channel_forbidden"
        : "channel_error",
      redactToken(message),
      400,
    );
  }

  /**
   * Read one phone number. The connect route's proof that a pasted token is real **and** that it
   * reaches this number: a token with no access to the number id gets a refusal here, so a desk can
   * never register a number it does not control.
   */
  async getPhoneNumber(phoneNumberId: string): Promise<WhatsAppPhoneNumber> {
    const id = assertPhoneNumberId(phoneNumberId);
    const result = record(await this.call("GET", `${id}?fields=display_phone_number,verified_name`));
    const displayPhone = typeof result.display_phone_number === "string" ? result.display_phone_number : "";
    if (!displayPhone) {
      throw new ApiError("channel_error", "WhatsApp did not identify that phone number id", 502);
    }
    return {
      displayPhone: inboxDisplayText(displayPhone, id),
      verifiedName: inboxDisplayText(result.verified_name, ""),
    };
  }

  /** Send a free-form text. Only valid inside the customer service window; the caller checks it first. */
  async sendText(phoneNumberId: string, to: string, text: string): Promise<WhatsAppSent> {
    const id = assertPhoneNumberId(phoneNumberId);
    const recipient = parseWaId(to);
    if (!recipient) {
      throw new ApiError("invalid_request", "That customer number is not valid", 400);
    }
    const result = record(
      await this.call("POST", `${id}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: text },
      }),
    );
    const messageId = messageIdOf(record(list(result.messages)[0]).id);
    if (!messageId) {
      throw new ApiError("channel_error", "WhatsApp accepted the message but did not return its id", 502);
    }
    return { messageId };
  }
}
