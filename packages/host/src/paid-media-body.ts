import { isPaidMediaTool, mediaRequestArgs, type MediaPermissionPolicy, type MediaRequest } from "@agentforge/core";

/**
 * Paid media permission (SR-167), host side. Every model-driven turn asks before a picture or a clip is
 * made. A turn's body may carry the requests the person pressed Run on: the screen sends them when the
 * card's Run is pressed, never the model. Each one lets a single call with the same arguments through.
 */

/** More than this in one body is a hand-made request, not a card list; the rest is dropped. */
export const PAID_MEDIA_GRANTS_MAX = 12;

function grantOf(value: unknown): MediaRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { tool, args } = value as { tool?: unknown; args?: unknown };
  if (typeof tool !== "string" || !isPaidMediaTool(tool)) {
    return null;
  }
  const picked = mediaRequestArgs(tool, args);
  // A request with no prompt is not one a card could have shown.
  return typeof picked.prompt === "string" ? { tool, args: picked } : null;
}

/** The policy of one turn: always asking, with the grants the body carries. */
export function readMediaPermission(body: unknown): MediaPermissionPolicy {
  const raw = body && typeof body === "object" ? (body as { paidMedia?: unknown }).paidMedia : undefined;
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { grants?: unknown }).grants)
      ? ((raw as { grants: unknown[] }).grants as unknown[])
      : [];
  const grants: MediaRequest[] = [];
  for (const entry of list) {
    const grant = grantOf(entry);
    if (grant) {
      grants.push(grant);
    }
    if (grants.length >= PAID_MEDIA_GRANTS_MAX) {
      break;
    }
  }
  return { ask: true, grants };
}
