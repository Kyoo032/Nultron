/**
 * SR-138 inventory: every route that reaches the gateway holds a run slot, or is on a short list of
 * routes left out on purpose, each with its reason. The list is derived from the source, so it cannot
 * rot: add a handler that calls the gateway gate and this file fails until the handler takes a slot
 * or somebody writes down why it does not.
 *
 * Two halves:
 *   1. a scan of `handlers/*.ts` and `router.ts` that finds every handler calling the gate and the
 *      route(s) it serves, and checks each one names a slot (`withRunSlot`, `admitRun`, `streamJob`
 *      with its tenant) or is on the allowlist;
 *   2. the real router, hosted, with the tenant already at its cap: every counted route must answer
 *      429 `too_many_runs`, and no left-out route may.
 *
 * Real router, real sessions, throwaway data dir; the gateway is a stub that says yes to the key.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS, SOURCE_SCAN_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-limits-routes-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "7e2c9a4b1d6f40358c0e2a4b6d8f1032a4c6e8b01d3f5a79c2e4a6b8d0f1327e";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;

import type { TenantContext } from "@agentforge/core";
import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Gateway-gated routes that deliberately hold no slot, and why. Each is one short call, and each is
 * bursty by design, so counting it would refuse a person their real work for doing something ordinary.
 * The request buckets (300 a minute per session) still bound all of them.
 */
const LEFT_OUT: Readonly<Record<string, string>> = {
  handlePostEnhancePrompt: "one short prompt rewrite behind a button; a Chat run in flight would otherwise block it",
  handleGetKnowledgeContext: "one query embedding, read on every keystroke and every thread open",
  handlePostKnowledgeSource: "ingests one source; a multi-file drop sends several at once by design",
  handlePostKnowledgeSourceUrl: "ingests one source; same burst as a file drop",
  handlePostKnowledgeSourceReindex: "re-embeds one source",
  handlePostKnowledgeBackendReindex:
    "queues a backfill and answers at once; the embedding runs in the backfill outbox, outside the request",
};

/** Body a route needs before it reaches the slot, where an empty object would be refused first. */
const BODY_FOR: Readonly<Record<string, unknown>> = {
  "POST /api/v1/edit/projects/:projectId/jobs": { kind: "asr" },
};

type HandlerInfo = { readonly name: string; readonly file: string; readonly body: string };

/** Comments name `requireGatewayAllowed()` as often as code calls it; only code counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function exportedHandlers(): HandlerInfo[] {
  const dir = join(here, "handlers");
  const found: HandlerInfo[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
      continue;
    }
    const source = withoutComments(readFileSync(join(dir, file), "utf8"));
    const starts = [...source.matchAll(/^export (?:async )?function (\w+)\s*\(/gm)];
    starts.forEach((match, index) => {
      const end = starts[index + 1]?.index ?? source.length;
      found.push({ name: match[1] as string, file, body: source.slice(match.index, end) });
    });
  }
  return found;
}

const GATE_CALL = /\brequireGatewayAllowed(?:For)?\(/;

/** The text between the parentheses of the first `name(` in `body`, balanced. */
function callArguments(body: string, name: string, from = 0): { text: string; next: number } | null {
  const at = body.indexOf(`${name}(`, from);
  if (at < 0) {
    return null;
  }
  let depth = 0;
  for (let i = at + name.length; i < body.length; i += 1) {
    if (body[i] === "(") {
      depth += 1;
    } else if (body[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return { text: body.slice(at + name.length + 1, i), next: i };
      }
    }
  }
  return null;
}

function takesASlot(body: string): boolean {
  if (/\bwithRunSlot\(|\badmitRun\(/.test(body)) {
    return true;
  }
  // `streamJob` takes the slot when it is told whose job it is.
  const stream = callArguments(body, "streamJob");
  return stream !== null && /\btenant\b/.test(stream.text);
}

type RouteLine = { readonly method: string; readonly path: string; readonly handler: string };

function registeredRoutes(): RouteLine[] {
  const source = readFileSync(join(here, "router.ts"), "utf8");
  const lines: RouteLine[] = [];
  for (const match of source.matchAll(/compile\(\s*"([A-Z]+)",\s*"([^"]+)",\s*([^\n]+)\),?\s*$/gm)) {
    lines.push({ method: match[1] as string, path: match[2] as string, handler: match[3] as string });
  }
  return lines;
}

const handlers = exportedHandlers();
const gateCalling = handlers.filter((handler) => GATE_CALL.test(handler.body));
const routes = registeredRoutes();

function routesOf(handler: string): RouteLine[] {
  return routes.filter((route) => new RegExp(`\\b${handler}\\b`).test(route.handler));
}

describe("the inventory of gateway-calling routes (source scan)", () => {
  it(
    "finds the handlers that call the gate, so the scan itself is not vacuous",
    () => {
      const names = gateCalling.map((handler) => handler.name);
      for (const known of ["handleRun", "handlePostImages", "handlePostEditAgent", "handlePostEnhancePrompt"]) {
        expect(names, known).toContain(known);
      }
      expect(names.length).toBeGreaterThanOrEqual(35);
    },
    SOURCE_SCAN_BUDGET_MS,
  );

  it(
    "gives every gateway-calling handler a slot, or a reason on the left-out list",
    () => {
      const bare = gateCalling
        .filter((handler) => !takesASlot(handler.body) && !(handler.name in LEFT_OUT))
        .map((handler) => `${handler.file}#${handler.name}`);
      expect(
        bare,
        `these handlers call the gateway gate and take no run slot (SR-138): wrap their work in withRunSlot(tenant, ...), ` +
          `hand a slot to streamJob/guardRunStream, or add them to LEFT_OUT with a reason: ${bare.join(", ")}`,
      ).toEqual([]);
    },
    SOURCE_SCAN_BUDGET_MS,
  );

  it(
    "keeps the left-out list honest: every entry still exists, still calls the gate, and takes no slot",
    () => {
      for (const name of Object.keys(LEFT_OUT)) {
        const handler = gateCalling.find((candidate) => candidate.name === name);
        expect(handler, `${name} is on LEFT_OUT but no handler of that name calls the gate any more`).toBeDefined();
        expect(takesASlot(handler?.body ?? ""), `${name} takes a slot now: take it off LEFT_OUT`).toBe(false);
      }
    },
    SOURCE_SCAN_BUDGET_MS,
  );

  it(
    "finds a route in router.ts for every gateway-calling handler",
    () => {
      const unrouted = gateCalling
        .filter((handler) => routesOf(handler.name).length === 0)
        .map((handler) => handler.name);
      expect(unrouted, `no compile() line names: ${unrouted.join(", ")}`).toEqual([]);
    },
    SOURCE_SCAN_BUDGET_MS,
  );

  it(
    "never starts a streaming job without naming its tenant, except the machine-wide component install",
    () => {
      const unnamed: string[] = [];
      for (const handler of handlers) {
        let from = 0;
        for (
          let call = callArguments(handler.body, "streamJob", from);
          call;
          call = callArguments(handler.body, "streamJob", from)
        ) {
          if (!/\btenant\b/.test(call.text) && handler.name !== "handlePostComponentInstallStream") {
            unnamed.push(`${handler.file}#${handler.name}`);
          }
          from = call.next;
        }
      }
      expect(unnamed).toEqual([]);
    },
    SOURCE_SCAN_BUDGET_MS,
  );
});

describe("the same inventory through the real router, hosted, with the tenant at its cap", () => {
  const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
  const IDENTITY = { tenantId: "routes-tenant", orgId: "routes-org", userId: "routes-user" } as const;
  let dispatch: typeof import("./router").dispatch;
  let admitRun: typeof import("./run-limits").admitRun;
  let activeRuns: typeof import("./run-limits").activeRuns;
  let tenant: TenantContext;
  let sessionStore: ReturnType<typeof createMemorySessionStore>;
  let session: ReturnType<typeof createSession>;
  let ids: { projectId: string; matterId: string };

  function request(method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
    return {
      method,
      path,
      query: {},
      params: {},
      headers: { cookie: `${SESSION_COOKIE_SECURE}=${session.id}` },
      ...over,
    };
  }

  async function call(method: string, path: string, body?: unknown): Promise<HostResult> {
    return dispatch(request(method, path, { body }), { serverMode: true, sessionStore, now: () => T0 });
  }

  function fill(template: string): string {
    return template.replace(/:(\w+)/g, (_, key: string) =>
      key === "projectId" ? ids.projectId : key === "matterId" ? ids.matterId : "x",
    );
  }

  function refusal(result: HostResult): { status: number; code: string } | null {
    if (result.type !== "json") {
      return null;
    }
    const code = (result as HostJsonResult).body as { error?: { code?: string } } | null;
    return { status: result.status, code: code?.error?.code ?? "" };
  }

  beforeAll(async () => {
    ({ dispatch } = await import("./router"));
    ({ admitRun, activeRuns } = await import("./run-limits"));
    const { db, ensurePortalOwner, resolvePortalTenant } = await import("@agentforge/db");
    sessionStore = createMemorySessionStore();
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
    await ensurePortalOwner(db, { ...IDENTITY, role: "owner" });
    const resolved = await resolvePortalTenant(db, IDENTITY);
    if (!resolved.ok) {
      throw new Error(`tenant did not resolve: ${resolved.code}`);
    }
    tenant = resolved.tenant;
    session = createSession({ ...IDENTITY, now: T0 });
    await sessionStore.create(session);
    // A hosted tenant calls a model only with a key the gateway accepted; the stub says yes.
    const saved = await call("POST", "/api/v1/settings", { openaiApiKey: "sk-routes-test-aaaaaaaaaaaaaaaa" });
    expect((saved as HostJsonResult).body, "the gate did not open").toMatchObject({ gateway: { allowed: true } });

    const { createEditProject } = await import("./edit/projects");
    const { legalStore } = await import("./legal/store");
    const project = await createEditProject(tenant, { name: "routes", aspect: "16:9", fps: 30 });
    const matter = legalStore().create(tenant, {
      title: "routes",
      side: { role: "borrower", party: "Acme", counterparty: "the Lenders" },
      workType: "review",
      deliverables: ["issues-memo"],
      instructions: "routes",
    });
    ids = { projectId: project.id, matterId: matter.id };
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const counted = gateCalling.filter((handler) => !(handler.name in LEFT_OUT));
  const countedRoutes = counted.flatMap((handler) =>
    routesOf(handler.name).map((route) => ({ handler: handler.name, route })),
  );
  const leftOutRoutes = Object.keys(LEFT_OUT).flatMap((name) =>
    routesOf(name).map((route) => ({ handler: name, route })),
  );

  it("has routes to drive", () => {
    expect(countedRoutes.length).toBeGreaterThanOrEqual(35);
    expect(leftOutRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(countedRoutes.map((entry) => [`${entry.route.method} ${entry.route.path}`, entry] as const))(
    "%s answers 429 too_many_runs while the tenant holds its only slot",
    async (_label, entry) => {
      const held = admitRun(tenant);
      try {
        expect(activeRuns(tenant)).toBe(1);
        const key = `${entry.route.method} ${entry.route.path}`;
        const result = await call(entry.route.method, fill(entry.route.path), BODY_FOR[key] ?? {});
        expect(refusal(result), `${key} (${entry.handler}) was not refused`).toEqual({
          status: 429,
          code: "too_many_runs",
        });
      } finally {
        held();
      }
      expect(activeRuns(tenant), "a refused call left a slot behind").toBe(0);
    },
  );

  it.each(leftOutRoutes.map((entry) => [`${entry.route.method} ${entry.route.path}`, entry] as const))(
    "%s, left out on purpose, is not refused for the cap",
    async (_label, entry) => {
      const held = admitRun(tenant);
      try {
        const result = await call(
          entry.route.method,
          fill(entry.route.path),
          BODY_FOR[`${entry.route.method} ${entry.route.path}`] ?? {},
        );
        expect(refusal(result)?.code).not.toBe("too_many_runs");
      } finally {
        held();
      }
    },
  );
});
