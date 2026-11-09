/**
 * The one WhatsApp API origin this product talks to.
 *
 * Same rule as the model gateway and Telegram (`../gateway/pinned.ts`, `../channels/pinned.ts`): the
 * host is in code, the owner cannot re-point it, and the only way to aim it somewhere else is a
 * dev/test env hook that is ignored in a packaged build and in production.
 *
 * Do not import `node:crypto` here — the renderer can reach this module through
 * `@agentforge/core/inbox/pinned`.
 */

import { gatewayUrlOverrideAllowed } from "../gateway/pinned";

export const PINNED_WHATSAPP_API_ORIGIN = "https://graph.facebook.com";

/**
 * The Graph API version every call is built on. One constant, so a version Meta retires is a
 * one-line change here and not a hunt through the client. Check Meta's changelog before the first
 * live test, and bump it then.
 */
export const WHATSAPP_GRAPH_VERSION = "v23.0";

/** Dev/test only: a local mock of Meta's API, used by the sandbox drive. Never honoured in production. */
export const WHATSAPP_API_URL_ENV = "AGENTFORGE_WHATSAPP_API_URL";

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * The origin a WhatsApp call is built on.
 *
 * The override is allowed exactly where the gateway's is — a developer machine or a test — so the
 * shipped product always resolves to `PINNED_WHATSAPP_API_ORIGIN`. A malformed or non-http override
 * is ignored rather than thrown on: a broken env var must not take the whole surface down.
 */
export function resolvedWhatsAppApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  if (!gatewayUrlOverrideAllowed()) {
    return PINNED_WHATSAPP_API_ORIGIN;
  }
  const override = env[WHATSAPP_API_URL_ENV];
  if (typeof override !== "string" || !override.trim()) {
    return PINNED_WHATSAPP_API_ORIGIN;
  }
  try {
    const parsed = new URL(override.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return PINNED_WHATSAPP_API_ORIGIN;
    }
    return normalizeOrigin(override);
  } catch {
    return PINNED_WHATSAPP_API_ORIGIN;
  }
}

/** True when the process is talking to the real Meta API, which the UI and the logs both care about. */
export function isPinnedWhatsAppOrigin(origin: string): boolean {
  return normalizeOrigin(origin) === PINNED_WHATSAPP_API_ORIGIN;
}
