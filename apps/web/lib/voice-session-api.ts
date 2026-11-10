/**
 * Live voice, the two ways to the host: H1 (`POST /api/v1/voice/sessions`, through `apiFetch` so it
 * carries the transport and CSRF headers) and the address of H2, the WebSocket the audio rides.
 */

import type { VoiceMode, VoiceSessionCreated, VoiceSessionRequest } from "@agentforge/core/voice";
import { apiFetch } from "./api-client";
import { voiceRefusalCode } from "./voice-errors";
import type { VoiceErrorCode } from "./voice-view-state";

export type OpenVoiceSessionResult =
  | { readonly ok: true; readonly session: VoiceSessionCreated }
  | { readonly ok: false; readonly code: VoiceErrorCode };

function parseCreated(body: unknown): VoiceSessionCreated | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  return typeof record.sessionId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.model === "string" &&
    typeof record.streamPath === "string" &&
    typeof record.endsAt === "number"
    ? {
        sessionId: record.sessionId,
        threadId: record.threadId,
        model: record.model,
        streamPath: record.streamPath,
        endsAt: record.endsAt,
      }
    : null;
}

/**
 * H1. A `201` with a well-formed body is a session; a refusal is mapped to its `error.<code>` line;
 * a dead network or a body that is neither is `connect`.
 */
export async function openVoiceSession(
  threadId: string,
  mode: VoiceMode,
  fetcher: typeof apiFetch = apiFetch,
): Promise<OpenVoiceSessionResult> {
  const request: VoiceSessionRequest = mode === "hands_free" ? { threadId } : { threadId, mode };
  let response: Response;
  try {
    response = await fetcher("/api/v1/voice/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, code: "connect" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201) {
    const session = parseCreated(body);
    return session ? { ok: true, session } : { ok: false, code: "connect" };
  }
  return { ok: false, code: voiceRefusalCode(body) };
}

/**
 * The WebSocket address for a session's `streamPath`, on the page's own origin: `wss:` under
 * `https:`, `ws:` under `http:`. A path that is not a path of this origin is not used.
 */
export function voiceSocketUrl(
  location: { readonly protocol: string; readonly host: string },
  streamPath: string,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const path =
    streamPath.startsWith("/") && !streamPath.startsWith("//") ? streamPath : `/${streamPath.replace(/^\/+/, "")}`;
  return `${scheme}//${location.host}${path}`;
}
