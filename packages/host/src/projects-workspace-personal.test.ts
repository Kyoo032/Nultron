/**
 * Personal parity for a Workspace chat (team-board-spec.md section 2b, W1). On Personal there is one person
 * per desk and no Workspaces: a thread created with a `projectId` is the same thread it was before W1 (no
 * project attached), and the Workspace routes answer the router's own 404.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostJsonResult } from "./types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-workspace-personal-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

const { dispatch } = await import("./router");
const PERSONAL_PROJECT = "00000000-0000-7000-8000-000000000000";

describe("a Workspace chat on Personal", () => {
  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it(
    "ignores projectId: the thread is a plain chat, and the Workspace routes are the router's 404",
    async () => {
      const req = (method: string, path: string, body?: unknown) =>
        dispatch(
          { method, path, query: {}, params: {}, headers: {}, ...(body === undefined ? {} : { body }) },
          {
            serverMode: false,
          },
        );
      const chat = (await req("GET", "/api/v1/chat")) as HostJsonResult;
      const created = await req("POST", "/api/v1/threads", {
        agentId: (chat.body as { agent: { id: string } }).agent.id,
        projectId: PERSONAL_PROJECT,
      });
      expect(created.status).toBe(201);
      expect(
        ((created as HostJsonResult).body as { thread: { projectId: string | null } }).thread.projectId,
      ).toBeNull();

      const unknown = await req("GET", "/api/v1/no-such-route");
      const knowledge = await req("GET", `/api/v1/projects/${PERSONAL_PROJECT}/knowledge`);
      const threads = await req("GET", `/api/v1/projects/${PERSONAL_PROJECT}/threads`);
      const uploads = await req("POST", `/api/v1/projects/${PERSONAL_PROJECT}/uploads`, {});
      for (const result of [knowledge, threads, uploads]) {
        expect(result.status).toBe(404);
        expect((result as HostJsonResult).body).toEqual((unknown as HostJsonResult).body);
      }
    },
    ROUTER_IMPORT_BUDGET_MS,
  );
});
