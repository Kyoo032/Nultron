import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, InputModality, TenantContext } from "@agentforge/core";
import { GATEWAY_PROVIDER_ID } from "@agentforge/core";
import { MODEL_TIERS, TIER_DEFINITIONS, type ModelTierId } from "@agentforge/core/tiers";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { SelectableModel } from "./selectable-models";
import type { HostRequest, HostResult } from "./types";

/**
 * A Chat turn that chose a tier and whose model cannot be reached before it said a word moves once to
 * the next live model of the same tier, and the failed model goes on this tenant's breaker (model tiers
 * spec, section 3, "Chat gains fallback"). It never moves to another tier, and the screen is never told
 * a model name. The runtime is scripted, so what is read is the host's own decision.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-tier-fallback-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "f".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
let script: (input: ExecuteInput, attempt: number) => Promise<void> = async () => undefined;
const state = vi.hoisted(() => ({ catalog: [] as SelectableModel[] }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await script(input, executed.length);
      },
    }),
  };
});

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return { ...actual, listSelectableModels: () => state.catalog };
});

function candidates(tier: ModelTierId): string[] {
  return [...(TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? [])];
}

function row(id: string, inputModalities: InputModality[] = ["text"]): SelectableModel {
  return { id, label: id, provider: "openai", inputModalities, friendlyLabel: id, bestFor: "General chat", tier: "everyday" };
}

const ALL_IDS = [...new Set(MODEL_TIERS.flatMap((tier) => candidates(tier)))];

function unreachable(model: string): string {
  return `Could not reach ${model}: the gateway answered 503 (supply pool unavailable).`;
}

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let threadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await dispatch(request(method, path, { body }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

type Frame = { event: string; data: Record<string, unknown>; raw: string };

async function postTurn(tier: ModelTierId): Promise<Frame[]> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content: "hello", tier } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  let raw = "";
  for await (const frame of result.events) {
    raw += frame;
  }
  return raw
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
      return { event, data, raw: block };
    });
}

/** What the real runtime does when a model call fails: say so, then throw the same sentence. */
async function failWith(input: ExecuteInput, message: string): Promise<never> {
  await input.onEvent({ type: "run.failed", message });
  throw new Error(message);
}

async function answer(input: ExecuteInput, text: string): Promise<void> {
  await input.onEvent({ type: "assistant.delta", text });
  await input.onEvent({ type: "run.completed", runId: input.runId });
}

/** The head fails as unreachable; every later attempt answers. */
function headUnreachable(): (input: ExecuteInput, attempt: number) => Promise<void> {
  return async (input, attempt) => {
    if (attempt === 1) {
      await failWith(input, unreachable(input.version.model));
    }
    await answer(input, "from the same tier");
  };
}

beforeAll(async () => {
  state.catalog = ALL_IDS.map((id) => row(id));
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(async () => {
  executed.length = 0;
  state.catalog = ALL_IDS.map((id) => row(id));
  const { resetJobModelCircuit } = await import("./job-model-fallback");
  resetJobModelCircuit();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a tier run whose model cannot be reached", () => {
  for (const tier of MODEL_TIERS) {
    it(`${tier}: moves once to the next model of the same tier, at the tier's Thinking level`, async () => {
      script = headUnreachable();
      const frames = await postTurn(tier);
      const [head, second] = candidates(tier);
      expect(executed.map((run) => run.version.model)).toEqual([head, second]);
      expect(executed[1]?.reasoningEffort).toBe(executed[0]?.reasoningEffort);
      expect(executed[1]?.reasoningEffortExplicit).toBe(executed[0]?.reasoningEffortExplicit);
      expect(frames.some((frame) => frame.event === "run.failed")).toBe(false);
      expect(frames.filter((frame) => frame.event === "run.completed")).toHaveLength(1);
    });
  }

  it("tells the screen another model of the same choice answered, and names no model", async () => {
    script = headUnreachable();
    const frames = await postTurn("reasoning");
    const notice = frames.find((frame) => frame.event === "run.model_fallback");
    expect(notice).toBeDefined();
    expect(notice?.data.from).toBeUndefined();
    expect(notice?.data.to).toBeUndefined();
    expect(String(notice?.data.message)).toMatch(/same choice/);
    // No frame of the turn, Thinking included, carries a candidate's id.
    for (const frame of frames) {
      for (const id of ALL_IDS) {
        expect(frame.raw.toLowerCase(), `${frame.event} leaks ${id}`).not.toContain(id.toLowerCase());
      }
    }
  });

  it("puts the failed model on this tenant's breaker, so the next turn starts on the next model", async () => {
    script = headUnreachable();
    await postTurn("reasoning");
    const { isJobModelDown } = await import("./job-model-fallback");
    const [head, second] = candidates("reasoning");
    expect(isJobModelDown(head as string, Date.now(), tenant)).toBe(true);
    executed.length = 0;
    script = async (input) => answer(input, "second turn");
    await postTurn("reasoning");
    expect(executed.map((run) => run.version.model)).toEqual([second]);
  });

  it("moves at most once: when the next model fails too, that failure is the answer", async () => {
    script = async (input) => failWith(input, unreachable(input.version.model));
    const frames = await postTurn("fast");
    expect(executed.map((run) => run.version.model)).toEqual(candidates("fast").slice(0, 2));
    expect(frames.filter((frame) => frame.event === "run.failed")).toHaveLength(1);
  });

  it("does not move on a failure a second model would hit the same way (a bad key)", async () => {
    script = async (input) => failWith(input, "Incorrect API key provided (401).");
    const frames = await postTurn("daily");
    expect(executed).toHaveLength(1);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(true);
    expect(frames.some((frame) => frame.event === "run.model_fallback")).toBe(false);
  });

  it("does not move once the model has spoken", async () => {
    script = async (input) => {
      await input.onEvent({ type: "assistant.delta", text: "half an answer" });
      await failWith(input, unreachable(input.version.model));
    };
    await postTurn("daily");
    expect(executed).toHaveLength(1);
  });

  it("never moves to another tier: Reasoning with nothing else live fails rather than run a fast model", async () => {
    const [head] = candidates("reasoning");
    state.catalog = [head as string, ...candidates("fast"), ...candidates("daily")]
      .filter((id, index, all) => all.indexOf(id) === index)
      .map((id) => row(id));
    script = headUnreachable();
    const frames = await postTurn("reasoning");
    expect(executed.map((run) => run.version.model)).toEqual([head]);
    expect(frames.some((frame) => frame.event === "run.failed")).toBe(true);
  });
});
