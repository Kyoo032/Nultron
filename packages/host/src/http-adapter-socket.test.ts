import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

vi.mock("./router", () => ({
  dispatch: async () => ({ type: "json" as const, status: 200, body: { ok: true } }),
}));

vi.mock("./workspace", () => ({ readSelectedWorkspaceId: () => undefined }));

vi.mock("./handlers/edit", () => ({ handleBootEditJobs: async () => {} }));

let server: Server;
let port: number;

function get(path: string, host: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  delete process.env.AGENTFORGE_SERVER;
  const { handleNodeRequest } = await import("./http-adapter");
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
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("the Host rule on a real socket, off server mode", () => {
  it("refuses a GET that names a rebound host, with or without the dev port", async () => {
    for (const host of ["rebind.example:3000", "rebind.example"]) {
      const answered = await get("/api/v1/workspaces", host);
      expect(answered.status, host).toBe(403);
      expect(JSON.parse(answered.body).error.code).toBe("forbidden");
    }
  });

  it("serves a GET on the loopback names", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const answered = await get("/api/v1/workspaces", host);
      expect(answered.status, host).toBe(200);
    }
  });

  it("refuses HEAD on a rebound host and answers the liveness probe on any host", async () => {
    expect((await get("/api/v1/workspaces", "rebind.example:3000", "HEAD")).status).toBe(403);
    expect((await get("/healthz", "rebind.example:3000")).status).toBe(200);
  });
});
