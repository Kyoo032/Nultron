/**
 * RFC 5322 threading (F5b): a delivery's Message-ID / In-Reply-To / References to the mail thread
 * it belongs to, and the headers an answer carries so mail clients keep it in the same thread.
 */
import { randomUUID } from "node:crypto";

const MSG_ID_RE = /<[^<>\s]+>/g;

/** All `<id>` tokens in a header value, in order. Bare ids (some providers strip the brackets) count. */
function messageIdsIn(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  const bracketed = value.match(MSG_ID_RE);
  if (bracketed && bracketed.length > 0) {
    return bracketed;
  }
  return value
    .split(/\s+/)
    .filter((token) => /^[^\s@<>]+@[^\s@<>]+$/.test(token))
    .map((token) => `<${token}>`);
}

export type ThreadHeaders = {
  /** The delivery's own `Message-ID` (`null` when it carried none). */
  messageId: string | null;
  /** The message this answers, when it names one. */
  inReplyTo: string | null;
  /** The full ancestry line the delivery sent. */
  references: string[];
  /**
   * The key this mail thread is filed under: the References root when present, else the
   * In-Reply-To target (a one-hop thread), else the message's own id (it starts a thread).
   */
  threadKey: string | null;
};

export function readThreadHeaders(headers: Record<string, unknown>): ThreadHeaders {
  const messageIds = messageIdsIn(headers["message-id"] ?? headers.message_id);
  const inReplyTos = messageIdsIn(headers["in-reply-to"]);
  const references = messageIdsIn(headers.references);
  const messageId = messageIds[0] ?? null;
  const inReplyTo = inReplyTos[inReplyTos.length - 1] ?? null;
  const threadKey = references[0] ?? inReplyTo ?? messageId;
  return { messageId, inReplyTo, references, threadKey };
}

/**
 * The headers an outbound reply needs. `references` is the received chain plus the message it
 * answers (RFC 5322 §3.6.4), so a client that threads on either header keeps the exchange together.
 */
export function replyHeaders(input: { fromDomain: string; inReplyTo: string | null; references: readonly string[] }): {
  messageId: string;
  inReplyTo?: string;
  references?: string;
} {
  const messageId = `<${randomUUID()}@${input.fromDomain}>`;
  if (!input.inReplyTo) {
    return { messageId };
  }
  const references = [...input.references, input.inReplyTo].filter((id, index, all) => all.indexOf(id) === index);
  return { messageId, inReplyTo: input.inReplyTo, references: references.join(" ") };
}
