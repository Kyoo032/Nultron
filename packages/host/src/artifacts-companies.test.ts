/**
 * Generated files on the hosted app, through the real router with real sessions and a real database
 * (SR-175, Rizky 2026-10-14; team-board-spec.md section 2b, F0).
 *
 * Rule: a file a person makes on their own is visible only to them; a file put into a collective
 * project is visible to, and downloadable by, everyone in the company. Another company never sees it.
 *
 * Company A has an owner (Alice, A1) and a member (Ann, A2); company B has an owner (Bob, B1). Each
 * refusal is paired with the maker reading the same thing successfully, so a server that refused
 * everybody fails here. A row another person cannot see answers exactly like a missing id.
 *
 * `AGENTFORGE_SERVER` is set in the environment: the artifact handlers read `isServerMode()`, and
 * without it every isolation assertion would pass for the wrong reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-artifacts-companies-"));
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

const PARTNER = "artifacts-partner";

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

function request(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...over,
  };
}

function call(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): Promise<HostResult> {
  return dispatch(request(person, method, path, over), { serverMode: true, sessionStore });
}

/** The status and error code of a refusal, or the status of a success: what a caller can compare. */
async function outcome(result: HostResult): Promise<{ status: number; code?: string }> {
  if (result.type === "json") {
    const body = (result as HostJsonResult).body as { error?: { code?: string } };
    return { status: result.status, code: body.error?.code };
  }
  return { status: result.status };
}

function artifactIds(result: HostResult): string[] {
  expect(result.type).toBe("json");
  const body = (result as HostJsonResult).body as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
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

async function putInProject(artifactId: string): Promise<void> {
  const { sql } = await import("@agentforge/db");
  sql.prepare("UPDATE artifacts SET project_id = 'project-1' WHERE id = ?").run(artifactId);
}

// A single PNG pixel, enough to make a real media row through the same store chat uses.
const PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

async function makeMedia(person: Person): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([PNG], "pixel.png", { type: "image/png" }));
  return saved.id;
}

describe("generated files on the hosted app: two companies, real sessions", () => {
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

  it("a person's own artifact is visible to that person only", async () => {
    const id = await makeArtifact(alice, "Alice private plan");

    expect(artifactIds(await call(alice, "GET", "/api/v1/artifacts"))).toContain(id);
    expect(artifactIds(await call(ann, "GET", "/api/v1/artifacts"))).not.toContain(id);
    expect(artifactIds(await call(bob, "GET", "/api/v1/artifacts"))).not.toContain(id);

    const own = await call(alice, "GET", `/api/v1/artifacts/${id}`, { params: { artifactId: id } });
    expect(own.type).toBe("json");
    expect(own.status).toBe(200);
  });

  it("another person's read of a private artifact answers exactly like a missing id", async () => {
    const id = await makeArtifact(alice, "Alice second plan");
    const missing = "00000000-0000-4000-8000-000000000000";

    for (const path of [
      (artifactId: string) => `/api/v1/artifacts/${artifactId}`,
      (artifactId: string) => `/api/v1/artifacts/${artifactId}/file`,
    ]) {
      const hidden = await call(ann, "GET", path(id), { params: { artifactId: id } });
      const gone = await call(ann, "GET", path(missing), { params: { artifactId: missing } });
      expect(await outcome(hidden)).toEqual({ status: 404, code: "not_found" });
      expect(await outcome(gone)).toEqual(await outcome(hidden));
    }
  });

  it("a private artifact cannot be deleted by a company member who did not make it", async () => {
    const id = await makeArtifact(alice, "Alice third plan");
    const hidden = await call(ann, "DELETE", `/api/v1/artifacts/${id}`, { params: { artifactId: id } });
    expect(await outcome(hidden)).toEqual({ status: 404, code: "not_found" });
    const { artifactStore } = await import("./artifacts");
    expect(artifactStore().get(alice.tenant, id)).not.toBeNull();
  });

  it("a file in a project stays private to its maker until F1 makes projects shareable (K-D19)", async () => {
    const id = await makeArtifact(alice, "Project brief, still private");
    await putInProject(id);

    // Private by default: a project id alone grants nothing, to a teammate or to another company.
    expect(artifactIds(await call(ann, "GET", "/api/v1/artifacts"))).not.toContain(id);
    expect(
      await outcome(await call(ann, "GET", `/api/v1/artifacts/${id}/file`, { params: { artifactId: id } })),
    ).toEqual({ status: 404, code: "not_found" });
    expect(artifactIds(await call(bob, "GET", "/api/v1/artifacts"))).not.toContain(id);
    expect(
      await outcome(await call(bob, "GET", `/api/v1/artifacts/${id}/file`, { params: { artifactId: id } })),
    ).toEqual({ status: 404, code: "not_found" });
    const own = await call(alice, "GET", `/api/v1/artifacts/${id}/file`, { params: { artifactId: id } });
    expect(own.type).toBe("bytes");
    expect(new TextDecoder().decode((own as HostBytesResult).bytes)).toContain("Project brief, still private");
  });

  it("a teammate's delete of a project file they cannot see is a 404, and the maker still deletes it", async () => {
    const id = await makeArtifact(alice, "Project file to keep");
    await putInProject(id);
    expect(await outcome(await call(ann, "DELETE", `/api/v1/artifacts/${id}`, { params: { artifactId: id } }))).toEqual(
      {
        status: 404,
        code: "not_found",
      },
    );
    expect(
      await outcome(await call(alice, "DELETE", `/api/v1/artifacts/${id}`, { params: { artifactId: id } })),
    ).toEqual({
      status: 200,
    });
  });

  it("a media file is downloadable as an attachment on request, and inline without the flag", async () => {
    const id = await makeMedia(alice);
    const inline = await call(ann, "GET", `/api/v1/media/${id}/file`, { params: { mediaId: id } });
    expect(inline.type).toBe("bytes");
    expect((inline as HostBytesResult).filename).toBeUndefined();

    const attached = await call(ann, "GET", `/api/v1/media/${id}/file`, {
      params: { mediaId: id },
      query: { download: "1" },
    });
    expect(attached.type).toBe("bytes");
    expect((attached as HostBytesResult).filename).toBe(`image-${id.slice(0, 8)}.png`);
  });

  it("another company's media id is still a 404, download or not", async () => {
    const id = await makeMedia(alice);
    const other = await call(bob, "GET", `/api/v1/media/${id}/file`, {
      params: { mediaId: id },
      query: { download: "1" },
    });
    expect(await outcome(other)).toEqual({ status: 404, code: "not_found" });
  });
});
