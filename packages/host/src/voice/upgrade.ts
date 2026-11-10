/**
 * The voice WebSocket. An upgrade never passes the HTTP router, so this redoes the checks a
 * mutating request would have had, in the adapter's own words: the Host rule, https and the request
 * filter and the rate bucket on the hosted server, Origin, the session cookie, the tenant on the
 * desk the workspace cookie names, then the voice session itself. Any other path is left untouched
 * so Vite's HMR socket still receives it.
 */
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { ApiError, isServerMode, trustedOrigins } from "@agentforge/core";
import { VOICE_MAX_AUDIO_FRAME_BYTES, VOICE_STREAM_PATH_PATTERN } from "@agentforge/core/voice";
import { WebSocketServer } from "ws";
import { hostPortalCheck, hostSessionStore, requireSessionFor, type PortalSessionCheck, type SessionStore } from "../auth";
import { sessionCookieName } from "../auth/session";
import { requireGatewayAllowedFor } from "../gateway-gate";
import {
  FILTERED_EVENT,
  hostRejection,
  parseCookies,
  requestWorkspaceId,
  transportRejection,
} from "../http-adapter";
import { isAllowedMutatingApiRequest, isAllowedWebOrigin } from "../local-request";
import { log } from "../log";
import { clientIp, sessionRateKey } from "../rate-limit";
import { getTenant } from "../tenant";
import type { HostRequest } from "../types";
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

type Refusal = {
  readonly status: number;
  /** A reason code for the log line. Never written to the socket. */
  readonly code: string;
  readonly retryAfterSeconds?: number;
};

/** What a refused upgrade may say about itself in the log: no path, no session id, no cookie. */
type Context = { readonly pathLength: number; readonly ip: string | null; readonly serverMode: boolean };

/**
 * Status only. The words are the stock reason phrase, never a session id or why it failed. The hosted
 * server leaves the same `request_filtered` line the adapter writes for a refused request.
 */
function refuse(socket: Duplex, refusal: Refusal, context: Context): void {
  if (context.serverMode) {
    log.warn(FILTERED_EVENT, {
      code: refusal.code,
      status: refusal.status,
      method: "GET",
      pathLength: context.pathLength,
      ip: context.ip,
    });
  }
  if (socket.destroyed) return;
  const retry = refusal.retryAfterSeconds === undefined ? "" : `Retry-After: ${refusal.retryAfterSeconds}\r\n`;
  try {
    socket.write(
      `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status] ?? "Forbidden"}\r\nConnection: close\r\n${retry}Content-Length: 0\r\n\r\n`,
      () => {
        socket.destroy();
      },
    );
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
    const cookies = parseCookies(req);
    const ip = clientIp({
      forwardedFor: header(req, "x-forwarded-for"),
      remoteAddress: req.socket?.remoteAddress,
      serverMode,
    });
    const context: Context = { pathLength: pathname.length, ip, serverMode };

    // 1. Host: loopback off the hosted server, a trusted host on it. The adapter's own function.
    const host = hostRejection(header(req, "host"), serverMode);
    if (host) {
      refuse(socket, { status: 403, code: host.code }, context);
      return;
    }
    // 2. The hosted transport rules: the https hop, the request filter, the per-IP and per-session
    //    buckets. The adapter's own function, so a socket is metered like every other request.
    if (serverMode) {
      const rejection = transportRejection(
        req,
        pathname,
        (req.method ?? "GET").toUpperCase(),
        ip,
        sessionRateKey(cookies[sessionCookieName({ secure: true })]),
      );
      if (rejection) {
        refuse(socket, rejection, context);
        return;
      }
    }
    // 3. Origin. A browser WebSocket cannot set a header, so the double-submit CSRF token has nowhere
    //    to ride; the browser always states the page's Origin and a page cannot forge it, which makes
    //    this allowlist the cross-site WebSocket hijacking defence. A missing Origin is refused in
    //    both modes: the adapter's desk rule would let curl through, but a socket is only ever opened
    //    by the page.
    const origin = header(req, "origin");
    if (!origin?.trim()) {
      refuse(socket, { status: 403, code: "origin_forbidden" }, context);
      return;
    }
    const originAllowed = serverMode
      ? isAllowedWebOrigin(origin, trustedOrigins())
      : isAllowedMutatingApiRequest(origin);
    if (!originAllowed) {
      refuse(socket, { status: 403, code: "origin_forbidden" }, context);
      return;
    }
    // 4. The request H1 would have been: the same cookies, and so the same desk.
    const request: HostRequest = {
      method: "GET",
      path: pathname,
      query: {},
      params: {},
      headers: {
        origin,
        cookie: header(req, "cookie"),
      },
      workspaceId: requestWorkspaceId(cookies),
    };
    void accept(req, socket, head, request, sessionId, serverMode, options, context);
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
  context: Context,
): Promise<void> {
  try {
    if (serverMode) {
      try {
        const record = await requireSessionFor(request, {
          store: options.sessionStore ?? hostSessionStore(),
          now: options.now,
          portalCheck: options.portalCheck ?? hostPortalCheck(),
          // The cookie name follows the mode the rules above ran in, not a second read of the environment.
          serverMode,
        });
        request.session = {
          id: record.id,
          tenantId: record.tenantId,
          orgId: record.orgId,
          userId: record.userId,
        };
      } catch (error) {
        refuse(socket, { status: 401, code: error instanceof ApiError ? error.code : "session_invalid" }, context);
        return;
      }
    }
    let tenant: Awaited<ReturnType<typeof getTenant>>;
    try {
      tenant = await getTenant(request);
    } catch (error) {
      // A desk the person does not own, or an account that is switched off: what the router answers.
      const status = error instanceof ApiError && (error.status === 403 || error.status === 404) ? error.status : 401;
      refuse(socket, { status, code: error instanceof ApiError ? error.code : "tenant_unavailable" }, context);
      return;
    }
    const voice = voiceSessions().get(sessionId);
    if (!voice || voice.endedReason || voice.attached || !sameVoiceOwner(voice, tenant)) {
      refuse(socket, { status: 404, code: "not_found" }, context);
      return;
    }
    if (!voiceSettingsFor(tenant).enabled) {
      refuse(socket, { status: 403, code: "voice_disabled" }, context);
      return;
    }
    try {
      requireGatewayAllowedFor(tenant);
    } catch {
      refuse(socket, { status: 403, code: "gateway_blocked" }, context);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const relay = new VoiceRelay(ws, voice);
      void relay.start();
    });
  } catch {
    refuse(socket, { status: 401, code: "session_invalid" }, context);
  }
}
