import { apiFetch } from "./api-client";
import type { KeyDeferral } from "./gateway-gate";
import type { SessionStatus } from "./session";

/**
 * "Add the key later" — the renderer's half (Nultron Enterprise only, owner decision 2026-10-01).
 *
 * A signed-in hosted person with no gateway key yet may start without one. The host remembers the
 * choice per person (`users[…].keyLater` in the sealed settings payload, `POST
 * /api/v1/settings/key-later`, `keyLater` on `GET /api/v1/settings`), and `resolveGate` opens the desk
 * on it. It is a statement about what the screen shows; the host keeps refusing every
 * gateway-calling route with `403 gateway_blocked` until a key works, and the desk says so calmly
 * wherever a model call would have gone (`needs-key-note.tsx`).
 *
 * Everything below is hosted only. On the Personal app there is no session and the route answers 404,
 * so none of it can fire: a closed gate there is onboarding's key step and nothing else.
 */
export const KEY_LATER_PATH = "/api/v1/settings/key-later";

/** `keyLater` off the settings answer → whether this person chose to wait. Anything else is "no". */
export function parseKeyLater(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as { chosen?: unknown }).chosen === true;
}

/** May the onboarding key step offer "Add it later"? Only a signed-in person on the hosted build. */
export function canOfferKeyLater(hosted: boolean, status: SessionStatus): boolean {
  return hosted && status === "signed-in";
}

/**
 * What `resolveGate` needs to know besides the gate, from facts the app already holds. Empty off the
 * hosted build and for a visitor with no session, whatever the settings answer says.
 */
export function deskDeferral(hosted: boolean, status: SessionStatus, settings: unknown): KeyDeferral {
  const hasSession = canOfferKeyLater(hosted, status);
  const body = settings && typeof settings === "object" ? (settings as { keyLater?: unknown }) : null;
  return { hasSession, later: hasSession && parseKeyLater(body?.keyLater) };
}

/**
 * Tell the host the person chose to wait. Fire-and-forget by design: the desk is already opening, and
 * a host that cannot be reached must not hold it shut. Never throws; says whether it was recorded.
 * The worst case of a failed write is that the welcome shows once more on the next load.
 */
export async function recordKeyLater(): Promise<boolean> {
  try {
    const response = await apiFetch(KEY_LATER_PATH, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}
