import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@agentforge/core";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

/**
 * A cancelled Edit turn stops the model call, and is not reported as an Edit failure.
 *
 * `runEditAgent` took the request's `abortSignal` and never read it, so a client that left left the
 * gateway request running to the end. The runtime is the one stand-in: in `hang` mode its call stays
 * open until the signal it was handed fires, as a slow gateway's would; in `fail` mode it breaks.
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-agent-cancel-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "ai";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
const observedAborted: boolean[] = [];
let mode: "hang" | "fail" = "hang";

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        if (mode === "fail") {
          throw new Error("the gateway broke");
        }
        await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
        observedAborted.push(input.signal?.aborted === true);
        throw input.signal?.reason;
      },
    }),
  };
});

let agent: typeof import("./agent-run");

beforeAll(async () => {
  agent = await import("./agent-run");
}, EDIT_AGENT_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
  observedAborted.length = 0;
  mode = "hang";
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function newProject() {
  const { createEditProject } = await import("./projects");
  const { getTenant } = await import("../tenant");
  const tenant = await getTenant();
  const doc = await createEditProject(tenant, { name: "Cancel", aspect: "16:9", fps: 30 });
  return { tenant, projectId: doc.id };
}

async function drain(events: AsyncIterable<string>): Promise<string[]> {
  const frames: string[] = [];
  for await (const frame of events) {
    frames.push(frame);
  }
  return frames;
}

describe("the Edit agent and a turn that nobody is waiting for", () => {
  it("hands the runtime the request's signal, and the runtime sees it fire", async () => {
    const { tenant, projectId } = await newProject();
    const client = new AbortController();
    const events = await agent.runEditAgent({ tenant, projectId, text: "Add a clip", abortSignal: client.signal });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0]?.signal).toBe(client.signal);
    expect(executed[0]?.signal?.aborted).toBe(false);

    client.abort(new Error("client left"));
    const frames = await drain(events);

    expect(observedAborted).toEqual([true]);
    // The turn they cancelled is not an Edit failure to report, and the stream still closes.
    expect(frames.some((frame) => frame.includes("run.failed"))).toBe(false);
    expect(executed).toHaveLength(1);
  }, 60_000);

  it("still reports a turn that broke when nobody cancelled it", async () => {
    mode = "fail";
    const { tenant, projectId } = await newProject();
    const events = await agent.runEditAgent({ tenant, projectId, text: "Add a clip" });
    const frames = await drain(events);

    expect(frames.some((frame) => frame.includes("run.failed"))).toBe(true);
    expect(executed[0]).not.toHaveProperty("signal");
  }, 60_000);
});
