/**
 * The WhatsApp webhook — the one route a stranger on the internet can POST to.
 *
 *   GET  /api/v1/channels/whatsapp/webhook   ← Meta's subscription handshake.
 *   POST /api/v1/channels/whatsapp/webhook   ← Meta's deliveries: customer messages and delivery reports.
 *
 * Both skip the session gate and the CSRF rule (`UNGATED_GETS`, `UNGATED_POSTS`, `CSRF_EXEMPT_PATHS`),
 * because Meta's servers have no cookie jar. What replaces them, in this order:
 *
 *  1. **The body is read raw and small** (`http-adapter.ts`): 1 MB, unparsed.
 *  2. **The signature is checked before a byte is parsed.** HMAC-SHA256 under the install's Meta app
 *     secret, compared in constant time. No secret configured means every delivery is refused, loudly.
 *  3. **The desk is whatever the endpoint row says.** The payload names a phone number id; that id is
 *     looked up among the numbers owners have connected, and the row's workspace is the only desk this
 *     request may write to. A payload cannot name a desk, and an unknown number is dropped with a 200
 *     so Meta does not retry it for a week.
 *  4. **Redelivery is harmless.** Meta delivers at least once; the second copy of a message is
 *     refused by a unique index inside the same transaction.
 *
 * Nothing here calls a model or sends anything (Phase 1). Phase 2 hooks the answer pipeline in after
 * the message is stored, outside the request, once this route has answered 200.
 *
 * No log line carries a customer's number or words: counts only.
 */

import { ApiError, isServerMode } from "@agentforge/core";
import { jsonError, jsonOk } from "../errors";
import { log } from "../log";
import type { HostRequest, HostResult } from "../types";
import { inboxStore } from "./db";
import type { EndpointRow, InboxStore } from "./store";
import { parseWebhook, verifyHandshake, verifySignature } from "./whatsapp";
import { WHATSAPP_SIGNATURE_HEADER } from "./webhook-path";

export type WebhookDeps = {
  store?: InboxStore;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

/** Meta's handshake: echo the challenge as plain text when the verify token matches. */
export function handleWhatsAppWebhookGet(request: HostRequest, deps: WebhookDeps = {}): HostResult {
  const verdict = verifyHandshake(request.query, deps.env ?? process.env);
  if (!verdict.ok) {
    log.warn("whatsapp_handshake_refused", { code: verdict.code });
    return jsonError(new ApiError(verdict.code, verdict.message, verdict.status));
  }
  return {
    type: "bytes",
    status: 200,
    bytes: new TextEncoder().encode(verdict.challenge),
    contentType: "text/plain; charset=utf-8",
  };
}

export type WebhookTally = {
  messages: number;
  duplicates: number;
  statuses: number;
  /** Events for a number no desk has connected (or one that was disconnected). */
  unknownNumber: number;
  /** Delivery reports for a message this endpoint does not hold. */
  unknownMessage: number;
  skipped: number;
};

export async function handleWhatsAppWebhookPost(request: HostRequest, deps: WebhookDeps = {}): Promise<HostResult> {
  try {
    const env = deps.env ?? process.env;
    const verdict = verifySignature(request.rawBody, request.headers[WHATSAPP_SIGNATURE_HEADER], env);
    if (!verdict.ok) {
      // 401 rather than 403: Meta's dashboard shows the operator which of the two it is. Not
      // configured is a 503, because the fix is the operator's and a retry will not help until then.
      log.warn("whatsapp_webhook_rejected", { code: verdict.code });
      throw new ApiError(verdict.code, verdict.message, verdict.code === "whatsapp_not_configured" ? 503 : 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(request.rawBody ?? new Uint8Array()).toString("utf8"));
    } catch {
      // Signed but not JSON: a broken sender, not something a retry fixes.
      throw new ApiError("invalid_json", "This WhatsApp delivery is not valid JSON.", 400);
    }

    const store = deps.store ?? inboxStore();
    const now = (deps.now ?? Date.now)();
    const parsed = parseWebhook(payload, now);
    const tally: WebhookTally = {
      messages: 0,
      duplicates: 0,
      statuses: 0,
      unknownNumber: 0,
      unknownMessage: 0,
      skipped: parsed.skipped,
    };
    // One lookup per number per delivery. `null` is remembered too, so a flood for an unknown number
    // costs one query.
    const endpoints = new Map<string, EndpointRow | null>();
    const endpointFor = (phoneNumberId: string): EndpointRow | null => {
      if (!endpoints.has(phoneNumberId)) {
        endpoints.set(phoneNumberId, store.findActiveEndpoint("whatsapp", phoneNumberId));
      }
      return endpoints.get(phoneNumberId) ?? null;
    };

    for (const event of parsed.events) {
      const endpoint = endpointFor(event.phoneNumberId);
      if (!endpoint) {
        tally.unknownNumber += 1;
        continue;
      }
      if (event.type === "message") {
        const outcome = store.recordInbound(endpoint, event, now);
        if (outcome.duplicate) {
          tally.duplicates += 1;
        } else {
          tally.messages += 1;
        }
      } else if (store.applyStatus(endpoint, event)) {
        tally.statuses += 1;
      } else {
        tally.unknownMessage += 1;
      }
    }

    // Counts only. A customer's number or words never reach a log line.
    // (`messages` is a field name the logger drops on purpose, so the count is called `received`.)
    log.info("whatsapp_webhook_handled", {
      received: tally.messages,
      duplicates: tally.duplicates,
      reports: tally.statuses,
      unknownNumber: tally.unknownNumber,
      unknownMessage: tally.unknownMessage,
      skipped: tally.skipped,
      hosted: isServerMode(),
    });
    // 200 for everything authenticated and parseable, including numbers we do not know: a non-2xx is
    // "retry", and retrying a delivery this host has deliberately dropped is a loop.
    return jsonOk(tally);
  } catch (error) {
    return jsonError(error);
  }
}
