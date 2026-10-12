import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

/**
 * Every tool result the Edit agent streams reaches the screen as the screened copy: the scripted path, run_recipe,
 * clear_timeline, a failed tool call's own words, and the harness (its tool calls and its made-shot plan card). The
 * tool is the one stand-in; the frames the screen would read are what is checked. The model and the harness still
 * read the raw result, which these tests do not look at.
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-tool-screen-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

const SECRET = "sk-test-123456789";
const MEDIA_URL = "/api/v1/media/clip-7/file";
const SIGNED_URL =
  "https://media.example.test/clip-7.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261011%2Fauto%2Fs3%2Faws4_request&X-Amz-Expires=900&X-Amz-Signature=9f2c4e6a8b0d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a&X-Amz-SignedHeaders=host";

/** What the stubbed tool returns: a key it echoed, plus an ops entry, a card and a job that carry media links. */
function toolOutput(): Record<string, unknown> {
  return {
    success: true,
    apiKey: SECRET,
    note: `the provider echoed ${SECRET}`,
    ops: [{ type: "add_asset", payload: { asset: { id: "asset-7", kind: "video", src: MEDIA_URL, url: SIGNED_URL } } }],
    card: { id: "card-7", verb: "Remove silence", object: "clip-7", thumb: MEDIA_URL, note: `key ${SECRET}` },
    job: { id: "job-7", kind: "render", status: "queued", outputUrl: SIGNED_URL },
  };
}

let behaviour: "output" | "throw" = "output";
let refuseSpend = false;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    invokeToolGuarded: async () => {
      if (behaviour === "throw") {
        throw new actual.ApiError("provider_error", `upstream echoed ${SECRET}`, 502);
      }
      return toolOutput();
    },
  };
});

vi.mock("./budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./budget")>();
  return {
    ...actual,
    chargeTurnBudget: (...args: Parameters<typeof actual.chargeTurnBudget>) => {
      if (!refuseSpend) {
        return actual.chargeTurnBudget(...args);
      }
      const refusal = {
        success: false as const,
        refused: "turn_cap_exceeded" as const,
        message: "This turn would exceed the spend cap",
      };
      return { ok: false as const, refusal };
    },
  };
});

let agent: typeof import("./agent-run");

beforeAll(async () => {
  agent = await import("./agent-run");
}, EDIT_AGENT_IMPORT_BUDGET_MS);

beforeEach(() => {
  behaviour = "output";
  refuseSpend = false;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Frame = { event: string; data: Record<string, unknown> };

/** Runs one Edit agent turn and returns every frame the screen would read, parsed, and the raw text. */
async function turn(text: string): Promise<{ frames: Frame[]; raw: string }> {
  const { createEditProject } = await import("./projects");
  const { getTenant } = await import("../tenant");
  const tenant = await getTenant();
  const doc = await createEditProject(tenant, { name: "Screen", aspect: "16:9", fps: 30 });
  let raw = "";
  for await (const frame of await agent.runEditAgent({ tenant, projectId: doc.id, text })) {
    raw += frame;
  }
  const frames = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
      const data = JSON.parse((lines.find((line) => line.startsWith("data:")) ?? "data: {}").slice(5)) as Record<
        string,
        unknown
      >;
      return { event, data };
    });
  return { frames, raw };
}

function frameData(frames: Frame[], event: string): Record<string, unknown> {
  const found = frames.find((item) => item.event === event);
  if (!found) {
    throw new Error(`no ${event} frame in the stream`);
  }
  return found.data;
}

describe("the Edit agent's tool events leave the stream screened", () => {
  it("a scripted edit streams the tool's result screened, with its ops, card and job intact", async () => {
    const { frames, raw } = await turn("Remove the silences");

    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(SIGNED_URL);
    expect(frameData(frames, "tool.completed").output).toMatchObject({
      success: true,
      apiKey: "[REDACTED]",
      note: "the provider echoed [REDACTED]",
    });
    const ops = frameData(frames, "edit.ops").ops as Array<{ payload: { asset: Record<string, unknown> } }>;
    expect(ops[0]?.payload.asset).toMatchObject({ id: "asset-7", src: MEDIA_URL, url: SIGNED_URL });
    expect(frameData(frames, "edit.card").card).toMatchObject({
      id: "card-7",
      thumb: MEDIA_URL,
      note: "key [REDACTED]",
    });
    expect(frameData(frames, "edit.job").job).toMatchObject({ id: "job-7", outputUrl: SIGNED_URL });
  });

  it("run_recipe streams its result screened, and the plan card it shows is read from that copy", async () => {
    const { frames, raw } = await turn("Run recipe podcast-clean-up");

    expect(raw).not.toContain(SECRET);
    expect(frameData(frames, "tool.completed").output).toMatchObject({ apiKey: "[REDACTED]" });
    expect(frameData(frames, "edit.plan").card).toMatchObject({
      id: "card-7",
      thumb: MEDIA_URL,
      note: "key [REDACTED]",
    });
  });

  it("clear_timeline streams its result screened", async () => {
    const { frames, raw } = await turn("Delete everything");

    expect(raw).not.toContain(SECRET);
    expect(frameData(frames, "tool.completed").output).toMatchObject({
      apiKey: "[REDACTED]",
      note: "the provider echoed [REDACTED]",
    });
  });

  it("a failed tool call's own words are screened before they leave the stream", async () => {
    behaviour = "throw";
    const { frames, raw } = await turn("Remove the silences");

    expect(raw).not.toContain(SECRET);
    expect(frameData(frames, "run.failed").message).toBe("upstream echoed [REDACTED]");
  });

  it("a harness tool call streams screened, and its ops, card and job frames are read from that copy", async () => {
    const { frames, raw } = await turn("Put words on the picture: Hello");

    expect(raw).not.toContain(SECRET);
    expect(raw).toContain(SIGNED_URL);
    expect(frameData(frames, "tool.completed").output).toMatchObject({ apiKey: "[REDACTED]" });
    const ops = frameData(frames, "edit.ops").ops as Array<{ payload: { asset: Record<string, unknown> } }>;
    expect(ops[0]?.payload.asset).toMatchObject({ url: SIGNED_URL, src: MEDIA_URL });
    expect(frameData(frames, "edit.card").card).toMatchObject({ id: "card-7", note: "key [REDACTED]" });
    expect(frameData(frames, "edit.job").job).toMatchObject({ id: "job-7", outputUrl: SIGNED_URL });
  });

  it("the harness's made-shot plan card, when the turn cap refuses, is read from the screened copy", async () => {
    refuseSpend = true;
    const { frames, raw } = await turn("Make a still of a harbour");

    expect(raw).not.toContain(SECRET);
    expect(frameData(frames, "edit.plan").card).toMatchObject({
      id: "card-7",
      thumb: MEDIA_URL,
      note: "key [REDACTED]",
    });
  });

  it("a scripted generation the turn cap refuses streams the refusal and a plan card", async () => {
    refuseSpend = true;
    const { frames } = await turn("Generate image of a harbour");

    expect(frameData(frames, "tool.completed")).toMatchObject({
      toolKey: "generate_image",
      output: { refused: "turn_cap_exceeded" },
    });
    expect(frameData(frames, "edit.plan").card).toBeTruthy();
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(false);
    expect(frames.at(-1)?.event).toBe("run.completed");
  });
});
