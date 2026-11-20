/**
 * Meeting mode — a model the person picked is never swapped by the job model fallback.
 *
 * Unlike `run.test.ts`, which stubs the model call whole, this runs the real `collectJobAssistantRun`
 * and the real fallback (`job-model-fallback.ts`) over a fake gateway, because the thing under test
 * is exactly what happens between the two: does a gateway outage on the picked model end the run, or
 * does a stand-in quietly answer in its place?
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import type { MeetingMinutes, MeetingTranscript } from "@agentforge/core/meeting";

// Isolation: this file's own desk, set BEFORE the run (and through it the database) is imported.
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-meeting-pin-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_MODELS_CACHE_PATH = join(dataDir, "models-cache.json");
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

/**
 * What a gateway probe leaves on the desk: the Meeting list and the shared fallback tail, as live models.
 * The built-in catalogue (`core/src/models/catalog.ts`) a desk falls back to with no probe holds none of
 * the models those lists now name (2026-11-10), so on it a seeded default that goes down has no stand-in.
 */
const PROBED_CHAT_IDS = ["gpt-6-luna", "gpt-6-sol", "claude-sonnet-5-5", "deepseek-v4-1-flash"];

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const gateway = vi.hoisted(() => ({
  /** Every call the fake gateway received: the model and which of the run's calls it was. */
  calls: [] as Array<{ model: string; versionId: string }>,
  /** `model` or `model:versionId` entries the gateway cannot reach, with the live gateway's own sentence. */
  down: new Set<string>(),
}));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input: ExecuteInput) {
        const model = input.version.model;
        const versionId = input.version.id;
        gateway.calls.push({ model, versionId });
        if (gateway.down.has(model) || gateway.down.has(`${model}:${versionId}`)) {
          await input.onEvent({
            type: "run.failed",
            message: `Could not reach ${model} after 3 tries. The gateway is unavailable right now (status_code=503)`,
          } as Parameters<typeof input.onEvent>[0]);
          return;
        }
        const title = versionId === "meeting-translate" ? "Rapat mingguan checkout" : "Checkout weekly";
        await input.onEvent({ type: "assistant.delta", text: JSON.stringify(minutes(title)) });
      },
    }),
  };
});
vi.mock("../usage-record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage-record")>()),
  recordTranscriptionUsage: vi.fn(),
}));
vi.mock("../knowledge-ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../knowledge-ingest")>()),
  upsertWorkSource: async () => ({ status: "skipped", reason: "test" }),
}));

type RunModule = typeof import("./run");
type StoreModule = typeof import("./store");
let run: RunModule;
let store: StoreModule;
let catalog: string[];

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-meeting-pin",
  workspaceId: "ws-meeting-pin",
  userId: "local",
  role: "owner",
};

const TRANSCRIPT: MeetingTranscript = {
  text: "Dewi: we ship the checkout fix on Friday.",
  segments: [],
  language: "en",
  source: "pasted",
  model: "",
};

function minutes(title: string): MeetingMinutes {
  return {
    title,
    heldOn: "",
    summary: "The team agreed to ship the checkout fix on Friday.",
    attendees: [],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
  };
}

function transcribedMeeting(): string {
  const created = store.meetingStore().create(tenant, { title: "Checkout weekly", locale: "en" });
  store.meetingStore().update(tenant, created.id, { status: "transcribed", transcript: TRANSCRIPT });
  return created.id;
}

/** The models the fake gateway was asked to run for one of the run's calls, in order. */
function modelsFor(versionId: string): string[] {
  return gateway.calls.filter((call) => call.versionId === versionId).map((call) => call.model);
}

beforeAll(async () => {
  store = await import("./store");
  run = await import("./run");
  const { saveModelCache } = await import("../model-cache");
  const { listSelectableModels, resetCatalogMemo } = await import("../selectable-models");
  saveModelCache({
    openai: PROBED_CHAT_IDS.map((id) => ({ id, label: id, provider: "openai" as const, inputModalities: ["text" as const] })),
  });
  resetCatalogMemo();
  catalog = listSelectableModels(tenant).map((model) => model.id);
}, 60_000);

beforeEach(async () => {
  vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  const { resetJobModelCircuit } = await import("../job-model-fallback");
  resetJobModelCircuit();
});

afterEach(() => {
  vi.unstubAllEnvs();
  gateway.calls.length = 0;
  gateway.down.clear();
});

afterAll(async () => {
  // The kernel SQLite lives in dataDir; close it so Windows releases the file before cleanup.
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a model the person picked in Meeting", () => {
  it("has a catalogue with a picked model and somewhere to fall back to (the test's own premise)", () => {
    expect(catalog.length).toBeGreaterThan(1);
  });

  it("is not swapped when the gateway cannot reach it: the outage is the answer", async () => {
    const picked = catalog[0] as string;
    gateway.down.add(picked);
    const id = transcribedMeeting();

    await expect(
      run.generateMinutes(tenant, id, { model: picked, modelExplicit: true, translate: false }),
    ).rejects.toMatchObject({ code: "generation_failed" });

    expect(modelsFor("meeting-minutes")).toEqual([picked]);
    expect(store.meetingStore().get(tenant, id)?.status).toBe("transcribed");
  });

  it("is not swapped on the translation call either", async () => {
    const picked = catalog[0] as string;
    gateway.down.add(`${picked}:meeting-translate`);
    const id = transcribedMeeting();

    await expect(run.generateMinutes(tenant, id, { model: picked, modelExplicit: true })).rejects.toMatchObject({
      code: "generation_failed",
    });

    expect(modelsFor("meeting-minutes")).toEqual([picked]);
    expect(modelsFor("meeting-translate")).toEqual([picked]);
  });

  it("is pinned on the one-button run (transcript in hand) as well", async () => {
    const picked = catalog[0] as string;
    gateway.down.add(picked);
    const id = transcribedMeeting();

    await expect(run.runMeeting(tenant, id, { model: picked, modelExplicit: true })).rejects.toMatchObject({
      code: "generation_failed",
    });

    expect(modelsFor("meeting-minutes")).toEqual([picked]);
  });

  it("still answers on the picked model when the gateway can reach it", async () => {
    const picked = catalog[0] as string;
    const id = transcribedMeeting();

    const record = await run.generateMinutes(tenant, id, { model: picked, modelExplicit: true });

    expect(record.minutes?.model).toBe(picked);
    expect(record.translation?.model).toBe(picked);
    expect(modelsFor("meeting-minutes")).toEqual([picked]);
    expect(modelsFor("meeting-translate")).toEqual([picked]);
  });
});

describe("a model nobody picked (the studio's seeded default)", () => {
  it("is rescued onto a stand-in when the gateway cannot reach it", async () => {
    const seeded = catalog[0] as string;
    gateway.down.add(seeded);
    const id = transcribedMeeting();

    const record = await run.generateMinutes(tenant, id, { model: seeded, translate: false });

    const asked = modelsFor("meeting-minutes");
    expect(asked[0]).toBe(seeded);
    expect(asked).toHaveLength(2);
    expect(record.minutes?.model).toBe(asked[1]);
    expect(record.minutes?.model).not.toBe(seeded);
  });
});
