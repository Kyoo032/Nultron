/**
 * H1 opens a voice session. H3 ends one. Neither calls the gateway: H1 only checks the gate is
 * open, and the talker is opened later, on the socket.
 */
import { ApiError } from "@agentforge/core";
import {
  VOICE_MODES,
  type VoiceMode,
  type VoiceSessionCreated,
  voiceStreamPath,
} from "@agentforge/core/voice";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { localeForRun } from "../run-context";
import { getThread } from "../threads";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";
import { voiceSettingsFor } from "../voice/flag";
import { sameVoiceOwner, voiceSessions } from "../voice/sessions";
import type { VoiceLocale } from "../voice/turns";
import { voiceWiring } from "../voice/wiring";

function voiceLocale(): VoiceLocale {
  return localeForRun() === "id" ? "id" : "en";
}

function copy(locale: VoiceLocale): {
  disabled: string;
  limit: string;
  unavailable: string;
  threadId: string;
  mode: string;
} {
  if (locale === "id") {
    return {
      disabled: "Mode suara dimatikan.",
      limit: "Terlalu banyak sesi suara.",
      unavailable: "Mode suara belum tersedia.",
      threadId: "threadId wajib diisi.",
      mode: "mode tidak dikenal.",
    };
  }
  return {
    disabled: "Voice is turned off.",
    limit: "Too many voice sessions are open.",
    unavailable: "Voice is not available yet.",
    threadId: "threadId is required.",
    mode: "mode is not a voice mode.",
  };
}

/** `POST /api/v1/voice/sessions`. */
export async function handlePostVoiceSession(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const locale = voiceLocale();
    const text = copy(locale);
    const body = (request.body ?? {}) as { threadId?: unknown; mode?: unknown };
    if (typeof body.threadId !== "string" || body.threadId.trim() === "") {
      throw new ApiError("invalid_request", text.threadId, 400);
    }
    const mode = parseMode(body.mode, text.mode);
    const settings = voiceSettingsFor(tenant);
    const model = settings.model;
    if (!settings.enabled || !model) {
      throw new ApiError("voice_disabled", text.disabled, 403);
    }
    const thread = await getThread(tenant, body.threadId);
    if (!thread) {
      throw new ApiError("not_found", "Thread not found", 404);
    }
    requireGatewayAllowedFor(tenant);
    if (voiceSessions().atCap(tenant)) {
      throw new ApiError("voice_session_limit", text.limit, 429);
    }
    const models = voiceWiring().modelsFor(tenant, model);
    if (!models) {
      throw new ApiError("voice_model_unavailable", text.unavailable, 503);
    }
    const opened = voiceSessions().open({
      tenant,
      threadId: body.threadId,
      mode,
      locale,
      model,
      talker: models.talker,
      transcriber: models.transcriber,
      transcriberModel: models.transcriberModel,
    });
    if (!opened.ok) {
      throw new ApiError("voice_session_limit", text.limit, 429);
    }
    const created: VoiceSessionCreated = {
      sessionId: opened.session.id,
      threadId: opened.session.threadId,
      model: opened.session.model,
      streamPath: voiceStreamPath(opened.session.id),
      endsAt: opened.session.endsAt,
    };
    return jsonOk(created, 201);
  } catch (error) {
    return jsonError(error);
  }
}

function parseMode(value: unknown, message: string): VoiceMode {
  if (value === undefined) return "hands_free";
  if (typeof value === "string" && VOICE_MODES.includes(value as VoiceMode)) return value as VoiceMode;
  throw new ApiError("invalid_request", message, 400);
}

/**
 * `POST /api/v1/voice/sessions/:id/end`. Idempotent. A missing session and someone else's session
 * are the same 404, including when voice is switched off, so the id is not an oracle.
 */
export async function handlePostVoiceSessionEnd(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const id = request.params.id ?? "";
    const session = voiceSessions().get(id);
    if (!session || !sameVoiceOwner(session, tenant)) {
      throw new ApiError("not_found", "Voice session not found", 404);
    }
    const ended = voiceSessions().end(id, "user");
    return jsonOk({ minutes: ended?.minutes ?? session.minutes });
  } catch (error) {
    return jsonError(error);
  }
}
