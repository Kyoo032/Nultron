/**
 * The model an Edit generate call runs when nobody named one.
 *
 * Rizky, 2026-11-11: a key that cannot run `grok-imagine-video` must not be defaulted onto it. The two
 * Edit paths that used to hard-code it are the stub agent's priced generate turn
 * (`agent-run.ts`, the `GENERATION` block of `runStub`) and the "place a made shot" skill
 * (`harness-run.ts`, `placeMadeShot`). Each has a case here beside the resolver's own.
 *
 * `estimateEditJobUsd` is the seam the stub turn's model is visible through: it is the only thing the
 * stub path does with the id (the tool resolves its own default from the same list). For the harness
 * the id also rides the tool args, so the tool-IO sink shows it there too.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATEWAY_IMAGE_MODEL,
  DEFAULT_GATEWAY_VIDEO_MODEL,
  runWithToolIoSink,
  takeLastToolIo,
  type TenantContext,
} from "@agentforge/core";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-model-route-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

/** Every model the Edit paths asked the price table about, in order. */
const priced: string[] = [];

vi.mock("./budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./budget")>();
  return {
    ...actual,
    estimateEditJobUsd: (model: string, opts?: Parameters<typeof actual.estimateEditJobUsd>[1]) => {
      priced.push(model);
      return actual.estimateEditJobUsd(model, opts);
    },
  };
});

let tenant: TenantContext;

/** What the key's last refresh listed, as the cache the host reads. */
async function keyLists(videoIds: string[], imageIds: string[] = []): Promise<void> {
  const { saveModelCache } = await import("../model-cache");
  const { resetCatalogMemo } = await import("../selectable-models");
  saveModelCache({
    openai: [...imageIds, ...videoIds].map((id) => ({
      id,
      label: id,
      provider: "openai" as const,
      inputModalities: ["text"],
    })),
  });
  resetCatalogMemo();
}

async function framesOf(events: AsyncIterable<string>): Promise<string> {
  const frames: string[] = [];
  for await (const frame of events) {
    frames.push(frame);
  }
  return frames.join("\n");
}

/** Let the queued generate job finish before the suite closes the database. */
async function settleJobs(projectId: string): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db, editJobs } = await import("@agentforge/db");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await db.select().from(editJobs).where(eq(editJobs.projectId, projectId));
    if (!rows.some((row) => row.status === "queued" || row.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

beforeAll(async () => {
  const { db, ensureLocalOwner } = await import("@agentforge/db");
  tenant = await ensureLocalOwner(db);
}, 60_000);

beforeEach(() => {
  priced.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the default model for an Edit generate call", () => {
  it("is the first video id this key lists, in the app's preference order", async () => {
    const { defaultEditGenerateModel } = await import("./model-route");
    // Grok is listed here, so this is not a ban: the proven, cheaper Seedance id leads the preference list.
    await keyLists(["grok-imagine-video", "seedance-2.0-fast"]);
    expect(defaultEditGenerateModel(tenant, "video")).toBe("seedance-2.0-fast");
  });

  it("keeps a key's only video id, even when that id is Grok", async () => {
    const { defaultEditGenerateModel } = await import("./model-route");
    await keyLists(["grok-imagine-video"]);
    expect(defaultEditGenerateModel(tenant, "video")).toBe("grok-imagine-video");
  });

  it("falls back to the gateway default only when the key lists no video id", async () => {
    const { defaultEditGenerateModel } = await import("./model-route");
    await keyLists([]);
    expect(defaultEditGenerateModel(tenant, "video")).toBe(DEFAULT_GATEWAY_VIDEO_MODEL);
  });

  it("reads the image side the same way", async () => {
    const { defaultEditGenerateModel } = await import("./model-route");
    await keyLists([], ["seedream-5.0-pro"]);
    expect(defaultEditGenerateModel(tenant, "image")).toBe("seedream-5.0-pro");
    await keyLists([]);
    expect(defaultEditGenerateModel(tenant, "image")).toBe(DEFAULT_GATEWAY_IMAGE_MODEL);
  });
});

describe("the stub Edit agent's generate turn", () => {
  it("is priced at the model this key can run, not Grok", async () => {
    await keyLists(["seedance-2.0-fast"]);
    const { createEditProject } = await import("./projects");
    const { runEditAgent } = await import("./agent-run");
    const doc = await createEditProject(tenant, { name: "Priced turn", aspect: "16:9", fps: 30 });

    const body = await framesOf(
      await runEditAgent({ tenant, projectId: doc.id, text: "generate video (16:9, standard): waves on a dock" }),
    );

    expect(body).toContain("Generate video");
    expect(priced).toEqual(["seedance-2.0-fast"]);
    await settleJobs(doc.id);
  }, 60_000);
});

describe("the place-a-made-shot skill", () => {
  it(
    "makes the clip with the model this key can run, not Grok",
    async () => {
      await keyLists(["grok-imagine-video", "seedance-2.0-fast"]);
      const { createEditProject } = await import("./projects");
      const { runEditAgent } = await import("./agent-run");
      const doc = await createEditProject(tenant, { name: "Made clip", aspect: "16:9", fps: 30 });

      const seen = await runWithToolIoSink(async () => {
        const body = await framesOf(
          await runEditAgent({ tenant, projectId: doc.id, text: "Make a clip of the waves" }),
        );
        return { body, call: takeLastToolIo("generate_video") };
      });

      // The tool is handed the resolved id (the id also decides the price charged before the call).
      expect(seen.call?.input).toMatchObject({ model: "seedance-2.0-fast" });
      expect(priced).toEqual(["seedance-2.0-fast"]);
      expect(seen.body).toContain("Placed a made shot on the timeline.");
      await settleJobs(doc.id);
    },
    EDIT_AGENT_IMPORT_BUDGET_MS,
  );
});
