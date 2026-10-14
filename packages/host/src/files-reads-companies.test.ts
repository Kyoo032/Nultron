/**
 * Reads of generated media on the hosted app, through the real router and the real stores with real sessions
 * and a real database (SR-175, team-board-spec.md sections 2b and 11, K-D19).
 *
 * Rule: a person sees their own generated media and what a live Workspace of their desk holds. The studio
 * galleries, the storage report's largest-files list, Edit's still and output reads, and a job mode's inlined
 * picture all follow it. The storage report is the one exception on the owner side: an owner or admin sees the
 * sizes and ids of the whole company's media (they manage storage) and no link to any of it.
 *
 * Company A has an owner (Alice, A1), a member (Ann, A2) and an admin (Adam, A3); company B has an owner (Bob,
 * B1). Each refusal sits next to the same person reading the same row successfully.
 *
 * `AGENTFORGE_SERVER` is set in the environment: every reader here checks `isServerMode()`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-files-reads-companies-"));
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

const PARTNER = "files-reads-partner";
const PNG = Buffer.from("fake-png-bytes-for-a-read-test");
const MP4 = Buffer.from("fake-mp4-bytes-for-a-read-test");
const MP3 = Buffer.from("fake-mp3-bytes-for-a-read-test");

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
): Promise<HostResult> {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query: {},
    params,
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...(body === undefined ? {} : { body }),
  };
  return dispatch(request, { serverMode: true, sessionStore });
}

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

function readMedia(person: Person, mediaId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/media/:mediaId/file", { mediaId });
}

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

async function makeAudio(person: Person, name: string): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([MP3], `${name}.mp3`, { type: "audio/mpeg" }), ["audio"]);
  return saved.id;
}

async function shareInWorkspace(person: Person, mediaId: string): Promise<void> {
  const created = await call(person, "POST", "/api/v1/projects", {}, { name: `Shared ${mediaId.slice(0, 8)}` });
  expect(created.status).toBe(201);
  const project = jsonBody<{ project: { id: string } }>(created).project.id;
  expect(
    (await call(person, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" })).status,
  ).toBe(200);
  const attached = await call(person, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId });
  expect(attached.status).toBe(200);
}

type GalleryItem = { id: string; url: string };

/** The ids a person's gallery lists, and a check that every one of them is a file that person can open. */
async function galleryIds(person: Person, path: string): Promise<string[]> {
  const items = jsonBody<{ items: GalleryItem[] }>(await call(person, "GET", path)).items;
  for (const item of items) {
    expect((await readMedia(person, item.id)).status, `${path} lists ${item.id} but its file is refused`).toBe(200);
  }
  return items.map((item) => item.id);
}

describe("generated media reads on the hosted app: two companies and an admin", () => {
  let aliceOwnImage: string;
  let aliceSharedImage: string;
  let annOwnImage: string;
  let aliceOwnVideo: string;
  let annSharedVideo: string;
  let aliceOwnAudio: string;

  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice", "owner");
    ann = await provision("org-a", "ann", "member");
    adam = await provision("org-a", "adam", "admin");
    bob = await provision("org-b", "bob", "owner");

    aliceOwnImage = await makeImage(alice, "alice-own");
    aliceSharedImage = await makeImage(alice, "alice-shared");
    await shareInWorkspace(alice, aliceSharedImage);
    annOwnImage = await makeImage(ann, "ann-own");
    aliceOwnVideo = await makeVideo(alice, "alice-own");
    annSharedVideo = await makeVideo(ann, "ann-shared");
    await shareInWorkspace(ann, annSharedVideo);
    aliceOwnAudio = await makeAudio(alice, "alice-own");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    // Close the database before the directory goes: Windows refuses to delete an open SQLite file.
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("studio galleries", () => {
    it("the Images gallery lists a person's own images and a shared Workspace's, never a colleague's private one", async () => {
      const alices = await galleryIds(alice, "/api/v1/images");
      const anns = await galleryIds(ann, "/api/v1/images");
      const adams = await galleryIds(adam, "/api/v1/images");
      const bobs = await galleryIds(bob, "/api/v1/images");

      expect(alices).toEqual(expect.arrayContaining([aliceOwnImage, aliceSharedImage]));
      expect(alices).not.toContain(annOwnImage);
      expect(anns).toEqual(expect.arrayContaining([annOwnImage, aliceSharedImage]));
      expect(anns).not.toContain(aliceOwnImage);
      // An admin manages storage, not other people's files: a private image is not on the admin's gallery.
      expect(adams).toContain(aliceSharedImage);
      expect(adams).not.toContain(aliceOwnImage);
      expect(adams).not.toContain(annOwnImage);
      expect(bobs).not.toContain(aliceSharedImage);
    });

    it("the Videos gallery follows the same rule", async () => {
      const alices = await galleryIds(alice, "/api/v1/videos");
      const anns = await galleryIds(ann, "/api/v1/videos");
      const adams = await galleryIds(adam, "/api/v1/videos");

      expect(alices).toEqual(expect.arrayContaining([aliceOwnVideo, annSharedVideo]));
      expect(anns).toEqual(expect.arrayContaining([annSharedVideo]));
      expect(anns).not.toContain(aliceOwnVideo);
      expect(adams).toContain(annSharedVideo);
      expect(adams).not.toContain(aliceOwnVideo);
    });

    it("the Music gallery lists only its maker's audio, since audio cannot sit in a Workspace", async () => {
      expect(await galleryIds(alice, "/api/v1/music")).toContain(aliceOwnAudio);
      expect(await galleryIds(ann, "/api/v1/music")).not.toContain(aliceOwnAudio);
      expect(await galleryIds(adam, "/api/v1/music")).not.toContain(aliceOwnAudio);
    });
  });

  describe("storage report", () => {
    type Largest = { id: string; kind: string; mime: string; sizeBytes: number; createdAt: string };

    async function largest(person: Person): Promise<{ items: Largest[]; raw: string }> {
      const result = await call(person, "GET", "/api/v1/storage/usage");
      const body = jsonBody<{ largest: Largest[] }>(result);
      return { items: body.largest, raw: JSON.stringify(body.largest) };
    }

    it("an owner sees the sizes and ids of the whole company's media, and an admin does too", async () => {
      const alices = (await largest(alice)).items.map((item) => item.id);
      const adams = (await largest(adam)).items.map((item) => item.id);
      for (const ids of [alices, adams]) {
        expect(ids).toEqual(expect.arrayContaining([aliceOwnImage, annOwnImage, annSharedVideo]));
      }
    });

    it("a member sees only their own media in the storage list", async () => {
      const anns = (await largest(ann)).items.map((item) => item.id);
      expect(anns).toEqual(expect.arrayContaining([annOwnImage, annSharedVideo]));
      expect(anns).not.toContain(aliceOwnImage);
      expect(anns).not.toContain(aliceOwnVideo);
    });

    it("no entry of the storage list carries a preview or a download link, to an owner or admin either", async () => {
      for (const person of [alice, ann, adam]) {
        const { items, raw } = await largest(person);
        expect(items.length).toBeGreaterThan(0);
        expect(raw).not.toContain("/api/v1/media/");
        for (const item of items) {
          expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "kind", "mime", "sizeBytes"]);
        }
      }
    });

    it("an admin who lists a colleague's file cannot open it", async () => {
      const adamsList = (await largest(adam)).items.map((item) => item.id);
      expect(adamsList).toContain(aliceOwnImage);
      expect(await readMedia(adam, aliceOwnImage)).toMatchObject({ status: 404 });
    });
  });

  describe("job-mode pictures and Edit's output", () => {
    const part = (mediaId: string) => ({
      type: "image_url" as const,
      image_url: { url: `/api/v1/media/${mediaId}/file` },
    });

    it("a job mode's inlined picture is the caller's own or a shared one; a colleague's private picture is left as a reference", async () => {
      const { inlineLocalMediaParts } = await import("./inline-local-media");
      const parts = [part(aliceOwnImage), part(annOwnImage), part(aliceSharedImage), part(aliceOwnVideo)];

      const forAnn = await inlineLocalMediaParts(ann.tenant, parts);
      const urls = forAnn.map((item) => (item.type === "image_url" ? item.image_url.url : ""));
      expect(urls[0]).toBe(`/api/v1/media/${aliceOwnImage}/file`);
      expect(urls[1]).toMatch(/^data:image\/png;base64,/);
      expect(urls[2]).toMatch(/^data:image\/png;base64,/);
      expect(urls[3]).toBe(`/api/v1/media/${aliceOwnVideo}/file`);

      const forBob = await inlineLocalMediaParts(bob.tenant, [part(aliceSharedImage), part(annOwnImage)]);
      expect(forBob.map((item) => (item.type === "image_url" ? item.image_url.url : ""))).toEqual([
        `/api/v1/media/${aliceSharedImage}/file`,
        `/api/v1/media/${annOwnImage}/file`,
      ]);
    });

    it("Edit's output lookup finds a row for its maker and for a shared Workspace, and for no one else", async () => {
      const { loadMediaRow } = await import("./edit/wire-generate");
      expect(await loadMediaRow(aliceOwnImage, alice.tenant)).not.toBeNull();
      expect(await loadMediaRow(aliceOwnImage, ann.tenant)).toBeNull();
      expect(await loadMediaRow(aliceOwnImage, adam.tenant)).toBeNull();
      expect(await loadMediaRow(aliceSharedImage, ann.tenant)).not.toBeNull();
      expect(await loadMediaRow(aliceOwnImage, bob.tenant)).toBeNull();
    });

    it("a job with no recorded requester reads as nobody: a shared row only, never a colleague's private one", async () => {
      const { loadMediaRow } = await import("./edit/wire-generate");
      const nobody = { ...alice.tenant, userId: "" };
      expect(await loadMediaRow(aliceOwnImage, nobody)).toBeNull();
      expect(await loadMediaRow(aliceSharedImage, nobody)).not.toBeNull();
    });
  });

  describe("Edit's still", () => {
    const stillVideo = (mediaId: string) => ({
      kind: "generate_video" as const,
      prompt: "the still, slowly moving",
      imageUrl: `/api/v1/media/${mediaId}/file`,
      // Accepts a still, so the only thing that can refuse the request is the still itself.
      model: "grok-imagine-video",
    });

    it("a colleague's private still is refused exactly like a missing one, and a shared still is accepted", async () => {
      const { createEditProject } = await import("./edit/projects");
      const { startGenerateJob } = await import("./edit/start-generate");
      const { getEditJob, setEditJobRunnerForTests, resetEditJobsForTests } = await import("./edit/jobs");
      // No gateway here: a queued job finishes as soon as it starts.
      const settle = async (jobId: string, projectId: string): Promise<string> => {
        const start = Date.now();
        while (Date.now() - start < 5_000) {
          const job = await getEditJob(jobId, projectId);
          if (job.status !== "queued" && job.status !== "running") {
            return job.status;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`job ${jobId} did not settle`);
      };
      setEditJobRunnerForTests(async () => ({ outputAssetIds: [] }));
      try {
        const project = await createEditProject(ann.tenant, { name: "still reads", aspect: "16:9", fps: 30 });
        const refusal = (pending: Promise<unknown>) =>
          pending.then(
            () => null,
            (error: unknown) => error as { code?: string; status?: number; message?: string },
          );

        const hidden = await refusal(startGenerateJob(ann.tenant, project.id, stillVideo(aliceOwnImage)));
        const missing = await refusal(startGenerateJob(ann.tenant, project.id, stillVideo(crypto.randomUUID())));
        expect(hidden).toMatchObject({ code: "still_not_found", status: 400 });
        expect(missing).toMatchObject({ code: "still_not_found", status: 400 });
        expect(hidden?.message).toBe(missing?.message);

        // The still of a shared Workspace is the company's, so the same call is accepted, and its job runs to the end
        // here, so no background write outlives the database this file closes.
        const accepted = await startGenerateJob(ann.tenant, project.id, stillVideo(aliceSharedImage));
        const jobId = (accepted.job as { id: string }).id;
        expect(await settle(jobId, project.id)).toBe("succeeded");
      } finally {
        resetEditJobsForTests();
      }
    });
  });
});
