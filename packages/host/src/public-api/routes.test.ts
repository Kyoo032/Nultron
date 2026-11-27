import { describe, expect, it } from "vitest";
import { dispatchPublicApi, publicRouteRegistrations } from "./routes";
import type { HostRequest } from "../types";

function request(path: string, method = "GET", headers: Record<string, string> = {}): HostRequest {
  return { method, path, headers, params: {}, query: {}, body: undefined };
}

describe("public route table (F5a)", () => {
  it("every row is bearer-keyed: an anonymous call is a 401, never a handler run", async () => {
    const env = { ...process.env, AGENTFORGE_PUBLIC_API: "on" };
    const saved = process.env.AGENTFORGE_PUBLIC_API;
    process.env.AGENTFORGE_PUBLIC_API = "on";
    try {
      for (const route of publicRouteRegistrations()) {
        const path = route.path.replace(/:([A-Za-z]+)/g, "x");
        const result = await dispatchPublicApi(request(path, route.method));
        expect(result.type).toBe("json");
        // Every public row — including the OpenAPI doc — is behind the key. The doc
        // describes only authenticated endpoints, so it needs no anonymous carve-out.
        expect(result.status, `${route.method} ${route.path}`).toBe(401);
        const body = (result as { body: { error: { code: string } } }).body;
        expect(body.error.code).toBe("invalid_api_key");
      }
      void env;
    } finally {
      if (saved === undefined) {
        delete process.env.AGENTFORGE_PUBLIC_API;
      } else {
        process.env.AGENTFORGE_PUBLIC_API = saved;
      }
    }
  });

  it("disabled flag answers 404 for everything, even the doc", async () => {
    const saved = process.env.AGENTFORGE_PUBLIC_API;
    delete process.env.AGENTFORGE_PUBLIC_API;
    try {
      const result = await dispatchPublicApi(request("/api/public/v1/openapi.json"));
      expect(result.status).toBe(404);
      expect((await dispatchPublicApi(request("/api/public/v1/agents"))).status).toBe(404);
    } finally {
      if (saved !== undefined) process.env.AGENTFORGE_PUBLIC_API = saved;
    }
  });

  it("non-public paths get a 404 under the public dispatcher", async () => {
    const saved = process.env.AGENTFORGE_PUBLIC_API;
    process.env.AGENTFORGE_PUBLIC_API = "on";
    try {
      expect((await dispatchPublicApi(request("/api/v1/settings"))).status).toBe(404);
    } finally {
      if (saved === undefined) delete process.env.AGENTFORGE_PUBLIC_API;
      else process.env.AGENTFORGE_PUBLIC_API = saved;
    }
  });
});
