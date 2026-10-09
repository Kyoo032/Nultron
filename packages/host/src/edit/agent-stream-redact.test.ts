import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

/**
 * The Edit agent's stream is read by the screen, so what leaves it is the redacted copy of a tool's input
 * and output, the way Chat's stream is (`redactToolEvent`). The runtime is the one stand-in: it emits the
 * events a model turn would, and the frames the screen would read are what is checked.
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-stream-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "ai";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

const KEY = "sk-live-0123456789abcdefABCDEF";

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
let script: (input: ExecuteInput) => Promise<void> = async () => undefined;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        await script(input);
      },
    }),
  };
});

let agent: typeof import("./agent-run");

beforeAll(async () => {
  agent = await import("./agent-run");
}, EDIT_AGENT_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Frame = { event: string; data: Record<string, unknown> };

/** Runs one Edit agent turn and returns every frame the screen would read, parsed. */
async function turn(text: string): Promise<{ frames: Frame[]; raw: string }> {
  const { createEditProject } = await import("./projects");
  const { getTenant } = await import("../tenant");
  const tenant = await getTenant();
  const doc = await createEditProject(tenant, { name: "Stream", aspect: "16:9", fps: 30 });
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

describe("what the Edit agent's stream carries", () => {
  it("redacts a tool's input and output, and a failure's own words, before they leave the stream", async () => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "add_title", input: { text: `key ${KEY}` } });
      await run.onEvent({
        type: "tool.completed",
        toolKey: "add_title",
        output: {
          success: true,
          card: { id: "card-1", verb: "Add", object: `title ${KEY}` },
          note: `my key is ${KEY}`,
        },
      });
      await run.onEvent({ type: "run.interrupted", message: `upstream refused ${KEY}` });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };

    const { frames, raw } = await turn("Add a title");

    expect(raw).not.toContain(KEY);
    expect(raw).toContain("[REDACTED]");
    expect(frames.find((frame) => frame.event === "tool.started")?.data.input).toEqual({ text: "key [REDACTED]" });
    expect(frames.find((frame) => frame.event === "tool.completed")?.data.output).toMatchObject({
      note: "my key is [REDACTED]",
    });
    expect(frames.find((frame) => frame.event === "edit.card")?.data.card).toMatchObject({
      object: "title [REDACTED]",
    });
    expect(frames.find((frame) => frame.event === "run.interrupted")?.data.message).toBe("upstream refused [REDACTED]");
  });
});
