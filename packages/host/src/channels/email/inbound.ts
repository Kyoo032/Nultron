/**
 * The email webhook — `POST /api/v1/channels/email/webhook`, the second route a stranger on the
 * internet may POST to (after WhatsApp's). It skips the session gate and the CSRF rule
 * (`UNGATED_POSTS`, `CSRF_EXEMPT_PATHS`); what replaces them, in this order:
 *
 *  1. **The signature is checked before a byte is parsed.** `x-agentforge-email-signature` is
 *     `sha256=` plus the hex HMAC-SHA256 of the raw body under `AGENTFORGE_EMAIL_WEBHOOK_SECRET`,
 *     compared in constant time. No secret configured means every delivery is refused (503 — the
 *     fix is the operator's).
 *  2. **The desk is whatever the channel row says.** The delivery's `to` names an address; that
 *     address is looked up among the channels owners have created, and the row's workspace is the
 *     only desk this request may write to. A delivery cannot name a desk, and mail for an unknown
 *     address is dropped with a 200 so the provider does not retry it.
 *  3. **An auto-reply is never answered** (`Auto-Submitted`, `Precedence`, auto-responder markers)
 *     — answering one is how two mail daemons loop.
 *  4. **Redelivery is harmless.** The provider's message id is `email_inbound_seen`'s primary key;
 *     a second copy is refused by the insert itself before any work starts.
 *  5. **The sender must be let in.** The allowlist maps an address or a domain to a Nultron user;
 *     an unknown sender is ignored or politely refused (`unknown_sender_policy`) and logged.
 *  6. **A cap and a size bound** apply per sender per hour and per body.
 *
 * The reply run happens after the 200, outside the request — a provider's redelivery window is
 * seconds, and a model answer is not. No log line carries a sender's address or words: counts and
 * the sender's sha256 only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { ApiError, isServerMode } from "@agentforge/core";
import { jsonError } from "../../errors";
import { log } from "../../log";
import type { HostRequest, HostResult } from "../../types";
import { reportAuditEvent, type TenantContext } from "@agentforge/core";
import { EMAIL_MAX_BODY_CHARS, EMAIL_SIGNATURE_HEADER, EMAIL_WEBHOOK_SECRET_ENV } from "./path";
import { matchAllowlist, senderAddressOf } from "./identity";
import { isAutoSubmitted, SenderCap, maxPerSenderHour, senderHash } from "./loop-guard";
import { readThreadHeaders, replyHeaders } from "./threading";
import { createMailer, replySubject, type Mailer } from "./outbound";
import { resolveEmailActor, resolveTenantId } from "./tenant";
import { runEmailReply } from "./run";
import { createThread } from "../../threads";
import { sql } from "@agentforge/db";
import type { EmailStore } from "./store";

export type EmailWebhookDeps = {
  store: EmailStore;
  env?: NodeJS.ProcessEnv;
  mailer?: Mailer | null;
  cap?: SenderCap;
  /** Test seam: the app database; tests hand a scratch one. */
  db?: Pick<Database.Database, "prepare">;
  /** Test seam: when set, the reply is computed but not mailed. */
  sendReply?: (args: {
    mailer: Mailer;
    to: string;
    subject: string;
    text: string;
    fromAddress: string;
    messageId: string;
    inReplyTo?: string;
    references?: string;
  }) => Promise<void>;
  /** Test seam: replaces the headless run. */
  runReply?: typeof runEmailReply;
  /** Test seam: opens the chat thread a new mail thread maps to (default `createThread`). */
  openThread?: (input: { tenantId: TenantContext; agentId: string; title: string }) => Promise<{ id: string }>;
};

export type EmailDelivery = {
  /** The provider's id for this mail — the dedupe key. */
  providerMessageId: string;
  to: string;
  headers: Record<string, unknown>;
  subject?: unknown;
  /** The sender's plain-text body. Attachments are not taken yet (F7a). */
  text?: unknown;
  /**
   * The relay's authenticated envelope sender (`from`, `sender` or `envelope_sender` at the
   * payload's top level), set by the relay — never by the mail. Wins over `headers.from`, which
   * a sender can forge.
   */
  envelopeSender?: string;
};

type Verdict = { ok: true } | { ok: false; code: string; message: string; status: number };

export function verifyEmailSignature(
  rawBody: Uint8Array | undefined,
  header: unknown,
  env: NodeJS.ProcessEnv,
): Verdict {
  const secret = env[EMAIL_WEBHOOK_SECRET_ENV];
  if (!secret) {
    return { ok: false, code: "email_not_configured", message: "Email webhook is not configured.", status: 503 };
  }
  const value = typeof header === "string" ? header.trim() : "";
  const presented = value.startsWith("sha256=") ? value.slice(7) : "";
  const expected = createHmac("sha256", secret)
    .update(rawBody ?? new Uint8Array())
    .digest("hex");
  const ok =
    presented.length === expected.length &&
    timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
  if (!ok) {
    return { ok: false, code: "bad_signature", message: "The email delivery's signature is invalid.", status: 401 };
  }
  return { ok: true };
}

/** Normalize the provider's delivery. Field names follow the simplest JSON shape; the provider adapter maps its own onto these. */
function readDelivery(payload: unknown): EmailDelivery | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  const headers =
    typeof body.headers === "object" && body.headers !== null ? (body.headers as Record<string, unknown>) : {};
  const providerMessageId =
    typeof body.provider_message_id === "string"
      ? body.provider_message_id
      : typeof headers["message-id"] === "string"
        ? (headers["message-id"] as string)
        : "";
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!providerMessageId || !to) {
    return null;
  }
  const envelopeField = body.from ?? body.sender ?? body.envelope_sender;
  const envelopeSender = senderAddressOf(typeof envelopeField === "string" ? envelopeField : undefined) ?? undefined;
  return { providerMessageId, to, headers, subject: body.subject, text: body.text, envelopeSender };
}

export type EmailWebhookTally = {
  delivered: number;
  duplicates: number;
  unknownAddress: number;
  autoSubmitted: number;
  unknownSender: number;
  capped: number;
  refused: number;
  malformed: number;
};

/**
 * The audit row for one delivery: `channel.trigger` with the outcome in `outcome` (ok/denied/failed)
 * and the why in `rule`. `refHash` is the channel id plus the sender's sha256 — never the sender.
 */
const audit = (
  db: Pick<Database.Database, "prepare">,
  channel: { id: string; workspaceId: string; agentId: string },
  outcome: "ok" | "denied" | "failed",
  rule: string,
  refHash: string,
) => {
  try {
    reportAuditEvent({
      tenantId: resolveTenantId(db, channel.workspaceId) ?? channel.workspaceId,
      event: "channel.trigger",
      actorKind: "system",
      agentId: channel.agentId,
      channel: "email",
      outcome,
      rule,
      refHash: refHash ? `${channel.id}:${refHash}` : channel.id,
    });
  } catch {
    // Audit is written where the desk can write it; a read-only desk never blocks mail.
  }
};

export function handleEmailWebhook(request: HostRequest, deps: EmailWebhookDeps): Promise<HostResult> {
  return handleEmailWebhookInner(request, deps).catch((error: unknown) => {
    if (error instanceof ApiError) {
      log.warn("email_webhook_rejected", { code: error.code });
      return jsonError(error);
    }
    log.warn("email_webhook_failed", { detail: error instanceof Error ? error.name : "unknown" });
    return jsonError(new ApiError("email_webhook_failed", "The email delivery could not be processed.", 500));
  });
}

async function handleEmailWebhookInner(request: HostRequest, deps: EmailWebhookDeps): Promise<HostResult> {
  const env = deps.env ?? process.env;
  const verdict = verifyEmailSignature(request.rawBody, request.headers[EMAIL_SIGNATURE_HEADER], env);
  if (!verdict.ok) {
    throw new ApiError(verdict.code, verdict.message, verdict.status);
  }
  if (!isServerMode()) {
    throw new ApiError("email_off_desk", "The email channel runs on the hosted desk.", 403);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(request.rawBody ?? new Uint8Array()).toString("utf8"));
  } catch {
    throw new ApiError("invalid_json", "This email delivery is not valid JSON.", 400);
  }
  const deliveries = Array.isArray(payload) ? payload : [payload];
  const store = deps.store;
  const db = deps.db ?? sql;
  const cap = deps.cap ?? new SenderCap(maxPerSenderHour(env));
  const tally: EmailWebhookTally = {
    delivered: 0,
    duplicates: 0,
    unknownAddress: 0,
    autoSubmitted: 0,
    unknownSender: 0,
    capped: 0,
    refused: 0,
    malformed: 0,
  };

  for (const item of deliveries) {
    const delivery = readDelivery(item);
    if (!delivery) {
      tally.malformed += 1;
      continue;
    }
    const channel = store.findChannelByAddress(delivery.to);
    if (!channel) {
      tally.unknownAddress += 1;
      continue;
    }
    if (isAutoSubmitted(delivery.headers)) {
      tally.autoSubmitted += 1;
      audit(db, channel, "denied", "auto_submitted", "");
      continue;
    }
    // The dedupe insert is the single point that makes a redelivery harmless: the provider's id is
    // the primary key, so the second copy loses the race before any other work runs.
    if (!store.markInboundSeen(delivery.providerMessageId, channel.id, Date.now())) {
      tally.duplicates += 1;
      audit(db, channel, "ok", "duplicate", "");
      continue;
    }

    const sender = delivery.envelopeSender ?? senderAddressOf(delivery.headers.from);
    const hash = sender ? senderHash(sender) : "";
    if (!sender || !cap.admit(channel.id, hash)) {
      tally.capped += 1;
      audit(db, channel, "denied", "capped", hash);
      continue;
    }
    const entry = matchAllowlist(store.listAllowlist(channel.id), sender);
    if (!entry) {
      tally.unknownSender += 1;
      audit(db, channel, "denied", "unknown_sender", hash);
      if (channel.unknownSenderPolicy === "refuse") {
        tally.refused += 1;
        const mailer = deps.mailer === undefined ? createMailer(env) : deps.mailer;
        if (mailer) {
          const headers = replyHeaders({
            fromDomain: channel.address.split("@")[1] ?? "",
            inReplyTo: readThreadHeaders(delivery.headers).messageId,
            references: [],
          });
          const send =
            deps.sendReply ??
            ((args: Parameters<NonNullable<EmailWebhookDeps["sendReply"]>>[0]) => args.mailer.send(args));
          void send({
            mailer,
            to: sender,
            subject: replySubject(typeof delivery.subject === "string" ? delivery.subject : null),
            text: "This address is not on the allowlist for this agent's mailbox.",
            fromAddress: channel.address,
            messageId: headers.messageId,
            inReplyTo: headers.inReplyTo,
          }).catch(() => {
            log.warn("email_refusal_send_failed", { channelId: channel.id });
          });
        }
      }
      continue;
    }

    tally.delivered += 1;
    const threadHeaders = readThreadHeaders(delivery.headers);
    const subject = typeof delivery.subject === "string" ? delivery.subject.slice(0, 200) : "E-mail";
    const text = typeof delivery.text === "string" ? delivery.text.slice(0, EMAIL_MAX_BODY_CHARS) : "";
    if (!text.trim()) {
      audit(db, channel, "denied", "empty_body", hash);
      continue;
    }

    // The reply runs outside the request — the 200 below is already the answer the provider needs.
    void (async () => {
      const actor = resolveEmailActor(db, channel.workspaceId, entry.userId, channel.agentId);
      if (!actor) {
        // The allowlisted user left the desk — a redelivery cannot fix that, so the mark stays.
        audit(db, channel, "failed", "no_actor", hash);
        return;
      }
      // A mail in an already-filed mail thread reuses its chat thread — the mapping is per
      // user, so two allowlisted senders in one mail conversation never share a chat. A mapping
      // whose chat thread was deleted is dropped and refiled.
      const existing = threadHeaders.threadKey
        ? store.findThread(channel.id, threadHeaders.threadKey, actor.tenant.userId)
        : null;
      let threadId = "";
      if (existing) {
        const alive = db.prepare(`SELECT id FROM threads WHERE id = ?`).get(existing.threadId) as
          | { id: string }
          | undefined;
        if (alive) {
          threadId = existing.threadId;
        } else {
          store.removeThread(existing.id);
        }
      }
      if (!threadId) {
        const openThread = deps.openThread ?? ((input) => createThread(input.tenantId, input.agentId, input.title));
        const thread = await openThread({ tenantId: actor.tenant, agentId: channel.agentId, title: subject });
        threadId = thread.id;
        if (threadHeaders.threadKey) {
          store.createThread(channel.id, threadId, threadHeaders.threadKey, actor.tenant.userId);
        }
      }
      // Anything transient from here on unmarks the dedupe row, so the provider's redelivery
      // gets another attempt once capacity or configuration recovers.
      const retry = () => store.unmarkInboundSeen(delivery.providerMessageId, channel.id);
      const runReply = deps.runReply ?? runEmailReply;
      const result = await runReply({
        tenant: actor.tenant,
        threadId,
        body: text,
      });
      if (result.kind === "refused") {
        if (result.reason !== "injection") {
          retry();
        }
        audit(db, channel, result.reason === "injection" ? "denied" : "failed", result.reason, hash);
        return;
      }
      const mailer = deps.mailer === undefined ? createMailer(env) : deps.mailer;
      if (!mailer) {
        retry();
        audit(db, channel, "failed", "unconfigured", hash);
        return;
      }
      const headers = replyHeaders({
        fromDomain: channel.address.split("@")[1] ?? "",
        inReplyTo: threadHeaders.messageId,
        references: threadHeaders.references,
      });
      const send =
        deps.sendReply ?? ((args: Parameters<NonNullable<EmailWebhookDeps["sendReply"]>>[0]) => args.mailer.send(args));
      try {
        await send({
          mailer,
          to: sender,
          subject: replySubject(typeof delivery.subject === "string" ? delivery.subject : null),
          text: result.text,
          fromAddress: channel.address,
          messageId: headers.messageId,
          inReplyTo: headers.inReplyTo,
          references: headers.references,
        });
        audit(db, channel, "ok", "replied", hash);
      } catch {
        retry();
        audit(db, channel, "failed", "send_failed", hash);
      }
    })().catch(() => {
      // The async reply never fails the delivery.
    });
  }

  log.info("email_webhook", { ...tally });
  return { type: "json", status: 200, body: { ok: true } };
}
