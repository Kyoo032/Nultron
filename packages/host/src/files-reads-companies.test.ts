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

type GalleryItem = { id: string; url: string };

async function galleryIds(person: Person, path: string): Promise<string[]> {
  const items = jsonBody<{ items: GalleryItem[] }>(await call(person, "GET", path)).items;
  for (const item of items) {
    expect((await readMedia(person, item.id)).status, `${path} lists ${item.id} but its file is refused`).toBe(200);
  }
  return items.map((item) => item.id);
}

describe("generated media reads on the hosted app: two companies and an admin", () => {
  let aliceImage: string;
  let annImage: string;
  let aliceVideo: string;
  let annVideo: string;
  let aliceAudio: string;

  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice", "owner");
    ann = await provision("org-a", "ann", "member");
    adam = await provision("org-a", "adam", "admin");
    bob = await provision("org-b", "bob", "owner");

    aliceImage = await makeImage(alice, "alice");
    annImage = await makeImage(ann, "ann");
    aliceVideo = await makeVideo(alice, "alice");
    annVideo = await makeVideo(ann, "ann");
    aliceAudio = await makeAudio(alice, "alice");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("studio galleries", () => {
    it("the Images gallery lists the company's images, and never to another company", async () => {
      for (const person of [alice, ann, adam]) {
        expect(await galleryIds(person, "/api/v1/images")).toEqual(expect.arrayContaining([aliceImage, annImage]));
      }
      const bobs = await galleryIds(bob, "/api/v1/images");
      expect(bobs).not.toContain(aliceImage);
      expect(bobs).not.toContain(annImage);
    });

    it("the Videos gallery follows the same rule", async () => {
      expect(await galleryIds(ann, "/api/v1/videos")).toEqual(expect.arrayContaining([aliceVideo, annVideo]));
      const bobs = await galleryIds(bob, "/api/v1/videos");
      expect(bobs).not.toContain(aliceVideo);
      expect(bobs).not.toContain(annVideo);
    });

    it("the Music gallery follows the same rule", async () => {
      expect(await galleryIds(alice, "/api/v1/music")).toContain(aliceAudio);
      expect(await galleryIds(bob, "/api/v1/music")).not.toContain(aliceAudio);
    });

    it("another company's file answers as a missing one", async () => {
      expect(await readMedia(bob, aliceImage)).toMatchObject({ status: 404 });
      expect(await readMedia(bob, crypto.randomUUID())).toMatchObject({ status: 404 });
      expect(await readMedia(alice, aliceImage)).toMatchObject({ status: 200 });
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
        expect(ids).toEqual(expect.arrayContaining([aliceImage, annImage, annVideo]));
      }
    });

    it("another company's storage list holds none of this company's media", async () => {
      const bobs = (await largest(bob)).items.map((item) => item.id);
      for (const id of [aliceImage, annImage, aliceVideo, annVideo, aliceAudio]) {
        expect(bobs).not.toContain(id);
      }
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
  });

  describe("job-mode pictures", () => {
    const part = (mediaId: string) => ({
      type: "image_url" as const,
      image_url: { url: `/api/v1/media/${mediaId}/file` },
    });

    it("a job mode inlines its own company's picture and leaves another company's as a reference", async () => {
      const { inlineLocalMediaParts } = await import("./inline-local-media");
      const urlsOf = (items: Awaited<ReturnType<typeof inlineLocalMediaParts>>) =>
        items.map((item) => (item.type === "image_url" ? item.image_url.url : ""));

      const forAnn = urlsOf(await inlineLocalMediaParts(ann.tenant, [part(aliceImage)]));
      expect(forAnn[0]).toMatch(/^data:image\/png;base64,/);

      const forBob = urlsOf(await inlineLocalMediaParts(bob.tenant, [part(aliceImage), part(annImage)]));
      expect(forBob).toEqual([`/api/v1/media/${aliceImage}/file`, `/api/v1/media/${annImage}/file`]);
    });
  });

  describe("Edit's still", () => {
    const stillVideo = (mediaId: string) => ({
      kind: "generate_video" as const,
      prompt: "the still, slowly moving",
      imageUrl: `/api/v1/media/${mediaId}/file`,
      model: "grok-imagine-video",
    });

    it("another company's still is refused exactly like a missing one, and the company's own is accepted", async () => {
      const { createEditProject } = await import("./edit/projects");
      const { startGenerateJob } = await import("./edit/start-generate");
      const { getEditJob, setEditJobRunnerForTests, resetEditJobsForTests } = await import("./edit/jobs");
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
        const refusal = (pending: Promise<unknown>) =>
          pending.then(
            () => null,
            (error: unknown) => error as { code?: string; status?: number; message?: string },
          );

        const bobsProject = await createEditProject(bob.tenant, { name: "still reads", aspect: "16:9", fps: 30 });
        const hidden = await refusal(startGenerateJob(bob.tenant, bobsProject.id, stillVideo(aliceImage)));
        const missing = await refusal(startGenerateJob(bob.tenant, bobsProject.id, stillVideo(crypto.randomUUID())));
        expect(hidden).toMatchObject({ code: "still_not_found", status: 400 });
        expect(missing).toMatchObject({ code: "still_not_found", status: 400 });
        expect(hidden?.message).toBe(missing?.message);

        const annsProject = await createEditProject(ann.tenant, { name: "still reads", aspect: "16:9", fps: 30 });
        const accepted = await startGenerateJob(ann.tenant, annsProject.id, stillVideo(aliceImage));
        const jobId = (accepted.job as { id: string }).id;
        expect(await settle(jobId, annsProject.id)).toBe("succeeded");
      } finally {
        resetEditJobsForTests();
      }
    });
  });
});
