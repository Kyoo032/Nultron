/**
 * SH-004: the gate's bad-key, unreachable and grace states, driven through the real router against a
 * fake gateway that really listens on loopback.
 *
 * The stub runtime short-circuits these states (`gateway-gate.ts`, the `envRuntime === "stub"` branches),
 * and `gateway-gate.test.ts` passes each state in by hand. Here the host makes real HTTP calls to a server
 * on 127.0.0.1 (an ephemeral port). The base URL comes in through the dev/test hook
 * `AGENTFORGE_GATEWAY_URL` (`gatewayUrlOverride`, `packages/core/src/gateway/pinned.ts`): it is refused
 * when packaged or under NODE_ENV=production, and a loopback http URL passes `assertAllowedEndpointUrl`.
 * The host test setup (`packages/host/test/setup.ts`) refuses any fetch to a non-loopback host, so nothing
 * can reach api.tokotokenai.com from here.
 *
 * Every key below is an obviously fake string. The test asserts that neither key appears in a response
 * or in the verdict file.
 *
 * Covered here: the flat 403 on a gated route after a real 401 and a real 403; a refused socket, a dropped
 * socket and a response held past the budget; grace while the endpoint is down and the close once the
 * grace has run out; a 500 on the first check; one live check per Re-check; a stale verdict re-checked in
 * the background when Settings is read; and stub runtime making no gateway call even with a key saved.
 * The pure rules, the hosted rules and the status-only handler checks are covered in
 * `gateway-gate.test.ts`, `gateway-gate-companies.test.ts` and `handlers/settings.test.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_TENANT_ID } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

// Isolation first: the desk, its database and its verdict file all live in this folder.
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-gate-fake-gateway-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;

type Gate = typeof import("./gateway-gate");
let gate: Gate;
let dispatch: typeof import("./router").dispatch;

/** Obviously fake. The gateway accepts `KEY_GOOD` and answers any other bearer with its rejection status. */
const KEY_GOOD = "sk-fake-gate-accepted-000000000000";
const KEY_BAD = "sk-fake-gate-rejected-00000000000";
const FAKE_KEYS = [KEY_GOOD, KEY_BAD];

const DAY_MS = 86_400_000;
const GATED = "/api/v1/knowledge/context";

/**
 * What the fake gateway does with a request. `answer` is the normal path. The rest are endpoint faults:
 * `server_error` answers 500, `drop` destroys the socket before any answer, and `hold` keeps the response
 * open until the test releases it.
 */
type Behaviour = "answer" | "server_error" | "drop" | "hold";

type Seen = { method: string; path: string; bearer: string | null };

const seen: Seen[] = [];
const held: ServerResponse[] = [];
const sockets = new Set<import("node:net").Socket>();
let server: Server;
let fakeBase = "";
let behaviour: Behaviour = "answer";
let rejectStatus: 401 | 403 = 401;

function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  return typeof raw === "string" ? raw.replace(/^Bearer\s+/i, "") : null;
}

function answer(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ method: req.method ?? "", path: req.url ?? "", bearer: bearerOf(req) });
  if (behaviour === "drop") {
    req.socket.destroy();
    return;
  }
  if (behaviour === "hold") {
    held.push(res);
    return;
  }
  if (behaviour === "server_error") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
    return;
  }
  const accepted = bearerOf(req) === KEY_GOOD;
  if (accepted) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
    return;
  }
  res.writeHead(rejectStatus, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "rejected" } }));
}

function releaseHeld(): void {
  for (const res of held.splice(0)) {
    try {
      res.end();
    } catch {
      // The client already gave up on it (its budget ran out). Nothing to release.
    }
  }
}

/** A loopback port with nothing listening on it: a connection to it is refused at once. */
async function closedGatewayBase(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

type Answer = { status: number; body: Record<string, unknown> };

async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  const result: HostResult = await dispatch(request(method, path, body === undefined ? {} : { body }));
  if (result.type !== "json") {
    throw new Error(`expected json from ${path}, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

type GateBody = {
  status: string;
  allowed: boolean;
  grace: boolean;
  endpoint: string;
  checkedAt: string | null;
  lastOkAt: string | null;
  message?: string;
};

function gateOf(answered: Answer): GateBody {
  return (answered.body as { gateway: GateBody }).gateway;
}

async function saveKey(key: string): Promise<GateBody> {
  const answered = await call("POST", "/api/v1/settings", { openaiApiKey: key });
  expect(answered.status).toBe(200);
  // The save answer carries the masked secrets and the gate. Neither may carry the key.
  expect(keyLeaks(JSON.stringify(answered.body))).toBe(false);
  return gateOf(answered);
}

function verdictFileText(): string {
  const file = join(dataDir, gate.GATEWAY_GATE_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function keyLeaks(text: string): boolean {
  return FAKE_KEYS.some((key) => text.includes(key));
}

/** Every request the fake gateway received for a model list. The bearer is the key without `Bearer `. */
function modelCalls(bearer?: string): Seen[] {
  return seen.filter(
    (entry) =>
      entry.method === "GET" && entry.path === "/v1/models" && (bearer === undefined || entry.bearer === bearer),
  );
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function waitFor(done: () => boolean, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) {
      throw new Error("timed out waiting for the background check to land");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Waits until no new request has reached the fake gateway for three short polls in a row (about 60 ms of
 * quiet), so a check that was started without being awaited has either arrived or has not started. It is
 * bounded by `maxMs`, and the assertion after it decides. It does not prove a request could never arrive
 * after the quiet window.
 */
async function settleGateway(maxMs = 1_000): Promise<void> {
  const until = Date.now() + maxMs;
  let last = seen.length;
  let quiet = 0;
  while (quiet < 3 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (seen.length === last) {
      quiet += 1;
    } else {
      quiet = 0;
      last = seen.length;
    }
  }
}

beforeAll(async () => {
  server = createServer(answer);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  fakeBase = `http://127.0.0.1:${port}/v1`;
  process.env.AGENTFORGE_GATEWAY_URL = fakeBase;

  ({ dispatch } = await import("./router"));
  gate = await import("./gateway-gate");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  delete process.env.AGENTFORGE_RUNTIME;
  process.env.AGENTFORGE_GATEWAY_URL = fakeBase;
  behaviour = "answer";
  rejectStatus = 401;
  seen.length = 0;
  gate.resetGatewayRefreshThrottle();
});

afterEach(async () => {
  releaseHeld();
  // Forgets the key on every desk and the verdict with it, so no case starts from another case's state.
  await call("POST", "/api/v1/settings/reset", { scope: "key" });
  rmSync(join(dataDir, gate.GATEWAY_GATE_FILE), { force: true });
});

afterAll(async () => {
  releaseHeld();
  server.closeAllConnections();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.AGENTFORGE_GATEWAY_URL;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a gateway that rejects the saved key", () => {
  for (const status of [401, 403] as const) {
    it(`closes the desk on a ${status} as invalid_key, and a gated route answers the flat 403`, async () => {
      rejectStatus = status;
      const gateway = await saveKey(KEY_BAD);
      expect(gateway).toMatchObject({
        status: "invalid_key",
        allowed: false,
        grace: false,
        endpoint: fakeBase,
        lastOkAt: null,
      });
      expect(gateway.message).toBe(`HTTP ${status}`);
      // The hook routed the check: the fake gateway was asked with the key, on /v1/models.
      expect(modelCalls(KEY_BAD).length).toBeGreaterThan(0);

      const blocked = await call("GET", GATED);
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ error: "gateway_blocked", status: "invalid_key" });
      expect(String(blocked.body.message)).toContain(`HTTP ${status}`);

      expect(keyLeaks(JSON.stringify(blocked.body))).toBe(false);
      expect(keyLeaks(verdictFileText())).toBe(false);
      expect(verdictFileText()).toContain('"status": "invalid_key"');
    });
  }
});

describe("a gateway that cannot be reached", () => {
  it("closes a key it has never validated, with no grace, and the gated route says why", async () => {
    process.env.AGENTFORGE_GATEWAY_URL = await closedGatewayBase();
    const gateway = await saveKey(KEY_GOOD);
    expect(gateway).toMatchObject({ status: "unreachable", allowed: false, grace: false, lastOkAt: null });
    expect(gateway.endpoint).toBe(process.env.AGENTFORGE_GATEWAY_URL);

    const blocked = await call("GET", GATED);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "gateway_blocked", status: "unreachable" });
    expect(keyLeaks(JSON.stringify(blocked.body))).toBe(false);
    expect(keyLeaks(verdictFileText())).toBe(false);
  });

  it("keeps a validated key open on grace while the endpoint is down, and closes it once the grace has run out", async () => {
    const ok = await saveKey(KEY_GOOD);
    expect(ok).toMatchObject({ status: "ok", allowed: true, grace: false });
    const lastOkAt = ok.lastOkAt;
    expect(lastOkAt).not.toBeNull();

    // The endpoint now drops every connection before it answers.
    behaviour = "drop";
    const down = await call("POST", "/api/v1/settings/gateway/check", {});
    expect(gateOf(down)).toMatchObject({ status: "unreachable", allowed: true, grace: true, lastOkAt });
    expect(keyLeaks(JSON.stringify(down.body))).toBe(false);

    // Inside the grace window the gated route is open and does its own work, with no 403.
    const open = await call("GET", GATED);
    expect(open.status).toBe(200);

    // Seven days after the last good answer the grace has run out. The same endpoint now closes the desk.
    const verdict = gate.loadGateState(LOCAL_TENANT_ID);
    if (!verdict) {
      throw new Error("expected a saved verdict after the first check");
    }
    gate.saveGateState(LOCAL_TENANT_ID, { ...verdict, lastOkAt: isoAgo(8 * DAY_MS) });
    const closed = await call("POST", "/api/v1/settings/gateway/check", {});
    expect(gateOf(closed)).toMatchObject({ status: "unreachable", allowed: false, grace: false });

    const blocked = await call("GET", GATED);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "gateway_blocked", status: "unreachable" });
  });

  it("does not wait out a gateway that never answers: the budget ends the check as unreachable", async () => {
    // Straight through `runGatewayCheck` with a 200 ms budget. The router's own budget is 3 s.
    behaviour = "hold";
    const started = Date.now();
    const gateway = await gate.runGatewayCheck({ openaiApiKey: KEY_GOOD }, { timeoutMs: 200 });
    expect(gateway).toMatchObject({ status: "unreachable", allowed: false, grace: false });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The request really reached the fake gateway before the budget ran out.
    expect(modelCalls(KEY_GOOD).length).toBeGreaterThan(0);
    expect(keyLeaks(verdictFileText())).toBe(false);
  });
});

describe("a gateway that fails on the first check", () => {
  it("answers a 500 as error with no grace, and the gated route refuses with that status", async () => {
    behaviour = "server_error";
    const gateway = await saveKey(KEY_GOOD);
    expect(gateway).toMatchObject({ status: "error", allowed: false, grace: false, message: "HTTP 500" });

    const blocked = await call("GET", GATED);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "gateway_blocked", status: "error" });
    expect(keyLeaks(JSON.stringify(blocked.body))).toBe(false);
  });
});

describe("the gate's own calls to the gateway", () => {
  it("runs exactly one live check for each Re-check, and reports what it found", async () => {
    await saveKey(KEY_GOOD);
    const before = modelCalls(KEY_GOOD).length;

    const again = await call("POST", "/api/v1/settings/gateway/check", {});
    expect(gateOf(again)).toMatchObject({ status: "ok", allowed: true, grace: false });
    expect(modelCalls(KEY_GOOD).length - before).toBe(1);
  });

  it("asks the gateway with the new key before a Settings save answers", async () => {
    const gateway = await saveKey(KEY_GOOD);
    expect(gateway.status).toBe("ok");
    expect(modelCalls(KEY_GOOD).length).toBeGreaterThan(0);
  });

  it("re-checks an ok verdict past its 24 hours in the background when Settings is read", async () => {
    await saveKey(KEY_GOOD);
    const verdict = gate.loadGateState(LOCAL_TENANT_ID);
    if (!verdict) {
      throw new Error("expected a saved verdict after the save");
    }
    const stale = isoAgo(2 * DAY_MS);
    gate.saveGateState(LOCAL_TENANT_ID, { ...verdict, checkedAt: stale, lastOkAt: stale });
    seen.length = 0;

    // The read answers at once with the verdict it has: two days old, so open on the 7-day grace.
    const read = await call("GET", "/api/v1/settings");
    expect(gateOf(read)).toMatchObject({ status: "ok", allowed: true, grace: true });

    // The check runs behind the response. Wait for its verdict to land instead of sleeping for a while.
    await waitFor(() => (gate.loadGateState(LOCAL_TENANT_ID)?.checkedAt ?? stale) !== stale);
    expect(gate.loadGateState(LOCAL_TENANT_ID)).toMatchObject({ status: "ok" });
    expect(modelCalls(KEY_GOOD).length).toBeGreaterThan(0);

    const fresh = await call("GET", GATED);
    expect(fresh.status).toBe(200);
  });

  it("makes no gateway call in stub runtime, even with a key saved, and stays open", async () => {
    await saveKey(KEY_GOOD);
    process.env.AGENTFORGE_RUNTIME = "stub";
    await settleGateway();
    const before = seen.length;

    const read = await call("GET", "/api/v1/settings");
    const check = await call("POST", "/api/v1/settings/gateway/check", {});
    expect(gateOf(read)).toMatchObject({ status: "stub", allowed: true, grace: false });
    expect(gateOf(check)).toMatchObject({ status: "stub", allowed: true });
    // GET /settings may start a check without awaiting it, so let any such request land before counting.
    await settleGateway();
    expect(seen.length).toBe(before);

    expect((await call("GET", GATED)).status).toBe(200);
    expect(keyLeaks(JSON.stringify(read.body))).toBe(false);
  });
});
