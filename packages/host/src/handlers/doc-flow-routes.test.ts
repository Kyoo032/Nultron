/**
 * The doc-flow routes' shape (docs/internal/doc-flow-plan.md sections 2 to 4 and 7a).
 *
 * Lane W registered nine routes with stub bodies; lanes L1 (Legal), L3a (Meeting) and L4a (Finance)
 * fill the bodies in. Three things are pinned here and survive that:
 *   - the routes are registered with these methods and paths, and by-id exactly where they take an id;
 *   - a matter or meeting that is not the caller's is a 404 `not_found`, never a 501 and never a 403;
 *   - a stub answers 501 `not_implemented` in the host's error envelope, with no half-result.
 *
 * The last one is scaffolding: the "stub" describe block is deleted by the lane that makes the route
 * real, in the same change. The gate split (which routes a closed gate stops) is pinned in
 * `finance-gate.test.ts`, and cross-tenant refusal in `tenancy-harness.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostFile, HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-doc-flow-routes-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

type RouterModule = typeof import("../router");
let router: RouterModule;
let matterId: string;
let meetingId: string;

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function json(method: string, path: string, extra: Partial<HostRequest> = {}) {
  const result: HostResult = await router.dispatch(request(method, path, extra));
  if (result.type !== "json") {
    throw new Error(`${method} ${path}: expected json, got ${result.type}`);
  }
  return { status: result.status, body: result.body as { error?: { code?: string; message?: string } } };
}

const TRANSCRIPT: HostFile = {
  field: "file",
  filename: "talk.txt",
  mime: "text/plain",
  bytes: new TextEncoder().encode("Alice: we agree to ship on Friday."),
};

/** The nine routes, as the plan names them. `:id` is replaced with the matter or meeting under test. */
type DocFlowRoute = {
  readonly method: string;
  readonly path: string;
  readonly byId: "matter" | "meeting" | null;
  readonly extra: Partial<HostRequest>;
};

const ROUTES: readonly DocFlowRoute[] = [
  { method: "POST", path: "/api/v1/legal/matters/:id/extract/stream", byId: "matter", extra: { body: {} } },
  { method: "GET", path: "/api/v1/legal/matters/:id/extract", byId: "matter", extra: {} },
  { method: "PUT", path: "/api/v1/legal/matters/:id/extract/edits", byId: "matter", extra: { body: {} } },
  { method: "POST", path: "/api/v1/legal/matters/:id/extract/comments", byId: "matter", extra: { body: {} } },
  {
    method: "POST",
    path: "/api/v1/legal/matters/:id/ask/stream",
    byId: "matter",
    extra: { body: { question: "Who pays?" } },
  },
  { method: "GET", path: "/api/v1/legal/matters/:id/asks", byId: "matter", extra: {} },
  { method: "POST", path: "/api/v1/meetings/:id/translate/stream", byId: "meeting", extra: { body: {} } },
  { method: "POST", path: "/api/v1/meetings/:id/transcript/file", byId: "meeting", extra: { files: [TRANSCRIPT] } },
  { method: "PUT", path: "/api/v1/meetings/:id/minutes/edits", byId: "meeting", extra: { body: {} } },
  { method: "POST", path: "/api/v1/finance/auto", byId: null, extra: { body: { figuresText: "Revenue 120000" } } },
];

/** The registration as `router.ts` spells it: `:matterId` / `:meetingId`, not the test's `:id`. */
function registered(route: DocFlowRoute): string {
  const name = route.byId === "meeting" ? ":meetingId" : ":matterId";
  return `${route.method} ${route.path.replace(":id", name)}`;
}

function fill(route: DocFlowRoute, id: string): string {
  return route.path.replace(":id", id);
}

beforeAll(async () => {
  router = await import("../router");
  const matter = await json("POST", "/api/v1/legal/matters", {
    body: {
      title: "Doc flow probe",
      side: { role: "borrower", party: "Aurora Holdings", counterparty: "the Lenders" },
      workType: "review",
      deliverables: ["issues-memo"],
    },
  });
  expect(matter.status).toBe(201);
  matterId = (matter.body as unknown as { id: string }).id;
  const meeting = await json("POST", "/api/v1/meetings", { body: { title: "Doc flow probe", locale: "en" } });
  expect(meeting.status).toBe(201);
  meetingId = (meeting.body as unknown as { id: string }).id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the doc-flow route table", () => {
  it("registers every route with the method and path the plan names", () => {
    const table = new Map(router.routeRegistrations().map((entry) => [`${entry.method} ${entry.path}`, entry]));
    for (const route of ROUTES) {
      const key = route.byId ? registered(route) : `${route.method} ${route.path}`;
      const entry = table.get(key);
      expect(entry, `${key} is not registered`).toBeDefined();
      expect(entry ? router.isByIdRoute(entry) : null, `${key} by-id-ness`).toBe(route.byId !== null);
    }
  });

  it("refuses a matter or meeting that is not the caller's with a 404, before anything else", async () => {
    for (const route of ROUTES.filter((item) => item.byId)) {
      const ghost = fill(route, crypto.randomUUID());
      const result = await json(route.method, ghost, route.extra);
      expect(result.status, `${route.method} ${ghost}`).toBe(404);
      expect(result.body.error?.code, `${route.method} ${ghost}`).toBe("not_found");
    }
  });

  it("does not confuse a matter id with a meeting id", async () => {
    // The two lookups are different stores. A meeting's id on a matter route (and the reverse) is
    // an id nothing of that kind has, so it must be the same 404 as a made-up one.
    const crossed = [
      ["POST", `/api/v1/legal/matters/${meetingId}/extract/stream`, { body: {} }],
      ["POST", `/api/v1/meetings/${matterId}/translate/stream`, { body: {} }],
    ] as const;
    for (const [method, path, extra] of crossed) {
      const result = await json(method, path, extra);
      expect(result.status, `${method} ${path}`).toBe(404);
    }
  });
});

// The stub block that stood here is gone: every doc-flow route is real now. The two Meeting routes are in
// `meeting-extra.test.ts` (lane L3a), `POST /finance/auto` in `finance-auto.test.ts` (lane L4a), and the six
// Legal routes in `legal-extract.test.ts` (lane L1).
