/**
 * The voice WebSocket. An upgrade never passes the HTTP router, so this redoes the checks a
 * mutating request would have had: https on the hosted server, Origin, the session cookie, the
 * tenant, then the voice session itself. Any other path is left untouched so Vite's HMR socket
 * still receives it.
 */
import type { Duplex } from "node:stream";
import type { IncomingMessage, Server } from "node:http";
import { isServerMode, trustedOrigins } from "@agentforge/core";
import { VOICE_MAX_AUDIO_FRAME_BYTES, VOICE_STREAM_PATH_PATTERN } from "@agentforge/core/voice";
import { WebSocketServer } from "ws";
import { hostPortalCheck, hostSessionStore, requireSessionFor, type PortalSessionCheck, type SessionStore } from "../auth";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { isAllowedMutatingApiRequest, isAllowedWebOrigin } from "../local-request";
import { getTenant } from "../tenant";
import type { HostRequest } from "../types";
import { readSelectedWorkspaceId } from "../workspace";
import { voiceSettingsFor } from "./flag";
import { VoiceRelay } from "./relay";
import { sameVoiceOwner, voiceSessions } from "./sessions";

export type VoiceUpgradeOptions = {
  serverMode?: boolean;
  sessionStore?: SessionStore;
  now?: () => number;
  portalCheck?: PortalSessionCheck;
};

const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: VOICE_MAX_AUDIO_FRAME_BYTES,
  perMessageDeflate: false,
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Status only. The words are the stock reason phrase, never a session id or why it failed. */
function refuse(socket: Duplex, status: 401 | 403 | 404): void {
  if (socket.destroyed) return;
  const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Forbidden";
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
      socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

/**
 * Hooks the voice stream onto `server`. One argument in production. Tests pass the session store
 * and the clock the HTTP gate would have been given.
 */
export function attachVoiceUpgrade(server: Server, options: VoiceUpgradeOptions = {}): void {
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      return;
    }
    const match = VOICE_STREAM_PATH_PATTERN.exec(pathname);
    if (!match) return;
    const sessionId = match[1] ?? "";
    const serverMode = options.serverMode ?? isServerMode();
    if (serverMode) {
      const proto = header(req, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
      if (proto !== "https") {
        refuse(socket, 403);
        return;
      }
    }
    const origin = header(req, "origin");
    if (!origin?.trim()) {
      refuse(socket, 403);
      return;
    }
    const originAllowed = serverMode
      ? isAllowedWebOrigin(origin, trustedOrigins())
      : isAllowedMutatingApiRequest(origin);
    if (!originAllowed) {
      refuse(socket, 403);
      return;
    }
    const request: HostRequest = {
      method: "GET",
      path: pathname,
      query: {},
      params: {},
      headers: {
        origin,
        cookie: header(req, "cookie"),
      },
      workspaceId: readSelectedWorkspaceId() ?? null,
    };
    void accept(req, socket, head, request, sessionId, serverMode, options);
  });
}

async function accept(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  request: HostRequest,
  sessionId: string,
  serverMode: boolean,
  options: VoiceUpgradeOptions,
): Promise<void> {
  try {
    if (serverMode) {
      const record = await requireSessionFor(request, {
        store: options.sessionStore ?? hostSessionStore(),
        now: options.now,
        portalCheck: options.portalCheck ?? hostPortalCheck(),
      });
      request.session = {
        id: record.id,
        tenantId: record.tenantId,
        orgId: record.orgId,
        userId: record.userId,
      };
    }
    const tenant = await getTenant(request);
    const voice = voiceSessions().get(sessionId);
    if (!voice || voice.endedReason || voice.attached || !sameVoiceOwner(voice, tenant)) {
      refuse(socket, 404);
      return;
    }
    if (!voiceSettingsFor(tenant).enabled) {
      refuse(socket, 403);
      return;
    }
    try {
      requireGatewayAllowedFor(tenant);
    } catch {
      refuse(socket, 403);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const relay = new VoiceRelay(ws, voice);
      void relay.start();
    });
  } catch {
    refuse(socket, 401);
  }
}
