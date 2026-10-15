import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-media-companies-"));
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

const PARTNER = "projects-media-partner";
const MISSING = "00000000-0000-4000-8000-000000000000";
const PNG = Buffer.from("fake-png-bytes-for-a-test");
const MP4 = Buffer.from("fake-mp4-bytes-for-a-test");

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

/** The person's colleagues in this file: Alice's is Ann; Bob has none. */
function colleaguesOf(person: Person): Person[] {
  return person === alice ? [ann] : [];
}

/** Invites the person's colleagues into the Workspace: it is shared with its members only (K-D22). */
async function shareWithColleagues(person: Person, projectId: string): Promise<void> {
  for (const colleague of colleaguesOf(person)) {
    expect(
      await outcome(
        await call(
          person,
          "POST",
          "/api/v1/projects/:id/members",
          { id: projectId },
          {
            userId: colleague.tenant.userId,
          },
        ),
      ),
    ).toEqual({ status: 201 });
  }
}

/** A generated image as a person's own media row: the same writer the Images studio and chat use. */
async function makeImage(person: Person, name: string): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([PNG], `${name}.png`, { type: "image/png" }));
  return saved.id;
}

async function makeVideo(person: Person, name: string): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([MP4], `${name}.mp4`, { type: "video/mp4" }));
  return saved.id;
}

function readMedia(person: Person, mediaId: string, download = false): Promise<HostResult> {
  return call(person, "GET", "/api/v1/media/:mediaId/file", { mediaId }, undefined, download ? { download: "1" } : {});
}

type FileItem = {
  id: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  ownerUserId: string | null;
  downloadUrl: string;
  previewUrl: string | null;
};

function fileItems(result: HostResult): FileItem[] {
  expect(result.type).toBe("json");
  return ((result as HostJsonResult).body as { items: FileItem[] }).items;
}

function projectIds(result: HostResult): string[] {
  expect(result.type).toBe("json");
  const body = (result as HostJsonResult).body as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

describe("generated media in a Workspace: two companies, real sessions", () => {
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

  it("adding the image to a shared Workspace lets a colleague read and download it; another company still gets 404", async () => {
    const project = await makeProject(alice, "Shared image Workspace");
    await shareWithColleagues(alice, project);
    const image = await makeImage(alice, "shared-image");

    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: image })),
    ).toEqual({ status: 200 });

    const read = await readMedia(ann, image);
    expect(read.type).toBe("bytes");
    expect(read.status).toBe(200);
    const saved = await readMedia(ann, image, true);
    expect(saved.status).toBe(200);
    // The download name is built from the row (kind, first eight characters of the id, the extension).
    expect((saved as HostBytesResult).filename).toBe(`image-${image.slice(0, 8)}.png`);

    expect(await outcome(await readMedia(bob, image))).toEqual(NOT_FOUND);
    expect(projectIds(await call(bob, "GET", "/api/v1/projects"))).not.toContain(project);
    expect(await outcome(await call(bob, "GET", "/api/v1/projects/:id/files", { id: project }))).toEqual(NOT_FOUND);
  });

  it("the Workspace file list carries the media row: kind, mime, size, who added it, and a download URL", async () => {
    const project = await makeProject(alice, "Listed media Workspace");
    await shareWithColleagues(alice, project);
    const image = await makeImage(alice, "listed-image");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: image });

    const items = fileItems(await call(ann, "GET", "/api/v1/projects/:id/files", { id: project }));
    const item = items.find((entry) => entry.id === image);
    expect(item).toMatchObject({
      id: image,
      kind: "image",
      mime: "image/png",
      sizeBytes: PNG.byteLength,
      ownerUserId: "alice",
      previewUrl: `/api/v1/media/${image}/file`,
      downloadUrl: `/api/v1/media/${image}/file?download=1`,
    });
  });

  it("a video added to a Workspace is listed as a video and streams for a colleague", async () => {
    const project = await makeProject(alice, "Shared video Workspace");
    await shareWithColleagues(alice, project);
    const video = await makeVideo(alice, "shared-video");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: video })),
    ).toEqual({ status: 200 });

    const items = fileItems(await call(ann, "GET", "/api/v1/projects/:id/files", { id: project }));
    expect(items.find((entry) => entry.id === video)).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect((await readMedia(ann, video)).status).toBe(200);
  });

  it("a colleague may not add the maker's media to her own Workspace (403), and the maker may", async () => {
    const shared = await makeProject(alice, "Shared for refusal");
    await shareWithColleagues(alice, shared);
    const aliceImage = await makeImage(alice, "refused-image");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: shared }, { mediaId: aliceImage });

    const annProject = await makeProject(ann, "Ann project for alice media");
    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: annProject }, { mediaId: aliceImage })),
    ).toEqual({ status: 403, code: "not_allowed" });
    // Positive control: Alice may add her own media to her own Workspace.
    const aliceVideo = await makeVideo(alice, "private-video");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: shared }, { mediaId: aliceVideo })),
    ).toEqual({ status: 200 });

    const privateProject = await makeProject(alice, "Alice private Workspace");
    expect(
      await outcome(
        await call(alice, "POST", "/api/v1/projects/:id/files", { id: privateProject }, { mediaId: aliceVideo }),
      ),
    ).toEqual({ status: 200 });
    expect((await readMedia(alice, aliceVideo)).status).toBe(200);
  });

  it("a colleague's own image joins a shared Workspace, and the maker of the Workspace sees it there", async () => {
    const project = await makeProject(alice, "Ann image Workspace");
    await shareWithColleagues(alice, project);
    const annImage = await makeImage(ann, "ann-image");

    expect(
      await outcome(await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: annImage })),
    ).toEqual({ status: 200 });
    expect((await readMedia(alice, annImage)).status).toBe(200);
    expect(await readMedia(bob, annImage)).toMatchObject({ status: 404 });
  });

  it("the file's maker removes it from a shared Workspace; the Workspace's maker removes a colleague's media; a stranger's refusal is a 404", async () => {
    const project = await makeProject(alice, "Removal media Workspace");
    await shareWithColleagues(alice, project);
    const annImage = await makeImage(ann, "removal-ann-image");
    await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: annImage });
    const aliceImage = await makeImage(alice, "removal-alice-image");
    await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: aliceImage });

    // A colleague may not remove the maker's media from a Workspace she did not make: 403.
    expect(
      await outcome(
        await call(ann, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: project, mediaId: aliceImage }),
      ),
    ).toEqual({ status: 403, code: "not_allowed" });
    // Another company cannot even see the Workspace.
    expect(
      await outcome(
        await call(bob, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: project, mediaId: annImage }),
      ),
    ).toEqual(NOT_FOUND);
    // The file's maker removes her own media: allowed.
    expect(
      await outcome(
        await call(ann, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: project, mediaId: annImage }),
      ),
    ).toEqual({ status: 200 });
    // Removed, its Workspace is cleared: it is no longer listed, and it is back to its maker's rule.
    const listed = fileItems(await call(alice, "GET", "/api/v1/projects/:id/files", { id: project })).map(
      (item) => item.id,
    );
    expect(listed).not.toContain(annImage);
    expect((await readMedia(ann, annImage)).status).toBe(200);
    // The Workspace's maker removes her own media from it.
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: project, mediaId: aliceImage }),
      ),
    ).toEqual({ status: 200 });
    // Removing media that is not in this Workspace is the same 404 as an unknown id.
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: project, mediaId: MISSING }),
      ),
    ).toEqual(NOT_FOUND);
  });

  it("a stranger gets the same 404 for a media id that is hidden as for an id nobody owns", async () => {
    const image = await makeImage(alice, "ghost-check");
    const hidden = await outcome(await readMedia(bob, image));
    const ghost = await outcome(await readMedia(bob, MISSING));
    expect(hidden).toEqual(NOT_FOUND);
    expect(ghost).toEqual(hidden);

    const project = await makeProject(bob, "Bob ghost check");
    await shareWithColleagues(bob, project);
    const addHidden = await outcome(
      await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: image }),
    );
    const addGhost = await outcome(
      await call(ann, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: MISSING }),
    );
    expect(addHidden).toEqual(NOT_FOUND);
    expect(addGhost).toEqual(addHidden);
  });

  it("the add body names exactly one of artifactId and mediaId; anything else is a 400", async () => {
    const project = await makeProject(alice, "Body check Workspace");
    const image = await makeImage(alice, "body-check");
    expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, {}))).toEqual({
      status: 400,
      code: "invalid_project",
    });
    expect(
      await outcome(
        await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: image, artifactId: image }),
      ),
    ).toEqual({ status: 400, code: "invalid_project" });
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: "  " })),
    ).toEqual({ status: 400, code: "invalid_project" });
  });
});
