import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessSpecFor, type AgentRuntime, type OutboundGuard } from "@agentforge/core";
import { EDIT_AGENT_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

/**
 * The live Edit agent runs under the budget the Edit harness spec declares, not the runtime's own
 * default. The runtime is the one stand-in: it records what it was handed and finishes.
 */
const dataDir = mkdtempSync(join(tmpdir(), "agentforge-edit-agent-budget-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "ai";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
const guardSeen: Array<OutboundGuard | undefined> = [];

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        guardSeen.push(actual.currentOutboundGuard());
        await input.onEvent({ type: "run.completed", runId: input.runId });
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
  guardSeen.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the Edit agent and its run budget", () => {
  it("hands the runtime the budget the Edit spec declares", async () => {
    const { createEditProject } = await import("./projects");
    const { getTenant } = await import("../tenant");
    const tenant = await getTenant();
    const doc = await createEditProject(tenant, { name: "Budget", aspect: "16:9", fps: 30 });

    const events = await agent.runEditAgent({ tenant, projectId: doc.id, text: "Add a clip" });
    for await (const _frame of events) {
      // Drain the stream: the turn only finishes once its frames have been read.
    }

    expect(executed).toHaveLength(1);
    expect(executed[0]?.budget).toBe(harnessSpecFor("edit").budget);
  }, 60_000);
});

describe("the Edit agent and the outbound guard (review H3, 2026-10-13)", () => {
  it("runs inside a guard that holds the project as private and the request as the person's", async () => {
    const { createEditProject } = await import("./projects");
    const { getTenant } = await import("../tenant");
    const tenant = await getTenant();
    const doc = await createEditProject(tenant, { name: "Quarterly board review cut", aspect: "16:9", fps: 30 });

    const events = await agent.runEditAgent({ tenant, projectId: doc.id, text: "Add a clip about rainforest birds" });
    for await (const _frame of events) {
      // Drain the stream: the turn only finishes once its frames have been read.
    }

    const guard = guardSeen[0];
    expect(guard).toBeDefined();
    expect(guard?.isTainted()).toBe(true);
    expect(guard?.judgeQuery("rainforest birds stock footage")).toBeNull();
  }, 60_000);
});
