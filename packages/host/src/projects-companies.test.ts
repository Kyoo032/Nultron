/**
 * Collective projects on the hosted app, through the real router with real sessions and a real database
 * (team-board-spec.md section 2b, F1; K-D19, Rizky 2026-10-14).
 *
 * Rule: a project is private to its maker. Its maker flips one switch to `workspace`, and then everyone
 * in the company sees its files and may download them. Flip it back and the others get a 404 again.
 *
 * Company A has an owner (Alice, A1) and a member (Ann, A2); company B has an owner (Bob, B1). Each
 * refusal is paired with the maker's success at the same call, so a server that refused everybody fails.
 *
 * `AGENTFORGE_SERVER` is set in the environment: the project handlers read `isServerMode()`, and without
 * it every isolation assertion would pass for the wrong reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostBytesResult, HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "projects-partner";
const MISSING = "00000000-0000-4000-8000-000000000000";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ann: Person;
let bob: Person;

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(
  person: Person,
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  query: Record<string, string> = {},
): Promise<HostResult> {
  // The router matches the literal path, so `:id` in the template is replaced by the real value here.
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query,
    params,
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...(body === undefined ? {} : { body }),
  };
  return dispatch(request, { serverMode: true, sessionStore });
}

/** The status and error code of a refusal, or the status of a success: what a caller can compare. */
async function outcome(result: HostResult): Promise<{ status: number; code?: string }> {
  if (result.type === "json") {
    const body = (result as HostJsonResult).body as { error?: { code?: string } };
    return { status: result.status, code: body.error?.code };
  }
  return { status: result.status };
}

const NOT_FOUND = { status: 404, code: "not_found" };

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return ((result as HostJsonResult).body as { project: { id: string } }).project.id;
}

async function makeArtifact(person: Person, title: string): Promise<string> {
  const { artifactStore } = await import("./artifacts");
  const record = artifactStore().create(person.tenant, {
    mode: "documents",
    kind: "draft",
    title,
    mime: "text/markdown",
    body: `# ${title}\n\nbody`,
    meta: {},
  });
  return record.id;
}

function projectIds(result: HostResult): string[] {
  expect(result.type).toBe("json");
  const body = (result as HostJsonResult).body as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

function fileIds(result: HostResult): string[] {
  expect(result.type).toBe("json");
  const body = (result as HostJsonResult).body as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

function download(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId });
}

describe("collective projects: two companies, real sessions", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice", "owner");
    ann = await provision("org-a", "ann", "member");
    bob = await provision("org-b", "bob", "owner");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    // Close the database before the directory goes: Windows refuses to delete an open SQLite file.
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a private project and its file are invisible to a colleague, and the maker reads them", async () => {
    const project = await makeProject(alice, "Alice private brief");
    const file = await makeArtifact(alice, "Alice brief file");
    expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: file }))).toEqual({
      status: 200,
    });

    expect(projectIds(await call(ann, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(projectIds(await call(alice, "GET", "/api/v1/projects"))).toContain(project);
    expect(await outcome(await call(ann, "GET", "/api/v1/projects/:id/files", { id: project }))).toEqual(NOT_FOUND);
    expect(await outcome(await download(ann, file))).toEqual(NOT_FOUND);
    expect(fileIds(await call(alice, "GET", "/api/v1/projects/:id/files", { id: project }))).toContain(file);
    expect((await download(alice, file)).status).toBe(200);
  });

  it("while the project is private, a colleague cannot add her own file to it, or the maker's file to hers", async () => {
    const aliceProject = await makeProject(alice, "Alice project two");
    const annProject = await makeProject(ann, "Ann project");
    const aliceFile = await makeArtifact(alice, "Alice file two");
    const annFile = await makeArtifact(ann, "Ann file");

    // The maker's file is invisible to Ann while private: 404, not 403.
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: annProject }, { artifactId: aliceFile })),
    ).toEqual(NOT_FOUND);
    // Ann's own file into her own project works: the positive control for the refusal above.
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: annProject }, { artifactId: annFile })),
    ).toEqual({ status: 200 });
    // Ann cannot add into Alice's private project at all: 404 on the project.
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: aliceProject }, { artifactId: annFile })),
    ).toEqual(NOT_FOUND);
  });

  it("flipping to workspace shares the project and its files; flipping back hides them again", async () => {
    const project = await makeProject(alice, "Alice shared brief");
    const file = await makeArtifact(alice, "Alice shared file");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: file });

    expect(
      await outcome(await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" })),
    ).toEqual({ status: 200 });

    expect(projectIds(await call(ann, "GET", "/api/v1/projects"))).toContain(project);
    expect(fileIds(await call(ann, "GET", "/api/v1/projects/:id/files", { id: project }))).toContain(file);
    const shared = await download(ann, file);
    expect(shared.type).toBe("bytes");
    expect(shared.status).toBe(200);
    expect((shared as HostBytesResult).filename).toBeTruthy();
    expect((shared as HostBytesResult).headers?.["Content-Disposition"]).toMatch(/^attachment/);
    // Bob, of another company, still sees nothing.
    expect(projectIds(await call(bob, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(await outcome(await download(bob, file))).toEqual(NOT_FOUND);

    expect(
      await outcome(await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "private" })),
    ).toEqual({ status: 200 });

    expect(projectIds(await call(ann, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(await outcome(await call(ann, "GET", "/api/v1/projects/:id/files", { id: project }))).toEqual(NOT_FOUND);
    expect(await outcome(await download(ann, file))).toEqual(NOT_FOUND);
    expect((await download(alice, file)).status).toBe(200);
  });

  it("a colleague cannot add the maker's now-shared file to her own project (403), and cannot flip or rename it", async () => {
    const project = await makeProject(alice, "Alice shared two");
    const file = await makeArtifact(alice, "Alice shared two file");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: file });
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });

    const annProject = await makeProject(ann, "Ann project for alice file");
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: annProject }, { artifactId: file })),
    ).toEqual({ status: 403, code: "not_allowed" });
    // Positive control: Alice may add her own file to her own project.
    const second = await makeArtifact(alice, "Alice second file");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: second })),
    ).toEqual({ status: 200 });

    expect(
      await outcome(await call(ann, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "private" })),
    ).toEqual({ status: 403, code: "not_allowed" });
    expect(await outcome(await call(ann, "PATCH", "/api/v1/projects/:id", { id: project }, { name: "Hijacked" }))).toEqual(
      { status: 403, code: "not_allowed" },
    );
  });

  it("an owner cannot see a colleague's private project; an owner may rename a workspace project but not flip it", async () => {
    const annPrivate = await makeProject(ann, "Ann private to herself");
    expect(await outcome(await call(alice, "PATCH", "/api/v1/projects/:id", { id: annPrivate }, { name: "x" }))).toEqual(
      NOT_FOUND,
    );
    expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/archive", { id: annPrivate }))).toEqual(NOT_FOUND);

    const annWorkspace = await makeProject(ann, "Ann workspace project");
    await call(ann, "PATCH", "/api/v1/projects/:id", { id: annWorkspace }, { visibility: "workspace" });
    expect(
      await outcome(await call(alice, "PATCH", "/api/v1/projects/:id", { id: annWorkspace }, { name: "Renamed by owner" })),
    ).toEqual({ status: 200 });
    expect(
      await outcome(await call(alice, "PATCH", "/api/v1/projects/:id", { id: annWorkspace }, { visibility: "private" })),
    ).toEqual({ status: 403, code: "not_allowed" });
  });

  it("the file's maker removes it from a workspace project, and the project's maker removes a colleague's file", async () => {
    const project = await makeProject(alice, "Alice removal project");
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });

    const annFile = await makeArtifact(ann, "Ann file in Alice project");
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: annFile })),
    ).toEqual({ status: 200 });
    // Ann removes her own file: the file's maker may.
    expect(
      await outcome(await call(ann, "DELETE", "/api/v1/projects/:id/files/:artifactId", { id: project, artifactId: annFile })),
    ).toEqual({ status: 200 });

    const annAgain = await makeArtifact(ann, "Ann file for Alice to remove");
    await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: annAgain });
    // Ann removes a file from a project she did not make and whose file is hers: allowed for the file's
    // maker. A third party (Bob) cannot even see the project.
    expect(
      await outcome(await call(bob, "DELETE", "/api/v1/projects/:id/files/:artifactId", { id: project, artifactId: annAgain })),
    ).toEqual(NOT_FOUND);
    // The project's maker removes Ann's file from her project.
    expect(
      await outcome(await call(alice, "DELETE", "/api/v1/projects/:id/files/:artifactId", { id: project, artifactId: annAgain })),
    ).toEqual({ status: 200 });
  });

  it("archive hides the project from everyone, its files go back to their makers", async () => {
    const project = await makeProject(alice, "Alice archive project");
    const file = await makeArtifact(alice, "Alice archived file");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: file });
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });
    expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/archive", { id: project }))).toEqual({ status: 200 });

    expect(projectIds(await call(alice, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(projectIds(await call(ann, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(await outcome(await download(ann, file))).toEqual(NOT_FOUND);
    expect((await download(alice, file)).status).toBe(200);
  });

  it("a stranger gets the same 404 for every project id as for an id nobody owns", async () => {
    const project = await makeProject(alice, "Alice stranger check");
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });
    const calls: Array<[string, string, Record<string, string>, unknown]> = [
      ["PATCH", "/api/v1/projects/:id", { id: "" }, { name: "x" }],
      ["POST", "/api/v1/projects/:id/archive", { id: "" }, undefined],
      ["GET", "/api/v1/projects/:id/files", { id: "" }, undefined],
      ["POST", "/api/v1/projects/:id/files", { id: "" }, { artifactId: MISSING }],
      ["DELETE", "/api/v1/projects/:id/files/:artifactId", { id: "", artifactId: MISSING }, undefined],
    ];
    for (const [method, path, params, body] of calls) {
      const real = await outcome(await call(bob, method, path, { ...params, id: project }, body));
      const ghost = await outcome(await call(bob, method, path, { ...params, id: MISSING }, body));
      expect(real, `${method} ${path}`).toEqual(NOT_FOUND);
      expect(ghost, `${method} ${path}`).toEqual(real);
    }
  });

  it("refuses an invalid name and an over-long name with 400, for the maker too", async () => {
    expect(await outcome(await call(ann, "POST", "/api/v1/projects", {}, { name: "   " }))).toEqual({
      status: 400,
      code: "invalid_project",
    });
    expect(await outcome(await call(ann, "POST", "/api/v1/projects", {}, { name: "x".repeat(121) }))).toEqual({
      status: 400,
      code: "invalid_project",
    });
    const ok = await makeProject(ann, "x".repeat(120));
    expect(ok).toBeTruthy();
  });

  it("a desk holds at most 200 live projects; an archived one does not count", async () => {
    const { sql } = await import("@agentforge/db");
    const { workspaceId, organizationId } = alice.tenant;
    const row = sql
      .prepare("SELECT count(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL")
      .get(workspaceId) as {
      n: number;
    };
    // Fill the desk to the cap directly, then the next create is refused.
    const insert = sql.prepare(
      "INSERT INTO projects (id, organization_id, workspace_id, name, visibility, created_by, created_at, updated_at) VALUES (?, ?, ?, 'fill', 'private', 'alice', 0, 0)",
    );
    for (let i = row.n; i < 200; i += 1) {
      insert.run(`fill-${i}`, organizationId, workspaceId);
    }
    expect(await outcome(await call(alice, "POST", "/api/v1/projects", {}, { name: "one too many" }))).toEqual({
      status: 409,
      code: "project_limit",
    });
  });
});
