/**
 * Projects on Personal (team-board-spec.md section 2b, F1). Personal has one person per desk, so the
 * whole project surface does not exist there: every project route answers the router's own 404, the
 * same envelope an unknown path gets. The two-company proof is `projects-companies.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { dispatch } from "./router";
import type { HostJsonResult } from "./types";

describe("collective projects on Personal", () => {
  it("answers the people picker's route with the router's own 404, like an unknown path", async () => {
    const saved = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    try {
      const { projectRoutes } = await import("./handlers/projects");
      expect(projectRoutes().map(([method, path]) => `${method} ${path}`)).toContain(
        "GET /api/v1/projects/:id/invitable",
      );
      const ask = (path: string) =>
        dispatch({ method: "GET", path, query: {}, params: {}, headers: {} }, { serverMode: false });
      const unknown = await ask("/api/v1/no-such-route");
      const picker = await ask("/api/v1/projects/00000000-0000-7000-8000-000000000000/invitable");
      expect(picker.status).toBe(404);
      expect((picker as HostJsonResult).body).toEqual((unknown as HostJsonResult).body);
    } finally {
      process.env.AGENTFORGE_SERVER = saved;
    }
  });

  it("answers every project route with the router's own 404", async () => {
    const saved = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    try {
      const unknown = await dispatch(
        { method: "GET", path: "/api/v1/no-such-route", query: {}, params: {}, headers: {} },
        { serverMode: false },
      );
      const { projectRoutes } = await import("./handlers/projects");
      for (const [method, path] of projectRoutes()) {
        const concrete = path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000");
        const result = await dispatch(
          {
            method,
            path: concrete,
            query: {},
            params: {},
            headers: {},
            body: { name: "x", visibility: "workspace", artifactId: "x" },
          },
          { serverMode: false },
        );
        expect(result.type, `${method} ${path}`).toBe("json");
        expect(result.status, `${method} ${path}`).toBe(404);
        expect((result as HostJsonResult).body, `${method} ${path}`).toEqual((unknown as HostJsonResult).body);
      }
    } finally {
      process.env.AGENTFORGE_SERVER = saved;
    }
  });
});
