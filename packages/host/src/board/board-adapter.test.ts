/**
 * The team board through the real HTTP adapter on a real socket, hosted (team-board-spec.md sections
 * 8.1, 8.2 and 13). What the router-level tests in board-companies.test.ts cannot show:
 *
 *   - every board write is held to the adapter's Origin and double-submit CSRF rule;
 *   - the event stream leaves the process with the SSE headers (no-store, X-Accel-Buffering: no) and
 *     its frames reach the client while the response is still open, not when it ends;
 *   - a client that hangs up frees the stream's bus listener and its slot.
 *
 * The session is a real row in the host's own session store; nothing here is a stand-in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-board-adapter-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "7d2b9f4a1c6e43588b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { SESSION_COOKIE_SECURE, createSession } from "../auth/session";
import { CSRF_COOKIE_SECURE, CSRF_HEADER, mintCsrfTokenFor } from "../csrf";

const ORIGIN = "https://board.desk.test";
const HOST = "board.desk.test";
const IDENTITY = {
  tenantId: "board-adapter-tenant",
  orgId: "board-adapter-org",
  userId: "board-adapter-user",
} as const;

const { handleNodeRequest } = await import("../http-adapter");
const { hostSessionStore } = await import("../auth");
const { openBoardStreams } = await import("./stream");
const { boardBus } = await import("./bus");

let server: Server;
let port = 0;
let sessionId = "";
let workspaceId = "";

type Answer = { status: number; headers: IncomingHttpHeaders; body: string };

function headersFor(withCsrf: boolean): Record<string, string> {
  const token = mintCsrfTokenFor(sessionId);
  return {
    host: HOST,
    origin: ORIGIN,
    "x-forwarded-proto": "https",
    "content-type": "application/json",
    cookie: `${SESSION_COOKIE_SECURE}=${sessionId}${withCsrf ? `; ${CSRF_COOKIE_SECURE}=${token}` : ""}`,
    ...(withCsrf ? { [CSRF_HEADER]: token } : {}),
  };
}

function send(method: string, path: string, body: unknown, withCsrf = true): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: headersFor(withCsrf) }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function until(done: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  process.env.AGENTFORGE_SERVER = "1";
  process.env.AGENTFORGE_TRUSTED_ORIGINS = ORIGIN;
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { ...IDENTITY, role: "owner" });
  workspaceId = tenant.workspaceId;
  const session = createSession({ ...IDENTITY, now: Date.now() });
  await hostSessionStore().create(session);
  sessionId = session.id;
  server = createServer((req, res) => {
    void handleNodeRequest(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AGENTFORGE_TRUSTED_ORIGINS;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("team board K0 through the HTTP adapter", () => {
  it("refuses a board write with no CSRF token, and takes the same write with one", async () => {
    const refused = await send("POST", "/api/v1/board/cards", { title: "no token" }, false);
    expect(refused.status).toBe(403);
    const board = await send("GET", "/api/v1/board", undefined);
    expect(board.status).toBe(200);
    expect(board.body).not.toContain("no token");

    const accepted = await send("POST", "/api/v1/board/cards", { title: "with token" });
    expect(accepted.status, accepted.body).toBe(201);
    expect((await send("GET", "/api/v1/board", undefined)).body).toContain("with token");
  });

  it("holds a PATCH to the same rule: no token, no edit; with the token, the edit lands", async () => {
    const created = await send("POST", "/api/v1/board/cards", { title: "patch target" });
    const cardId = (JSON.parse(created.body) as { card: { id: string } }).card.id;
    const refused = await send("PATCH", `/api/v1/board/cards/${cardId}`, { version: 1, title: "no token edit" }, false);
    expect(refused.status).toBe(403);
    expect((await send("GET", "/api/v1/board", undefined)).body).not.toContain("no token edit");

    const accepted = await send("PATCH", `/api/v1/board/cards/${cardId}`, { version: 1, title: "token edit" });
    expect(accepted.status, accepted.body).toBe(200);
    expect((await send("GET", "/api/v1/board", undefined)).body).toContain("token edit");
  });

  it("refuses a board write from an Origin that is not trusted", async () => {
    const answer = await new Promise<Answer>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/board/columns",
          headers: { ...headersFor(true), origin: "https://evil.example" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ name: "evil" }));
    });
    expect(answer.status).toBe(403);
    expect((await send("GET", "/api/v1/board", undefined)).body).not.toContain("evil");
  });

  it("streams events with SSE headers, flushes each frame while open, and frees the slot on hang-up", async () => {
    const baselineListeners = boardBus().listenerCount(IDENTITY.tenantId, workspaceId);
    let text = "";
    let headers: IncomingHttpHeaders = {};
    let status = 0;
    let ended = false;
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/api/v1/board/events",
      headers: headersFor(false),
    });
    req.on("response", (res) => {
      status = res.statusCode ?? 0;
      headers = res.headers;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => {
        ended = true;
      });
      res.on("error", () => {
        ended = true;
      });
    });
    req.on("error", () => {
      ended = true;
    });
    req.end();

    await until(() => text.includes(": open"), "the open frame");
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(headers["cache-control"]).toBe("no-store, no-transform");
    expect(headers["x-accel-buffering"]).toBe("no");
    expect(headers["content-encoding"]).toBeUndefined();
    expect(openBoardStreams()).toBe(1);

    const created = await send("POST", "/api/v1/board/cards", { title: "live over the socket" });
    expect(created.status).toBe(201);
    const cardId = (JSON.parse(created.body) as { card: { id: string } }).card.id;
    await until(() => text.includes("event: card.created"), "the card.created frame");
    expect(text).toContain(cardId);
    expect(ended, "the frame arrived only because the response ended").toBe(false);

    req.destroy();
    await until(() => openBoardStreams() === 0, "the stream slot freed");
    expect(boardBus().listenerCount(IDENTITY.tenantId, workspaceId)).toBe(baselineListeners);
  });
});
