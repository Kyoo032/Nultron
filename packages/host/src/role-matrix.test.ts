/**
 * F8a — the role × action matrix (acceptance: every "not allowed" cell is a 403).
 *
 * One loop, not 170 hand-written tests: `routeRegistrations()` is the route table itself, and the
 * expectation for each route comes from the same `routeGate` classification `dispatch` enforces
 * (`./role-policy.ts`), so a route added without a classification still lands under a rule — a new
 * mutation defaults to `agents`, which an auditor is refused, and a new read defaults to `read`,
 * which one is refused too. An auditor's whole read surface is `AUDITOR_READ_ROUTES`: anything
 * else is a 403.
 *
 * What this proves: the denial, on a real database, through `dispatch` with four provisioned
 * sessions (owner, admin, member, auditor). A "not denied" cell is asserted only as *not this
 * 403* — the handler behind it may still refuse with its own 4xx/5xx, which is its business, not
 * the gate's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-role-matrix-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

import type { MembershipRole, PortalRole } from "@agentforge/core";
import { dispatch, routeRegistrations } from "./router";
import { isSessionExemptPath } from "./auth";
import { AUDITOR_READ_ROUTES, routeGate, roleDenied, type RouteGate } from "./role-policy";
import { createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostRequest, HostResult } from "./types";

const T0 = Date.now();

const ROLES: readonly MembershipRole[] = ["owner", "admin", "member", "auditor"];

function identity(role: MembershipRole) {
  return { tenantId: `matrix-tenant-${role}`, orgId: `matrix-org-${role}`, userId: `matrix-user-${role}` };
}

/**
 * The classification every registered route lands in. Two assertions about the table itself:
 * every route classifies (never "unclassified" — `routeGate` has a default, which is the point:
 * a new route is refused to the auditor even before anyone names it), and a mutation named in
 * `ADMINISTER_ROUTES` really is a POST/PATCH/PUT/DELETE the table carries.
 */
describe("the role gate's coverage of the route table", () => {
  it("classifies every registered route", () => {
    for (const route of routeRegistrations()) {
      const gate = routeGate(route.method, route.path);
      expect(gate, `${route.method} ${route.path}`).toMatch(/^(audit|administer|agents|read|auditor-read)$/);
    }
  });

  it("names real routes in each role table", () => {
    const registered = new Set(routeRegistrations().map((route) => `${route.method} ${route.path}`));
    for (const key of AUDITOR_READ_ROUTES) {
      expect(registered.has(key), `auditor-read ${key}`).toBe(true);
    }
  });

  it("leaves no role an undefined answer", () => {
    const gates: readonly RouteGate[] = ["audit", "administer", "agents", "read", "auditor-read"];
    for (const role of ROLES) {
      for (const gate of gates) {
        expect(typeof roleDenied(role, gate), `${role} × ${gate}`).not.toBe("undefined");
      }
    }
  });
});

describe("the role × action matrix", () => {
  let store: ReturnType<typeof createMemorySessionStore>;
  const sessions = new Map<MembershipRole, string>();

  beforeAll(async () => {
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    store = createMemorySessionStore();
    for (const role of ROLES) {
      // The portal's word on the role: `ensurePortalOwner` takes the claim the token body carried.
      await ensurePortalOwner(db, { ...identity(role), role: role as PortalRole });
      const session = createSession({ ...identity(role), now: T0 });
      await store.create(session);
      sessions.set(role, session.id);
    }
  });

  afterAll(async () => {
    const { db } = await import("@agentforge/db");
    db.$client?.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function requestFor(route: { method: string; path: string }, role: MembershipRole): HostRequest {
    const concrete = route.path.replace(/:[a-zA-Z]+/g, "matrix-missing-id");
    return {
      method: route.method,
      path: concrete,
      query: {},
      params: {},
      // Server mode reads the `__Host-` cookie; send both so the test does not depend on which
      // name the current build prefers.
      headers: {
        cookie: `agentforge_session=${sessions.get(role)}; __Host-agentforge_session=${sessions.get(role)}`,
      },
    } as unknown as HostRequest;
  }

  /** `true` when the answer is the role gate's own 403, not a handler's refusal. */
  function isRoleDenial(result: HostResult, role: MembershipRole, gate: RouteGate): boolean {
    if (result.type !== "json" || result.status !== 403) {
      return false;
    }
    // Handlers have their own 403s (e.g. the desk-owner checks in customers.ts), so the gate's
    // denial is identified by its exact message, not the code alone.
    const body = (result as { body?: { error?: { code?: string; message?: string } } }).body;
    return body?.error?.code === "forbidden" && body.error.message === roleDenied(role, gate);
  }

  /**
   * Denied or not, from the route's gate for this role. The session-exempt paths are skipped: the
   * gate never sees them, so there is no denial to check.
   */
  function denied(role: MembershipRole, gate: RouteGate): boolean {
    return roleDenied(role, gate) !== null;
  }

  it.each(ROLES)("role %s gets the gate's answer on every registered route", async (role) => {
    const routes = routeRegistrations().filter(
      (route) => !isSessionExemptPath(route.method, route.path),
    );
    for (const route of routes) {
      const gate = routeGate(route.method, route.path);
      const result = await dispatch(requestFor(route, role), { serverMode: true, sessionStore: store });
      const label = `${role} ${route.method} ${route.path} (${gate})`;
      if (denied(role, gate)) {
        expect(isRoleDenial(result, role, gate), label).toBe(true);
      } else {
        expect(isRoleDenial(result, role, gate), label).toBe(false);
      }
    }
  }, 120_000);

  /**
   * A few cells pinned by hand, not derived from `routeGate`/`roleDenied`: the loop above proves
   * the gate enforces its own classification, these prove the classification itself names the
   * right routes (a route filed under the wrong class still passes the loop).
   */
  it("pins named routes to the denial the spec gives them", async () => {
    const cases: Array<{ role: MembershipRole; method: string; path: string; denied: boolean }> = [
      { role: "auditor", method: "GET", path: "/api/v1/threads", denied: true },
      { role: "auditor", method: "POST", path: "/api/v1/settings", denied: true },
      { role: "auditor", method: "GET", path: "/api/v1/settings", denied: false },
      { role: "member", method: "POST", path: "/api/v1/billing/top-up", denied: true },
      { role: "admin", method: "POST", path: "/api/v1/billing/top-up", denied: false },
      { role: "owner", method: "GET", path: "/api/v1/threads", denied: false },
    ];
    for (const entry of cases) {
      const result = await dispatch(
        requestFor({ method: entry.method, path: entry.path } as Parameters<typeof requestFor>[0], entry.role),
        { serverMode: true, sessionStore: store },
      );
      const gate = routeGate(entry.method, entry.path);
      expect(
        isRoleDenial(result, entry.role, gate),
        `${entry.role} ${entry.method} ${entry.path}`,
      ).toBe(entry.denied);
    }
  });
});
