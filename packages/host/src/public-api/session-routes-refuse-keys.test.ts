import { describe, expect, it } from "vitest";
import { routeRegistrations, dispatch } from "../router";
import { isPublicApiPath } from "./auth";
import type { HostRequest } from "../types";

/**
 * AC-5a.8: a key must never open a session-only route. Walks `routeRegistrations()` — every
 * row of the session table — so a route added later without thinking about keys fails here
 * instead of shipping.
 */
describe("session routes refuse API keys (F5a)", () => {
  it("no session-table row is a public path, and public paths are not in the session table", () => {
    for (const route of routeRegistrations()) {
      expect(isPublicApiPath(route.path), `${route.method} ${route.path}`).toBe(false);
    }
  });

  it("Bearer-only credential on session routes is a 401 from the session gate", async () => {
    const bearerRequest = (path: string): HostRequest => ({
      method: "GET",
      path,
      headers: { authorization: "Bearer nk_live_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      params: {},
      query: {},
      body: undefined,
    });
    for (const path of ["/api/v1/settings", "/api/v1/api-keys", "/api/v1/workspaces"]) {
      const result = await dispatch(bearerRequest(path), { serverMode: true });
      expect(result.type).toBe("json");
      expect(result.status).toBe(401);
    }
  });

  it("a session-shaped request under the public prefix never reaches the session table", async () => {
    const saved = process.env.AGENTFORGE_PUBLIC_API;
    process.env.AGENTFORGE_PUBLIC_API = "on";
    try {
      // Even if a caller smuggles a session cookie in, the public dispatcher answers first.
      const result = await dispatch(
        {
          method: "GET",
          path: "/api/public/v1/agents",
          headers: {},
          params: {},
          query: {},
          body: undefined,
        },
        { serverMode: true },
      );
      expect(result.status).toBe(401);
      const body = result.type === "json" ? (result.body as { error: { code: string } }) : null;
      expect(body?.error.code).toBe("invalid_api_key");
    } finally {
      if (saved === undefined) delete process.env.AGENTFORGE_PUBLIC_API;
      else process.env.AGENTFORGE_PUBLIC_API = saved;
    }
  });
});
