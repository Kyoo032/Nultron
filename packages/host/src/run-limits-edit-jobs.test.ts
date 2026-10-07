/**
 * SR-138 for the Edit jobs that outlive their request: `POST /edit/projects/:id/generate` and an `asr`
 * job on `POST /edit/projects/:id/jobs` answer as soon as the job is queued, and the model call happens
 * later in the background. The slot is taken at the request and held until the JOB is over, however it
 * ends; a request that fails before it queues anything gives it straight back.
 *
 * Real router, real project, throwaway data dir. The job runner is the stand-in: it holds each job open
 * until the test lets it go (`setEditJobRunnerForTests`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-run-limits-edit-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
delete process.env.AGENTFORGE_RUNTIME;
process.env.AGENTFORGE_SECRETS_KEY = "9b3d5f7a1c2e4068b0d2f4a6c8e0a1c3d5f7092b4d6f8a0c2e4a6c8e0b1d3f5a";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
delete process.env.AGENTFORGE_MAX_RUNS_TOTAL;

import type { TenantContext } from "@agentforge/core";
import { SESSION_COOKIE_SECURE, createSession } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const IDENTITY = { tenantId: "edit-jobs-tenant", orgId: "edit-jobs-org", userId: "edit-jobs-user" } as const;

type Held = { readonly finish: () => void; readonly fail: () => void };
const held: Held[] = [];

let dispatch: typeof import("./router").dispatch;
let activeRuns: typeof import("./run-limits").activeRuns;
let setRunner: typeof import("./edit/jobs").setEditJobRunnerForTests;
let tenant: TenantContext;
let projectId = "";
let sessionStore: ReturnType<typeof createMemorySessionStore>;
let session: ReturnType<typeof createSession>;

function post(path: string, body: unknown): Promise<HostResult> {
  const request: HostRequest = {
    method: "POST",
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${session.id}` },
    body,
  };
  return dispatch(request, { serverMode: true, sessionStore, now: () => T0 });
}

function outcome(result: HostResult): { status: number; code: string } {
  const body = (result as HostJsonResult).body as { error?: { code?: string } } | null;
  return { status: result.status, code: body?.error?.code ?? "" };
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  ({ activeRuns } = await import("./run-limits"));
  ({ setEditJobRunnerForTests: setRunner } = await import("./edit/jobs"));
  const { db, ensurePortalOwner, resolvePortalTenant } = await import("@agentforge/db");
  sessionStore = createMemorySessionStore();
  vi.stubGlobal("fetch", async (url: unknown) => {
    const text = String(url);
    if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  process.env.AGENTFORGE_SERVER = "1";
  await ensurePortalOwner(db, { ...IDENTITY, role: "owner" });
  const resolved = await resolvePortalTenant(db, IDENTITY);
  if (!resolved.ok) {
    throw new Error(`tenant did not resolve: ${resolved.code}`);
  }
  tenant = resolved.tenant;
  session = createSession({ ...IDENTITY, now: T0 });
  await sessionStore.create(session);
  const saved = await post("/api/v1/settings", { openaiApiKey: "sk-edit-jobs-test-aaaaaaaaaaaaaaaa" });
  expect((saved as HostJsonResult).body, "the gate did not open").toMatchObject({ gateway: { allowed: true } });
  const { createEditProject } = await import("./edit/projects");
  projectId = (await createEditProject(tenant, { name: "slots", aspect: "16:9", fps: 30 })).id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  held.length = 0;
  process.env.AGENTFORGE_SERVER = "1";
  process.env.AGENTFORGE_MAX_RUNS_PER_TENANT = "1";
  // Every job waits here until the test says how it ends.
  setRunner(
    (_job, _signal, _onProgress) =>
      new Promise((resolve, reject) => {
        held.push({ finish: () => resolve({ outputAssetIds: [] }), fail: () => reject(new Error("model failed")) });
      }),
  );
});

afterEach(async () => {
  // A job reaches the runner a moment after its request answered, so keep letting go of whatever has
  // arrived until nothing holds a slot; a slot that never frees is a leak and times this out.
  await vi.waitFor(
    () => {
      for (const job of held.splice(0)) {
        job.finish();
      }
      expect(activeRuns(), "a slot outlived its job").toBe(0);
    },
    { timeout: 20_000 },
  );
  setRunner(null);
  delete process.env.AGENTFORGE_MAX_RUNS_PER_TENANT;
}, 30_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AGENTFORGE_SERVER;
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("an asr job on POST /edit/projects/:id/jobs", () => {
  const jobsPath = () => `/api/v1/edit/projects/${projectId}/jobs`;

  it("holds the slot until the job is over, so a second one is refused meanwhile", async () => {
    expect((await post(jobsPath(), { kind: "asr" })).status).toBe(201);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(activeRuns(tenant), "the request is over but its job is not").toBe(1);

    expect(outcome(await post(jobsPath(), { kind: "asr" }))).toEqual({ status: 429, code: "too_many_runs" });

    held[0]?.finish();
    await vi.waitFor(() => expect(activeRuns(tenant)).toBe(0));
    expect((await post(jobsPath(), { kind: "asr" })).status).toBe(201);
  });

  it("gives the slot back when the job fails", async () => {
    expect((await post(jobsPath(), { kind: "asr" })).status).toBe(201);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held[0]?.fail();
    await vi.waitFor(() => expect(activeRuns(tenant)).toBe(0));
  });

  it("takes no slot for a kind that never reaches the gateway", async () => {
    // `ffmpeg_op` is a local transform: not gated, not counted.
    const result = await post(jobsPath(), { kind: "ffmpeg_op", request: { recipe: "noop" } });
    expect(outcome(result).code).not.toBe("too_many_runs");
    await vi.waitFor(() => expect(activeRuns(tenant)).toBe(0));
  });
});

describe("a generation on POST /edit/projects/:id/generate", () => {
  const generatePath = () => `/api/v1/edit/projects/${projectId}/generate`;

  it("holds the slot for the life of the queued job and refuses a second request meanwhile", async () => {
    const first = await post(generatePath(), { kind: "image", prompt: "a lighthouse at dusk" });
    expect(first.status, JSON.stringify((first as HostJsonResult).body)).toBe(201);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(activeRuns(tenant)).toBe(1);

    expect(outcome(await post(generatePath(), { kind: "image", prompt: "another" }))).toEqual({
      status: 429,
      code: "too_many_runs",
    });

    held[0]?.finish();
    await vi.waitFor(() => expect(activeRuns(tenant)).toBe(0));
  });

  it("gives the slot straight back for a request refused before anything was queued", async () => {
    // No prompt: a 400 before `startGenerateJob`, so no job exists to hold the slot.
    const refused = await post(generatePath(), { kind: "image", prompt: "   " });
    expect(refused.status).toBe(400);
    expect(activeRuns(tenant)).toBe(0);
    expect(held).toHaveLength(0);
  });
});
