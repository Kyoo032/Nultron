import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTenant } from "../tenant";
import type { HostJsonResult, HostRequest, HostResult } from "../types";
import { createFolderRoot } from "./folder-root";
import { mountFilePath } from "./mount-record";
import { createFolderRoutes, FOLDER_ROUTES } from "./routes";
import { makeSandbox, openProposalsFixture, type ProposalsFixture, type Sandbox } from "./test-support";

let box: Sandbox;
let fx: ProposalsFixture;
let routes: ReturnType<typeof createFolderRoutes>;

function call(
  method: string,
  pattern: string,
  init: Partial<HostRequest> & { transport?: string } = {},
): Promise<HostResult> {
  const route = routes.find(([m, p]) => m === method && p === pattern);
  if (!route) {
    throw new Error(`no route ${method} ${pattern}`);
  }
  const { transport, ...rest } = init;
  return route[2]({
    method,
    path: pattern,
    query: {},
    params: {},
    headers: transport ? { "x-agentforge-transport": transport } : {},
    ...rest,
  });
}

function json(result: HostResult): HostJsonResult {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return result;
}

function errorOf(result: HostResult): { code?: string; message?: string } {
  return (json(result).body as { error?: { code?: string; message?: string } }).error ?? {};
}

beforeEach(() => {
  box = makeSandbox();
  fx = openProposalsFixture();
  routes = createFolderRoutes(async () => ({ store: fx.store }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(mountFilePath(), { force: true });
  fx.db.close();
  box.dispose();
});

describe("the route table", () => {
  it("is the seven registrations, each a [method, pattern, handler] tuple", () => {
    expect(FOLDER_ROUTES.map(([method, pattern]) => `${method} ${pattern}`)).toEqual([
      "GET /api/v1/folder",
      "POST /api/v1/folder/mount",
      "DELETE /api/v1/folder/mount",
      "GET /api/v1/folder/proposals",
      "GET /api/v1/folder/proposals/:proposalId",
      "POST /api/v1/folder/proposals/:proposalId/approve",
      "POST /api/v1/folder/proposals/:proposalId/reject",
    ]);
    expect(FOLDER_ROUTES.every(([, , handler]) => typeof handler === "function")).toBe(true);
  });
});

describe("mounting", () => {
  it("reports no folder before one is picked", async () => {
    expect(json(await call("GET", "/api/v1/folder")).body).toEqual({ mounted: false, name: null, available: true });
  });

  it("accepts a folder over IPC and reports only its name", async () => {
    const result = await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: box.folder } });
    expect(json(result).status).toBe(200);
    expect(json(result).body).toEqual({ mounted: true, name: "folder", available: true });
    expect(JSON.stringify(json(await call("GET", "/api/v1/folder")).body)).not.toContain(box.base);
    expect(json(await call("GET", "/api/v1/folder")).body).toEqual({ mounted: true, name: "folder", available: true });
  });

  it.each(["http", "web", ""])("refuses a folder over the %j transport", async (transport) => {
    const result = await call("POST", "/api/v1/folder/mount", { transport, body: { path: box.folder } });
    expect(json(result).status).toBe(403);
    expect(errorOf(result).code).toBe("folder_mount_ipc_only");
    expect(json(await call("GET", "/api/v1/folder")).body).toMatchObject({ mounted: false });
  });

  it("refuses a bad folder with a fixed sentence that does not echo the path", async () => {
    const missing = path.join(box.base, "does-not-exist");
    const result = await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: missing } });
    expect(json(result).status).toBe(400);
    expect(errorOf(result)).toEqual({ code: "folder_mount_refused", message: "That folder does not exist." });
    const relative = await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: "relative/dir" } });
    expect(errorOf(relative).message).toBe("Pick a folder by its full path.");
    const none = await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: {} });
    expect(errorOf(none).code).toBe("folder_mount_refused");
  });

  it("unmounts", async () => {
    await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: box.folder } });
    expect(json(await call("DELETE", "/api/v1/folder/mount")).body).toEqual({ ok: true });
    expect(json(await call("GET", "/api/v1/folder")).body).toEqual({ mounted: false, name: null, available: true });
  });
});

describe("proposals through the routes", () => {
  async function mountAndPropose(rel: string, content: string): Promise<string> {
    await call("POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: box.folder } });
    const tenant = await getTenant({ workspaceId: undefined, session: undefined });
    const root = await createFolderRoot(tenant, { kind: "agent", runId: "run-9", mode: "chat" }, { store: fx.store });
    if ("ok" in root) {
      throw new Error(`root was refused: ${root.code}`);
    }
    const outcome = await root.write(rel as never, content, { kind: "agent", runId: "run-9", mode: "chat" });
    if (outcome.status !== "pending_approval") {
      throw new Error("expected pending");
    }
    return outcome.proposalId;
  }

  it("lists, shows the diff, approves and writes the file", async () => {
    box.put("a.txt", "old");
    const id = await mountAndPropose("a.txt", "new");

    const listed = json(await call("GET", "/api/v1/folder/proposals", { query: { status: "pending" } })).body as {
      items: Array<{ id: string; path: string; status: string }>;
    };
    expect(listed.items.map((item) => [item.id, item.path, item.status])).toEqual([[id, "a.txt", "pending"]]);

    const diff = json(await call("GET", "/api/v1/folder/proposals/:proposalId", { params: { proposalId: id } })).body;
    expect(diff).toEqual({
      id,
      path: "a.txt",
      kind: "write",
      status: "pending",
      before: "old",
      after: "new",
      stale: false,
    });

    const approved = await call("POST", "/api/v1/folder/proposals/:proposalId/approve", { params: { proposalId: id } });
    expect(json(approved).status).toBe(200);
    expect(json(approved).body).toEqual({ id, status: "applied" });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("new");
  });

  it("reports stale as a normal answer, and a second decision as 409", async () => {
    box.put("a.txt", "old");
    const id = await mountAndPropose("a.txt", "new");
    box.put("a.txt", "changed");
    const stale = await call("POST", "/api/v1/folder/proposals/:proposalId/approve", { params: { proposalId: id } });
    expect(json(stale).status).toBe(200);
    expect(json(stale).body).toEqual({ id, status: "stale" });
    const again = await call("POST", "/api/v1/folder/proposals/:proposalId/reject", { params: { proposalId: id } });
    expect(json(again).status).toBe(409);
    expect(errorOf(again).code).toBe("proposal_not_pending");
  });

  it("rejects", async () => {
    box.put("a.txt", "old");
    const id = await mountAndPropose("a.txt", "new");
    const rejected = await call("POST", "/api/v1/folder/proposals/:proposalId/reject", { params: { proposalId: id } });
    expect(json(rejected).body).toEqual({ id, status: "rejected" });
    expect(readFileSync(path.join(box.folder, "a.txt"), "utf8")).toBe("old");
  });

  it("answers 404 for an id from another desk and 400 for an unknown status filter", async () => {
    await mountAndPropose("a.txt", "x");
    fx.db
      .prepare(
        `INSERT INTO file_proposals (id, workspace_id, run_id, path, kind, before_sha256, after_body, status, created_at, decided_at)
         VALUES ('foreign', 'some-other-desk', 'r', 'a.txt', 'write', NULL, NULL, 'pending', 1, NULL)`,
      )
      .run();
    for (const pattern of [
      "/api/v1/folder/proposals/:proposalId",
      "/api/v1/folder/proposals/:proposalId/approve",
      "/api/v1/folder/proposals/:proposalId/reject",
    ]) {
      const method = pattern.endsWith(":proposalId") ? "GET" : "POST";
      const result = await call(method, pattern, { params: { proposalId: "foreign" } });
      expect(json(result).status, pattern).toBe(404);
      expect(errorOf(result).code, pattern).toBe("not_found");
    }
    const bad = await call("GET", "/api/v1/folder/proposals", { query: { status: "nonsense" } });
    expect(json(bad).status).toBe(400);
    const listed = json(await call("GET", "/api/v1/folder/proposals")).body as { items: Array<{ id: string }> };
    expect(listed.items.map((item) => item.id)).not.toContain("foreign");
  });
});

describe("server mode", () => {
  it("answers the status read with available false and refuses every other route", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    expect(json(await call("GET", "/api/v1/folder")).body).toEqual({ mounted: false, name: null, available: false });
    const refused: Array<[string, string, Partial<HostRequest> & { transport?: string }]> = [
      ["POST", "/api/v1/folder/mount", { transport: "ipc", body: { path: box.folder } }],
      ["POST", "/api/v1/folder/mount", { transport: "http", body: { path: box.folder } }],
      ["DELETE", "/api/v1/folder/mount", {}],
      ["GET", "/api/v1/folder/proposals", {}],
      ["GET", "/api/v1/folder/proposals/:proposalId", { params: { proposalId: "x" } }],
      ["POST", "/api/v1/folder/proposals/:proposalId/approve", { params: { proposalId: "x" } }],
      ["POST", "/api/v1/folder/proposals/:proposalId/reject", { params: { proposalId: "x" } }],
    ];
    for (const [method, pattern, init] of refused) {
      const result = await call(method, pattern, init);
      expect(json(result).status, `${method} ${pattern}`).toBe(403);
      expect(errorOf(result).code, `${method} ${pattern}`).toBe("folder_unavailable");
    }
  });
});
