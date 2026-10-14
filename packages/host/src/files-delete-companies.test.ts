/**
 * Deleting a generated file on the hosted app, through the real router with real sessions and a real database
 * (SR-176, team-board-spec.md section 2b and 11; K-D11, K-D19, the leaver rule of 2026-10-06).
 *
 * Rule: a delete succeeds only for the file's maker, or for a company owner or admin. An owner or admin may
 * delete a person's file and may never read it. Anyone else gets the answer for a missing id, and nothing is
 * removed. Taking a file out of a Workspace is a different route and deletes nothing.
 *
 * Company A has an owner (Alice, A1), a member (Ann, A2) and an admin (Adam, A3); company B has an owner (Bob,
 * B1). Each refusal sits next to a success on the same route, so a server that refused everybody would fail.
 *
 * `AGENTFORGE_SERVER` is set in the environment: the delete rule reads `isServerMode()`, and without it every
 * refusal below would pass for the wrong reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-files-delete-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "files-delete-partner";
const MISSING = "00000000-0000-4000-8000-000000000000";
const PNG = Buffer.from("fake-png-bytes-for-a-delete-test");

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ann: Person;
let adam: Person;
let bob: Person;

async function provision(orgId: string, userId: string, role: "owner" | "admin" | "member"): Promise<Person> {
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

async function outcome(result: HostResult): Promise<{ status: number; code?: string }> {
  if (result.type === "json") {
    const body = (result as HostJsonResult).body as { error?: { code?: string } };
    return { status: result.status, code: body.error?.code };
  }
  return { status: result.status };
}

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

const NOT_FOUND = { status: 404, code: "not_found" };

async function makeImage(person: Person, name: string): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([PNG], `${name}.png`, { type: "image/png" }));
  return saved.id;
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

async function makeSharedProject(person: Person, name: string): Promise<string> {
  const created = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(created.status).toBe(201);
  const id = jsonBody<{ project: { id: string } }>(created).project.id;
  const shared = await call(person, "PATCH", "/api/v1/projects/:id", { id }, { visibility: "workspace" });
  expect(shared.status).toBe(200);
  return id;
}

function deleteMedia(person: Person, mediaId: string): Promise<HostResult> {
  return call(person, "DELETE", "/api/v1/media/:mediaId", { mediaId });
}

function readMedia(person: Person, mediaId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/media/:mediaId/file", { mediaId });
}

function deleteArtifact(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "DELETE", "/api/v1/artifacts/:artifactId", { artifactId });
}

function readArtifact(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/artifacts/:artifactId", { artifactId });
}

async function mediaRowExists(mediaId: string): Promise<boolean> {
  const { sql } = await import("@agentforge/db");
  return sql.prepare("SELECT id FROM media WHERE id = ?").get(mediaId) !== undefined;
}

describe("deleting a person's generated files on the hosted app: two companies and an admin", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice", "owner");
    ann = await provision("org-a", "ann", "member");
    adam = await provision("org-a", "adam", "admin");
    bob = await provision("org-b", "bob", "owner");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    // Close the database before the directory goes: Windows refuses to delete an open SQLite file.
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("media", () => {
    it("a colleague's delete of a private image answers as a missing id, removes nothing, and the maker still reads it", async () => {
      const image = await makeImage(alice, "colleague-delete");
      const refused = jsonBody<{ ok: boolean; deleted: boolean; id: string }>(await deleteMedia(ann, image));
      const ghost = jsonBody<{ ok: boolean; deleted: boolean; id: string }>(await deleteMedia(ann, MISSING));

      expect(refused).toEqual({ ok: true, deleted: false, id: image });
      expect(ghost).toEqual({ ok: true, deleted: false, id: MISSING });
      expect(await mediaRowExists(image)).toBe(true);
      expect((await readMedia(alice, image)).status).toBe(200);
    });

    it("a colleague who can read a file in a shared Workspace still cannot delete it", async () => {
      const project = await makeSharedProject(alice, "Shared delete refusal");
      const image = await makeImage(alice, "shared-delete-refusal");
      expect(
        await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: image })),
      ).toEqual({ status: 200 });
      // Positive control: the colleague reads the shared file, so the refusal below is about the delete rule.
      expect((await readMedia(ann, image)).status).toBe(200);

      expect(jsonBody<{ deleted: boolean }>(await deleteMedia(ann, image)).deleted).toBe(false);
      expect(await mediaRowExists(image)).toBe(true);
      expect((await readMedia(ann, image)).status).toBe(200);
      expect((await readMedia(alice, image)).status).toBe(200);
    });

    it("a member of another company gets the missing-id answer for a file of this company, and it stays", async () => {
      const image = await makeImage(alice, "other-company-delete");
      expect(jsonBody<{ deleted: boolean }>(await deleteMedia(bob, image)).deleted).toBe(false);
      expect(await mediaRowExists(image)).toBe(true);
      expect((await readMedia(alice, image)).status).toBe(200);
    });

    it("an admin deletes a member's private file but cannot read it, before or after the delete", async () => {
      const image = await makeImage(ann, "admin-delete");
      expect(await outcome(await readMedia(adam, image))).toEqual(NOT_FOUND);

      expect(jsonBody<{ ok: boolean; deleted: boolean; id: string }>(await deleteMedia(adam, image))).toMatchObject({
        ok: true,
        deleted: true,
        id: image,
      });
      expect(await mediaRowExists(image)).toBe(false);
      expect(await outcome(await readMedia(ann, image))).toEqual(NOT_FOUND);
      expect(await outcome(await readMedia(adam, image))).toEqual(NOT_FOUND);
    });

    it("a company owner deletes a member's file", async () => {
      const image = await makeImage(ann, "owner-delete");
      expect(jsonBody<{ deleted: boolean }>(await deleteMedia(alice, image)).deleted).toBe(true);
      expect(await mediaRowExists(image)).toBe(false);
    });

    it("the maker deletes their own file", async () => {
      const image = await makeImage(ann, "maker-delete");
      expect(jsonBody<{ deleted: boolean }>(await deleteMedia(ann, image)).deleted).toBe(true);
      expect(await mediaRowExists(image)).toBe(false);
    });
  });

  describe("artifacts", () => {
    it("a colleague's delete of a private artifact is a 404, and the maker still reads it", async () => {
      const id = await makeArtifact(alice, "Alice private for delete");
      expect(await outcome(await deleteArtifact(ann, id))).toEqual(NOT_FOUND);
      expect(await outcome(await deleteArtifact(bob, id))).toEqual(NOT_FOUND);
      expect(await outcome(await readArtifact(alice, id))).toEqual({ status: 200 });
    });

    it("a colleague reads a file in a shared Workspace but cannot delete it: the delete answer is a 404", async () => {
      const project = await makeSharedProject(alice, "Shared artifact delete refusal");
      const id = await makeArtifact(alice, "Alice shared for delete");
      expect(
        await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: id })),
      ).toEqual({ status: 200 });
      // Positive control: the colleague reads the shared artifact.
      expect(await outcome(await readArtifact(ann, id))).toEqual({ status: 200 });

      expect(await outcome(await deleteArtifact(ann, id))).toEqual(NOT_FOUND);
      const { artifactStore } = await import("./artifacts");
      expect(artifactStore().get(alice.tenant, id)).not.toBeNull();
    });

    it("an admin deletes a member's private artifact and cannot read it", async () => {
      const id = await makeArtifact(ann, "Ann private for admin delete");
      expect(await outcome(await readArtifact(adam, id))).toEqual(NOT_FOUND);

      expect(await outcome(await deleteArtifact(adam, id))).toEqual({ status: 200 });
      const { artifactStore } = await import("./artifacts");
      expect(artifactStore().get(ann.tenant, id)).toBeNull();
      expect(await outcome(await readArtifact(adam, id))).toEqual(NOT_FOUND);
    });

    it("a legacy artifact with no owner is deleted by a company owner or admin, never by a member", async () => {
      const id = await makeArtifact(alice, "Legacy no owner");
      const { sql } = await import("@agentforge/db");
      sql.prepare("UPDATE artifacts SET owner_user_id = NULL WHERE id = ?").run(id);
      // Legacy rows stay company-visible, as they were made.
      expect(await outcome(await readArtifact(ann, id))).toEqual({ status: 200 });

      expect(await outcome(await deleteArtifact(ann, id))).toEqual(NOT_FOUND);
      expect(await outcome(await readArtifact(ann, id))).toEqual({ status: 200 });
      expect(await outcome(await deleteArtifact(adam, id))).toEqual({ status: 200 });
    });

    it("the maker deletes their own artifact", async () => {
      const id = await makeArtifact(ann, "Ann own artifact");
      expect(await outcome(await deleteArtifact(ann, id))).toEqual({ status: 200 });
      expect(await outcome(await readArtifact(ann, id))).toEqual(NOT_FOUND);
    });
  });
});
